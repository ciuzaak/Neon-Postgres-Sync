import { RecordStore, StaleRemoteError, WrittenRecord } from './db';
import { JsoncFilterMergeError, stripKeys } from './jsoncFilter';
import { readLocalFile, samePathKey, writeFileAtomic } from './localFile';
import { baselineAfterSync, finalizeCandidate, planSync, SyncPlan } from './plan';
import { SyncStateKey, SyncStateStore } from './syncState';
import type { Profile, SyncDirection } from './types';

export interface SyncEngineDeps {
    store: RecordStore;
    state: SyncStateStore;
    /** Profile filePath → absolute path (the host decides what relative paths anchor to). */
    resolvePath: (filePath: string) => string;
    now?: () => Date;
}

export interface ApplyRequest {
    plan: SyncPlan;
    direction: SyncDirection;
    /**
     * The (possibly user-edited) candidate as shown in the diff — i.e. with
     * excludeKeys stripped. The engine merges each side's own excluded values
     * back in before writing it.
     */
    candidate: string;
}

export type ApplyOutcome =
    /** Both sides written (as needed) and the baseline recorded. */
    | { kind: 'ok'; request: ApplyRequest; remoteVersion: string | null; baselineError?: string }
    /** The remote row changed since `plan` was fetched. Nothing written for this request. */
    | { kind: 'stale-remote'; request: ApplyRequest }
    /**
     * The local file changed since `plan` was read, so it was not written.
     * Usually caught before anything is written; if it changed while the
     * remote write was in flight, `remoteCommitted` says the remote already
     * holds the reviewed content (re-plan: both sides now differ from the
     * baseline, so the next sync asks).
     */
    | { kind: 'stale-local'; request: ApplyRequest; remoteCommitted: boolean }
    /** Another request in the same atomic batch was stale, so this one was not written either. */
    | { kind: 'not-applied'; request: ApplyRequest }
    /** excludeKeys could not be merged back into the candidate. Nothing written. */
    | { kind: 'merge-error'; request: ApplyRequest; error: JsoncFilterMergeError }
    /**
     * The local write failed. For an upload the remote is already committed:
     * `retryPlan` reflects that, so re-applying the same candidate against it
     * skips the remote write (content unchanged) and only redoes the local one.
     */
    | { kind: 'local-write-failed'; request: ApplyRequest; error: string; remoteCommitted: boolean; retryPlan: SyncPlan };

interface Prepared {
    request: ApplyRequest;
    localPath: string;
    /** Final bytes for the local file (merged against the local original). */
    localBytes: string;
    /** Final bytes for the remote row on upload (merged against the remote original). */
    remoteBytes?: string;
    /** What the row holds after this apply, as read back (set once written). */
    remoteStored?: string;
    remoteVersion: string | null;
}

/**
 * Profiles (among `profiles`) whose local files are the same file as
 * another's. Two profiles sharing a file corrupt each other's baselines —
 * syncing one then makes the other's next plan a confident wrong-way upload —
 * so hosts refuse to sync them.
 */
export function profilesSharingLocalFiles(
    profiles: Profile[],
    resolvePath: (filePath: string) => string
): Array<[Profile, Profile]> {
    const seen = new Map<string, Profile>();
    const clashes: Array<[Profile, Profile]> = [];
    for (const profile of profiles) {
        const key = samePathKey(resolvePath(profile.filePath));
        const first = seen.get(key);
        if (first) clashes.push([first, profile]);
        else seen.set(key, profile);
    }
    return clashes;
}

/**
 * Plans and applies syncs for any front-end. Owns the whole persistence
 * pipeline so every host gets the same guarantees (spec Parts 1–3):
 * conditional remote writes, a local-file guard, per-side excludeKeys
 * merging, and baseline bookkeeping.
 */
export class SyncEngine {
    private readonly now: () => Date;

    constructor(private readonly deps: SyncEngineDeps) {
        this.now = deps.now ?? (() => new Date());
    }

    keyFor(profile: Profile): SyncStateKey {
        return { tableName: profile.tableName, id: profile.id, localPath: this.deps.resolvePath(profile.filePath) };
    }

    /**
     * Fetch all remotes in one round trip, read local files, look up
     * baselines and plan each profile. Identical plans refresh their baseline
     * (spec Part 1: bootstraps history for profiles already in sync) — unless
     * another writer recorded a newer one since this plan began, so a slow
     * plan can't overwrite a fresher baseline with an older state.
     */
    async plan(profiles: Profile[]): Promise<SyncPlan[]> {
        const startedAt = this.now();
        const remotes = await this.deps.store.fetchMany(profiles);
        return profiles.map((profile, idx) => {
            const key = this.keyFor(profile);
            const plan = planSync(profile, readLocalFile(key.localPath), remotes[idx], this.deps.state.get(key));
            if (plan.status === 'identical') {
                const current = this.deps.state.get(key);
                if (!current || new Date(current.syncedAt) < startedAt) {
                    this.tryPutBaseline(plan, plan.remoteOriginal, plan.remoteVersion);
                }
            }
            return plan;
        });
    }

