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

function sleepSync(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run `fn` holding `<file>.lock` (a directory: mkdir is atomic everywhere).
 * A lock older than LOCK_STALE_MS is presumed abandoned by a crashed writer.
 */
function withLock<T>(filePath: string, waitMs: number, fn: () => T): T {
    const lock = `${filePath}.lock`;
    const deadline = Date.now() + waitMs;
    for (;;) {
        try {
            fs.mkdirSync(lock);
            break;
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        }
        try {
            if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
                fs.rmdirSync(lock);
                continue;
            }
        } catch { /* released meanwhile: retry */ continue; }
        if (Date.now() > deadline) throw new ConfigLockedError(lock);
        sleepSync(25);
    }
    try {
        return fn();
    } finally {
        try { fs.rmdirSync(lock); } catch { /* already gone */ }
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
     */
    update(mutate: (config: ConfigFile) => ConfigFile | undefined): ConfigFile | undefined {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
        return withLock(this.filePath, this.opts.lockWaitMs ?? LOCK_WAIT_MS, () => {
            const current = this.read() ?? { profiles: [] };
            const next = mutate(structuredClone(current));
            if (next === undefined) return undefined;
            const written: ConfigFile = { ...next, profiles: next.profiles.map(normalizeProfileForWrite) };
            writeFileAtomic(this.filePath, JSON.stringify(written, null, 2));
            return written;
        });
    }

    /** Replace the profile list (other top-level fields kept). */
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

    /** Creates the file with `initial` if missing. Returns true when it was created. */
    ensureExists(initial: ConfigFile): boolean {
        let created = false;
        this.update((config) => {
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
