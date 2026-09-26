import {
    KeyPath,
    parsePaths,
    assertJsonc,
    stripKeys,
    mergeBack,
    JsoncFilterParseError
} from './jsoncFilter';
import type { LocalSnapshot } from './localFile';
import { filterFingerprint, hashProjection, SyncBaseline, SyncStateKey } from './syncState';
import type { FetchedRecord, Profile, SyncDirection } from './types';

// Local mtime (OS clock) and remote update_time (DB server clock) can drift.
// Treat any gap smaller than this as ambiguous and warn the user to verify direction.
export const AMBIGUOUS_TIMESTAMP_GAP_MS = 5_000;

export interface DirectionSuggestion {
    direction: SyncDirection;
    reason: string;
    ambiguous: boolean;
}

/**
 * - `missing-both`: neither side exists; nothing to do.
 * - `parse-error`: excludeKeys is active and an existing side is not JSONC.
 * - `identical`: both sides match (after stripping excluded keys).
 * - `pending`: a sync is needed; see `suggestion` for the proposed direction.
 */
export type PlanStatus = 'missing-both' | 'parse-error' | 'identical' | 'pending';

/**
 * Which side changed since the last successful sync on this machine.
 * - `none`: identical now.
 * - `local` / `remote` / `both`: judged against a usable baseline.
 * - `unknown`: no usable baseline (never synced here, excludeKeys changed
 *   since, a side is missing, or a side doesn't parse) — direction falls back
 *   to the timestamp heuristic.
 */
export type ChangeKind = 'none' | 'local' | 'remote' | 'both' | 'unknown';

/** Raw originals plus the key filter — everything needed to finalize a candidate. */
export interface MergeContext {
    /** Raw (unstripped) local content — input to mergeBack. */
    localOriginal: string;
    /** Raw (unstripped) remote content — input to mergeBack. */
    remoteOriginal: string;
    excludeKeys: KeyPath[];
}

export interface SyncPlan extends MergeContext {
    profile: Profile;
    localExists: boolean;
    remoteExists: boolean;
    /** Stripped local content when excludeKeys is non-empty (and parsing succeeded), otherwise === localOriginal. */
    localContent: string;
    /** Stripped remote content when excludeKeys is non-empty (and parsing succeeded), otherwise === remoteOriginal. */
    remoteContent: string;
    localMtime: Date | null;
    remoteUpdateTime: Date | null;
    /** The fetched remote version token — the expectation for a conditional write. */
    remoteVersion: string | null;
    status: PlanStatus;
    change: ChangeKind;
    suggestion: DirectionSuggestion;
    parseError?: JsoncFilterParseError;
}

/**
 * Compare one profile's local snapshot against its remote record and decide
 * what (if anything) a sync should do. With a baseline from this machine's
 * last sync, each side is judged against it rather than against the other
 * side's clock. Pure: performs no IO.
 */
export function planSync(
    profile: Profile,
    local: LocalSnapshot,
    remote: FetchedRecord,
    baseline?: SyncBaseline
): SyncPlan {
    const localExists = local.exists;
    const remoteExists = remote.data !== null;
    const localOriginal = local.content;
    const remoteOriginal = remote.data ?? '';
    const excludeKeys = parsePaths(Array.isArray(profile.excludeKeys) ? profile.excludeKeys : []);

    let localContent = localOriginal;
    let remoteContent = remoteOriginal;
    let parseError: JsoncFilterParseError | undefined;
    if (excludeKeys.length > 0) {
        try {
            if (localExists) assertJsonc(localOriginal, 'local');
            if (remoteExists) assertJsonc(remoteOriginal, 'remote');
            if (localExists) localContent = stripKeys(localOriginal, excludeKeys);
            if (remoteExists) remoteContent = stripKeys(remoteOriginal, excludeKeys);
        } catch (e) {
            if (!(e instanceof JsoncFilterParseError)) throw e;
            parseError = e;
        }
    }

    let status: PlanStatus;
    if (!localExists && !remoteExists) {
        status = 'missing-both';
    } else if (parseError) {
        status = 'parse-error';
    } else if (localExists && remoteExists && localContent === remoteContent) {
        status = 'identical';
    } else {
        status = 'pending';
    }

    const timestampSuggestion = decideSyncDirection(localExists, remoteExists, local.mtime, remote.updateTime);

    let change: ChangeKind = 'unknown';
    let suggestion = timestampSuggestion;
    const bothExist = status === 'pending' && localExists && remoteExists;
    const baselineUsable = baseline !== undefined && baseline.filterFingerprint === filterFingerprint(excludeKeys);
    if (status === 'identical') {
        change = 'none';
    } else if (bothExist && baselineUsable) {
        const localChanged = hashProjection(localContent) !== baseline.baseHash;
        const remoteChanged = hashProjection(remoteContent) !== baseline.baseHash;
        // Content differs, so at least one side must differ from the base.
        change = localChanged && remoteChanged ? 'both' : localChanged ? 'local' : 'remote';
        const since = `since last sync (${baseline.syncedAt})`;
        if (change === 'local') {
            suggestion = { direction: 'upload', reason: `only local changed ${since}`, ambiguous: false };
        } else if (change === 'remote') {
            suggestion = { direction: 'download', reason: `only remote changed ${since}`, ambiguous: false };
        } else {
            suggestion = {
                direction: timestampSuggestion.direction,
                reason: `both local and remote changed ${since}`,
                ambiguous: true
            };
        }
    } else if (bothExist) {
        const why = baseline ? 'excludeKeys changed since last sync' : 'no sync history';
        suggestion = { ...timestampSuggestion, reason: `${why}; ${timestampSuggestion.reason}` };
    }

    return {
        profile,
        localExists,
        remoteExists,
        localOriginal,
        remoteOriginal,
        localContent,
        remoteContent,
        localMtime: local.mtime,
        remoteUpdateTime: remote.updateTime,
        remoteVersion: remote.version,
        excludeKeys,
        status,
        change,
        suggestion,
        parseError
    };
}