    /**
     * Apply requests as one unit:
     * 1. merge each side's excludeKeys back (merge errors fail only that request);
     * 2. local guard — a local file that changed since planning fails that request;
     * 3. all uploads whose remote content actually changes go in ONE atomic
     *    conditional batch; a stale row fails the whole batch (stale rows
     *    `stale-remote`, every other request `not-applied`, nothing written);
     * 4. local writes, best effort per request (skipped when bytes are unchanged);
     * 5. baselines for every request that fully succeeded.
     * Non-stale database errors are thrown: nothing has been written then.
     */
    async apply(requests: ApplyRequest[]): Promise<ApplyOutcome[]> {
        const [clash] = profilesSharingLocalFiles(requests.map((r) => r.plan.profile), this.deps.resolvePath);
        if (clash) {
            throw new Error(`Profiles "${clash[0].name}" and "${clash[1].name}" use the same local file; sync them separately.`);
        }
        const outcomes = new Map<ApplyRequest, ApplyOutcome>();
        const prepared: Prepared[] = [];

        for (const request of requests) {
            const { plan, direction, candidate } = request;
            try {
                prepared.push({
                    request,
                    localPath: this.deps.resolvePath(plan.profile.filePath),
                    localBytes: finalizeCandidate(candidate, 'download', plan),
                    remoteBytes: direction === 'upload' ? finalizeCandidate(candidate, 'upload', plan) : undefined,
                    remoteVersion: plan.remoteVersion
                });
            } catch (e) {
                if (!(e instanceof JsoncFilterMergeError)) throw e;
                outcomes.set(request, { kind: 'merge-error', request, error: e });
            }
        }

        const guarded = prepared.filter((p) => {
            if (this.localUnchanged(p)) return true;
            outcomes.set(p.request, { kind: 'stale-local', request: p.request, remoteCommitted: false });
            return false;
        });

        // Skip the DB only when the row exists and already holds these bytes
        // (e.g. a retry after the remote committed); an absent row must be created.
        const uploads = guarded.filter((p) =>
            p.remoteBytes !== undefined
            && !(p.request.plan.remoteExists && p.remoteBytes === p.request.plan.remoteOriginal));
        if (uploads.length > 0) {
            let written: WrittenRecord[];
            try {
                written = await this.deps.store.conditionalWriteMany(uploads.map((p) => ({
                    profile: p.request.plan.profile,
                    data: p.remoteBytes!,
                    expected: { exists: p.request.plan.remoteExists, version: p.request.plan.remoteVersion }
                })));
            } catch (e) {
                if (!(e instanceof StaleRemoteError)) throw e;
                // An empty list means staleness couldn't be confirmed per row: blame every upload.
                const stale = new Set(e.profiles.length > 0 ? e.profiles : uploads.map((p) => p.request.plan.profile));
                for (const p of guarded) {
                    const kind = stale.has(p.request.plan.profile) ? 'stale-remote' : 'not-applied';
                    outcomes.set(p.request, { kind, request: p.request });
                }
                return requests.map((r) => outcomes.get(r)!);
            }
            uploads.forEach((p, idx) => {
                p.remoteVersion = written[idx].version;
                p.remoteStored = written[idx].data;
            });
        }

        for (const p of guarded) {
            const { plan } = p.request;
            // Baselines come from what the row holds (canonicalized for jsonb), not the bytes sent.
            const remoteAfter = p.remoteStored ?? plan.remoteOriginal;
            const remoteCommitted = p.remoteStored !== undefined;
            // Check again: the remote round trip above leaves time for a save.
            if (!this.localUnchanged(p)) {
                outcomes.set(p.request, { kind: 'stale-local', request: p.request, remoteCommitted });
                continue;
            }
            try {
                if (!(plan.localExists && p.localBytes === plan.localOriginal)) {
                    writeFileAtomic(p.localPath, p.localBytes);
                }
            } catch (e) {
                outcomes.set(p.request, {
                    kind: 'local-write-failed',
                    request: p.request,
                    error: e instanceof Error ? e.message : String(e),
                    remoteCommitted,
                    retryPlan: remoteCommitted ? this.withCommittedRemote(plan, remoteAfter, p.remoteVersion) : plan
                });
                continue;
            }
            const baselineError = this.tryPutBaseline(plan, remoteAfter, p.remoteVersion);
            outcomes.set(p.request, { kind: 'ok', request: p.request, remoteVersion: p.remoteVersion, baselineError });
        }

        return requests.map((r) => outcomes.get(r)!);
    }

    /** The local file still holds exactly what the plan read (or is still absent). */
    private localUnchanged(p: Prepared): boolean {
        const { plan } = p.request;
        const current = readLocalFile(p.localPath);
        return current.exists === plan.localExists && current.content === plan.localOriginal;
    }

    /** The plan as it stands once `remoteBytes` is committed but the local side is not yet written. */
    private withCommittedRemote(plan: SyncPlan, remoteBytes: string, remoteVersion: string | null): SyncPlan {
        return {
            ...plan,
            remoteExists: true,
            remoteOriginal: remoteBytes,
            remoteContent: plan.excludeKeys.length > 0 ? stripKeys(remoteBytes, plan.excludeKeys) : remoteBytes,
            remoteVersion
        };
    }

    /** Baselines are a cache: a failure to record one must not fail the sync. */
    private tryPutBaseline(plan: SyncPlan, remoteRawAfter: string, remoteVersion: string | null): string | undefined {
        try {
            this.deps.state.put(baselineAfterSync(plan, this.keyFor(plan.profile), remoteRawAfter, remoteVersion, this.now()));
            return undefined;
        } catch (e) {
            return e instanceof Error ? e.message : String(e);
        }
    }
}
