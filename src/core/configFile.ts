import * as fs from 'fs';
import * as path from 'path';
import { writeFileAtomic } from './localFile';
import type { ConfigFile, Profile } from './types';

export const CONFIG_FILENAME = 'neon-sync.json';

/** The config file exists but could not be read or parsed. */
export class ConfigFileReadError extends Error {
    constructor(public readonly filePath: string, public readonly cause: unknown) {
        super(`Failed to parse ${path.basename(filePath)}: ${cause}`);
        this.name = 'ConfigFileReadError';
    }
}

/** Another writer held the config lock for too long. */
export class ConfigLockedError extends Error {
    constructor(public readonly lockPath: string) {
        super(`${path.basename(lockPath)} is held by another process; try again (delete ${lockPath} if no sync is running).`);
        this.name = 'ConfigLockedError';
    }
}

const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 5_000;
const OWNER_FILE = 'owner';

function sleepSync(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Age of a path in ms, or undefined if it doesn't exist (anymore). */
function ageOf(p: string): number | undefined {
    try {
        return Date.now() - fs.statSync(p).mtimeMs;
    } catch {
        return undefined;
    }
}

/**
 * Run `fn` holding `<file>.lock`, a directory (mkdir is atomic everywhere)
 * holding a random owner token.
 *
 * - A lock older than LOCK_STALE_MS is presumed abandoned by a crashed
 *   writer. Taking it over happens under a second mutex (`<lock>.takeover`)
 *   and re-checks staleness inside it, so two waiters can't both remove the
 *   stale lock and then remove each other's fresh one.
 * - Release removes the lock only while it still holds our token.
 * - Locks are removed recursively (a Finder `.DS_Store` inside one, or a
 *   plain file in its place, must not wedge every writer).
 * - Every retry sleeps and checks the deadline: waiting is bounded.
 */
function withLock<T>(filePath: string, waitMs: number, fn: (stillOwned: () => boolean) => T): T {
    const lock = `${filePath}.lock`;
    const takeover = `${lock}.takeover`;
    const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const deadline = Date.now() + waitMs;
    for (;;) {
        try {
            fs.mkdirSync(lock);
            try {
                fs.writeFileSync(`${lock}/${OWNER_FILE}`, token);
            } catch (e) {
                fs.rmSync(lock, { recursive: true, force: true });
                throw e;
            }
            break;
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        }

        const age = ageOf(lock);
        if (age !== undefined && age > LOCK_STALE_MS) {
            try {
                fs.mkdirSync(takeover);
                try {
                    const again = ageOf(lock);
                    if (again !== undefined && again > LOCK_STALE_MS) {
                        fs.rmSync(lock, { recursive: true, force: true });
                    }
                } finally {
                    fs.rmSync(takeover, { recursive: true, force: true });
                }
                continue; // retry the mkdir right away
            } catch (e) {
                if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
                // Someone else is taking over; a takeover mutex left by a crash mid-takeover is itself stale.
                const tAge = ageOf(takeover);
                if (tAge !== undefined && tAge > LOCK_STALE_MS) fs.rmSync(takeover, { recursive: true, force: true });
            }
        }

        if (Date.now() > deadline) throw new ConfigLockedError(lock);
        sleepSync(25);
    }
    const stillOwned = () => {
        try {
            return fs.readFileSync(`${lock}/${OWNER_FILE}`, 'utf-8') === token;
        } catch {
            return false;
        }
    };
    try {
        return fn(stillOwned);
    } finally {
        try {
            if (stillOwned()) {
                fs.rmSync(lock, { recursive: true, force: true });
            }
        } catch { /* already gone, or taken over */ }
    }
}

/**
 * Reads and writes `neon-sync.json` at a caller-chosen location. Host-agnostic:
 * both the extension and the CLI point it at the shared config directory
 * (core/paths). Secrets never live here (only a legacy field that callers
 * migrate out via `removeConnectionString`).
 *
 * Every write goes through `update`: it takes the config lock, applies the
 * change to a fresh read — so concurrent writers (two editors, the CLI)
 * merge instead of the last full-list write winning — refuses a corrupt or
 * unreadable file rather than treating it as empty, and writes atomically
 * through symlinks (a config managed by a dotfiles tool stays a link).
 */
export class ConfigFileStore {
    constructor(public readonly filePath: string, private readonly opts: { lockWaitMs?: number } = {}) {}

    exists(): boolean {
        return fs.existsSync(this.filePath);
    }

    /**
     * Returns undefined when the file does not exist; throws ConfigFileReadError
     * when it exists but can't be read (permissions, EISDIR…) or isn't JSON.
     */
    read(): ConfigFile | undefined {
        if (!this.exists()) {
            return undefined;
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
        } catch (e) {
            throw new ConfigFileReadError(this.filePath, e);
        }
        const config = parsed as Partial<ConfigFile> | null;
        if (typeof config !== 'object' || config === null || (config.profiles !== undefined && !Array.isArray(config.profiles))) {
            throw new ConfigFileReadError(this.filePath, new Error('expected an object with a "profiles" array'));
        }
        return { ...config, profiles: config.profiles ?? [] } as ConfigFile;
    }

    /**
     * Apply `mutate` to a fresh read under the config lock and write the
     * result (profiles normalized). A missing file starts as `{ profiles: [] }`;
     * a corrupt one throws ConfigFileReadError and is left untouched. Return
     * undefined from `mutate` to write nothing. Returns what was written.
     *
     * `mutate` runs once without the lock first: if it wants no change,
     * nothing is locked, created or written (so a read-only config directory
     * works for everything that doesn't write). It then runs again on the
     * locked fresh read — it must not depend on having run before.
     */
    update(mutate: (config: ConfigFile) => ConfigFile | undefined): ConfigFile | undefined {
        if (mutate(structuredClone(this.read() ?? { profiles: [] })) === undefined) return undefined;
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
        return withLock(this.filePath, this.opts.lockWaitMs ?? LOCK_WAIT_MS, (stillOwned) => {
            const current = this.read() ?? { profiles: [] };
            const next = mutate(structuredClone(current));
            if (next === undefined) return undefined;
            const written: ConfigFile = { ...next, profiles: next.profiles.map(normalizeProfileForWrite) };
            // A writer stalled past LOCK_STALE_MS (e.g. the machine slept) may
            // have been taken over; its read is stale, so it must not write.
            if (!stillOwned()) throw new ConfigLockedError(`${this.filePath}.lock`);
            writeFileAtomic(this.filePath, JSON.stringify(written, null, 2));
            return written;
        });
    }

    /** Replace the profile list (other top-level fields kept). For edits use update(), which re-reads under the lock. */
    saveProfiles(profiles: Profile[]): void {
        this.update((config) => ({ ...config, profiles }));
    }

    /** Drops the legacy plaintext `connectionString` field if present. */
    removeConnectionString(): void {
        this.update((config) => {
            if (!config.connectionString) return undefined;
            delete config.connectionString;
            return config;
        });
    }

    /**
     * Creates the file with `initial` if missing. Returns true when it was
     * created. An existing file is never read (it may be the corrupt one the
     * user is about to open and fix).
     */
    ensureExists(initial: ConfigFile): boolean {
        if (this.exists()) return false;
        let created = false;
        this.update((config) => {
            created = false; // update may call this twice (dry run, then locked)
            if (this.exists()) return undefined;
            created = true;
            return { ...config, ...initial };
        });
        return created;
    }
}

export function normalizeProfileForWrite(profile: Profile): Profile {
    const cleaned: Profile = {
        name: profile.name,
        filePath: profile.filePath,
        id: profile.id,
        tableName: profile.tableName
    };
    if (Array.isArray(profile.excludeKeys) && profile.excludeKeys.length > 0) {
        cleaned.excludeKeys = [...profile.excludeKeys];
    }
    return cleaned;
}

/**
 * Write JSON to a sibling temp file then rename into place. Prevents
 * leaving the config truncated/empty if the process is killed mid-write.
 */
export function atomicWriteJson(targetPath: string, value: unknown): void {
    const tempPath = `${targetPath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(value, null, 2));
    try {
        fs.renameSync(tempPath, targetPath);
    } catch (error) {
        // Best-effort cleanup; rethrow so callers see the failure.
        try { fs.unlinkSync(tempPath); } catch { /* swallow */ }
        throw error;
    }
}
