import * as fs from 'fs';
import * as path from 'path';
import type { ConfigFile, Profile } from './types';

export const CONFIG_FILENAME = 'neon-sync.json';

export class ConfigFileParseError extends Error {
    constructor(public readonly filePath: string, public readonly cause: unknown) {
        super(`Failed to parse ${path.basename(filePath)}: ${cause}`);
        this.name = 'ConfigFileParseError';
    }
}

/**
 * Reads and writes `neon-sync.json` at a caller-chosen location. Host-agnostic:
 * the VS Code extension points it at globalStorage; other front-ends can point
 * it anywhere. Secrets never live here (only a legacy field that callers
 * migrate out via `removeConnectionString`).
 */
export class ConfigFileStore {
    constructor(public readonly filePath: string) {}

    exists(): boolean {
        return fs.existsSync(this.filePath);
    }

    /** Returns undefined when the file does not exist; throws ConfigFileParseError on bad JSON. */
    read(): ConfigFile | undefined {
        if (!this.exists()) {
            return undefined;
        }
        const content = fs.readFileSync(this.filePath, 'utf-8');
        try {
            return JSON.parse(content);
        } catch (e) {
            throw new ConfigFileParseError(this.filePath, e);
        }
    }

    /**
     * Replaces the profile list, keeping other top-level fields from `base`.
     * `base` defaults to the current file; callers that already handled a
     * parse error (and chose to overwrite) pass their own.
     */
    saveProfiles(profiles: Profile[], base: ConfigFile = this.read() ?? { profiles: [] }): void {
        this.write({ ...base, profiles: profiles.map(normalizeProfileForWrite) });
    }

    /** Drops the legacy plaintext `connectionString` field if present. */
    removeConnectionString(): void {
        const config = this.read();
        if (config && config.connectionString) {
            delete config.connectionString;
            this.write(config);
        }
    }

    /** Creates the file with `initial` if missing. Returns true when it was created. */
    ensureExists(initial: ConfigFile): boolean {
        if (this.exists()) {
            return false;
        }
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        fs.writeFileSync(this.filePath, JSON.stringify(initial, null, 2));
        return true;
    }

    private write(config: ConfigFile): void {
        atomicWriteJson(this.filePath, config);
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
