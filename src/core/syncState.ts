import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { atomicWriteJson } from './configFile';
import type { KeyPath } from './jsoncFilter';

/** Directory (next to the config file) holding one JSON file per baseline. */
export const SYNC_STATE_DIRNAME = 'sync-state';
const STATE_FORMAT_VERSION = 1;

/**
 * Identifies one profile's sync history on this machine. Deliberately not the
 * profile name: renaming keeps history, while pointing a profile at another
 * file or record starts fresh.
 */
export interface SyncStateKey {
    tableName: string;
    id: string;
    /** Resolved absolute local path. */
    localPath: string;
}

export interface SyncBaseline extends SyncStateKey {
    /** sha256 of the remote side's projection (excludeKeys stripped) after the sync. */
    baseHash: string;
    /** Fingerprint of the excludeKeys in force when baseHash was taken. */
    filterFingerprint: string;
    /** Remote version token after the sync, if known. */
    remoteVersion: string | null;
    /** ISO timestamp. */
    syncedAt: string;
}

export function hashProjection(projection: string): string {
    return crypto.createHash('sha256').update(projection, 'utf8').digest('hex');
}

/** Order-insensitive: the same set of paths always yields the same fingerprint. */
export function filterFingerprint(excludeKeys: ReadonlyArray<KeyPath>): string {
    const normalized = excludeKeys.map((p) => [...p]).sort((a, b) => {
        const ka = JSON.stringify(a);
        const kb = JSON.stringify(b);
        return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    return hashProjection(JSON.stringify(normalized));
}

/**
 * Same table rule as RecordStore's duplicate check: unqualified and
 * lowercased, since `records` and `public.records` usually name one table.
 * Ids and paths are compared exactly.
 */
function canonicalKey(key: SyncStateKey): string {
    return JSON.stringify([key.tableName.toLowerCase().split('.').pop(), key.id, key.localPath]);
}

function isBaseline(value: unknown): value is SyncBaseline {
    if (typeof value !== 'object' || value === null) return false;
    const v = value as Record<string, unknown>;
    return typeof v.tableName === 'string'
        && typeof v.id === 'string'
        && typeof v.localPath === 'string'
        && typeof v.baseHash === 'string'
        && typeof v.filterFingerprint === 'string'
        && (typeof v.remoteVersion === 'string' || v.remoteVersion === null)
        && typeof v.syncedAt === 'string';
}

type EntryRead =
    | { kind: 'missing' }
    | { kind: 'ok'; entry: SyncBaseline }
    | { kind: 'invalid' }        // corrupt, malformed, or for another key (hash collision)
    | { kind: 'foreign' }        // written by a different format version — leave alone
    | { kind: 'unreadable' };    // IO error other than ENOENT

/**
 * Per-machine sync baselines: one file per key under `dir`, never synced.
 *
 * One file per key means concurrent writers (two VS Code windows, or the
 * extension and a CLI) syncing *different* profiles never touch the same
 * file, and a bad or unreadable file affects only its own profile. Writes are
 * atomic (temp file + rename); concurrent writes for the *same* profile are
 * last-writer-wins, matching two syncs of that profile racing anyway.
 *
 * The state is a cache: a missing, corrupt or unreadable entry reads as "no
 * baseline", which only degrades direction choice to the timestamp heuristic.
 * A corrupt entry is replaced on the next write; an unreadable one (EACCES,
 * EBUSY…) makes that write throw rather than guess; one written by a
 * different format version is never overwritten.
 */
export class SyncStateStore {
    constructor(public readonly dir: string) {}

    get(key: SyncStateKey): SyncBaseline | undefined {
        const read = this.read(key);
        return read.kind === 'ok' ? read.entry : undefined;
    }

    put(entry: SyncBaseline): void {
        const read = this.read(entry);
        if (read.kind === 'foreign') return;
        if (read.kind === 'unreadable') {
            throw new Error(`Sync state for "${entry.id}" is unreadable: ${this.fileFor(entry)}`);
        }
        fs.mkdirSync(this.dir, { recursive: true });
        atomicWriteJson(this.fileFor(entry), { version: STATE_FORMAT_VERSION, entry });
    }

    delete(key: SyncStateKey): void {
        try {
            fs.unlinkSync(this.fileFor(key));
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        }
    }

    private fileFor(key: SyncStateKey): string {
        return path.join(this.dir, `${hashProjection(canonicalKey(key)).slice(0, 32)}.json`);
    }

    private read(key: SyncStateKey): EntryRead {
        let raw: string;
        try {
            raw = fs.readFileSync(this.fileFor(key), 'utf-8');
        } catch (e) {
            return (e as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'missing' } : { kind: 'unreadable' };
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch {
            return { kind: 'invalid' };
        }
        const file = parsed as { version?: unknown; entry?: unknown } | null;
        if (typeof file !== 'object' || file === null) return { kind: 'invalid' };
        if (file.version !== STATE_FORMAT_VERSION) {
            return file.version === undefined ? { kind: 'invalid' } : { kind: 'foreign' };
        }
        if (!isBaseline(file.entry) || canonicalKey(file.entry) !== canonicalKey(key)) {
            return { kind: 'invalid' };
        }
        return { kind: 'ok', entry: file.entry };
    }
}