/**
 * The baseline to record after this plan is resolved: `remoteRawAfter` is the
 * remote row's raw content once the sync is done (the final bytes on upload;
 * `plan.remoteOriginal` on download or when refreshing an identical plan).
 * Hashing the remote side means destination-side edits made during a
 * download show up as a local change next time. See spec Part 1.
 */
export function baselineAfterSync(
    plan: Pick<SyncPlan, 'excludeKeys'>,
    key: SyncStateKey,
    remoteRawAfter: string,
    remoteVersion: string | null,
    syncedAt: Date
): SyncBaseline {
    const projection = plan.excludeKeys.length > 0 ? stripKeys(remoteRawAfter, plan.excludeKeys) : remoteRawAfter;
    return {
        tableName: key.tableName,
        id: key.id,
        localPath: key.localPath,
        baseHash: hashProjection(projection),
        filterFingerprint: filterFingerprint(plan.excludeKeys),
        remoteVersion,
        syncedAt: syncedAt.toISOString()
    };
}

/** The (stripped) content that would overwrite the destination for `direction`. */
export function candidateFor(
    plan: Pick<SyncPlan, 'localContent' | 'remoteContent'>,
    direction: SyncDirection
): string {
    return direction === 'download' ? plan.remoteContent : plan.localContent;
}

/**
 * Turn a (possibly user-edited) stripped candidate into the final bytes to
 * persist: excluded keys are reset to the destination side's original values.
 * No-op without excludeKeys. May throw JsoncFilterMergeError.
 */
export function finalizeCandidate(
    candidate: string,
    direction: SyncDirection,
    ctx: MergeContext
): string {
    if (ctx.excludeKeys.length === 0) return candidate;
    const destinationOriginal = direction === 'download' ? ctx.localOriginal : ctx.remoteOriginal;
    return mergeBack(candidate, destinationOriginal, ctx.excludeKeys);
}

export function decideSyncDirection(
    localExists: boolean,
    remoteExists: boolean,
    localMtime: Date | null,
    remoteUpdateTime: Date | null
): DirectionSuggestion {
    if (!localExists) {
        return { direction: 'download', reason: 'no local file yet', ambiguous: false };
    }
    if (!remoteExists) {
        return { direction: 'upload', reason: 'no remote record yet', ambiguous: false };
    }
    if (!remoteUpdateTime && localMtime) {
        return { direction: 'upload', reason: 'remote has no update_time', ambiguous: true };
    }
    if (!localMtime && remoteUpdateTime) {
        return { direction: 'download', reason: 'local has no mtime', ambiguous: true };
    }
    if (!localMtime && !remoteUpdateTime) {
        return {
            direction: 'upload',
            reason: 'neither side has a timestamp; defaulting to upload',
            ambiguous: true
        };
    }

    const localTime = localMtime!.getTime();
    const remoteTime = remoteUpdateTime!.getTime();
    const ambiguous = Math.abs(remoteTime - localTime) < AMBIGUOUS_TIMESTAMP_GAP_MS;

    if (remoteTime > localTime) {
        return {
            direction: 'download',
            reason: `remote is newer (${remoteUpdateTime!.toISOString()} > local ${localMtime!.toISOString()})`,
            ambiguous
        };
    }
    return {
        direction: 'upload',
        reason: `local is newer (${localMtime!.toISOString()} ≥ remote ${remoteUpdateTime!.toISOString()})`,
        ambiguous
    };
}

/**
 * Compute added/removed line counts for a proposed overwrite using LCS.
 * For `direction=download`, the local file is being replaced by remote
 * content, so +added = lines in remote absent from local. For `upload`,
 * the remote record is being replaced by local content, so the signs flip.
 */
export function computeDiffStats(
    localContent: string,
    remoteContent: string,
    direction: SyncDirection
): { added: number; removed: number } {
    const localLines = splitLines(localContent);
    const remoteLines = splitLines(remoteContent);

    // Skip LCS for very large files — fall back to crude counts.
    const MAX_LCS_PRODUCT = 4_000_000;
    let lcs: number;
    if (localLines.length * remoteLines.length > MAX_LCS_PRODUCT) {
        const localSet = new Set(localLines);
        lcs = remoteLines.filter((line) => localSet.has(line)).length;
        lcs = Math.min(lcs, localLines.length, remoteLines.length);
    } else {
        lcs = lcsLength(localLines, remoteLines);
    }

    const localOnly = localLines.length - lcs;
    const remoteOnly = remoteLines.length - lcs;

    if (direction === 'download') {
        // Local is being overwritten with remote.
        return { added: remoteOnly, removed: localOnly };
    } else {
        // Remote is being overwritten with local.
        return { added: localOnly, removed: remoteOnly };
    }
}

function splitLines(content: string): string[] {
    if (content === '') return [];
    return content.split(/\r?\n/);
}

function lcsLength(a: string[], b: string[]): number {
    const m = a.length;
    const n = b.length;
    if (m === 0 || n === 0) return 0;
    let prev = new Int32Array(n + 1);
    let curr = new Int32Array(n + 1);
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (a[i - 1] === b[j - 1]) {
                curr[j] = prev[j - 1] + 1;
            } else {
                curr[j] = prev[j] > curr[j - 1] ? prev[j] : curr[j - 1];
            }
        }
        const tmp = prev;
        prev = curr;
        curr = tmp;
        curr.fill(0);
    }
    return prev[n];
}
