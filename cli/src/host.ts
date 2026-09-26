import * as path from 'path';
import { CONFIG_FILENAME, ConfigFileReadError, ConfigFileStore } from '../../src/core/configFile';
import { assertValidTableName } from '../../src/core/db';
import { profilesSharingLocalFiles, SyncEngine } from '../../src/core/engine';
import { realPathOrParent } from '../../src/core/localFile';
import { abbreviateHome, configDir, expandHome, stateDir, wslBoundaryError } from '../../src/core/paths';
import { SYNC_STATE_DIRNAME, SyncStateStore } from '../../src/core/syncState';
import type { Profile } from '../../src/core/types';
import { CliContext, UsageError } from './context';
import { invalidUrlReason, resolveUrl, URL_ENV, UrlSource } from './secrets';

export interface GlobalOptions {
    /** Base directory for relative profile paths (--base). */
    base?: string;
    /** Alternative profiles file (--config). */
    config?: string;
}

/**
 * The CLI's view of configuration: where things live, which profiles exist,
 * how their paths resolve, and which can't be synced from here.
 */
export class Host {
    constructor(private readonly ctx: CliContext, private readonly opts: GlobalOptions = {}) {}

    configPath(): string {
        return this.opts.config
            ? path.resolve(expandHome(this.opts.config, this.ctx.pathEnv))
            : path.join(configDir(this.ctx.pathEnv), CONFIG_FILENAME);
    }

    stateDir(): string {
        return path.join(stateDir(this.ctx.pathEnv), SYNC_STATE_DIRNAME);
    }

    display(p: string): string {
        return abbreviateHome(p, this.ctx.pathEnv);
    }

    configStore(): ConfigFileStore {
        return new ConfigFileStore(this.configPath());
    }

    /** All configured profiles. A corrupt config is a configuration error (exit 2). */
    profiles(): Profile[] {
        try {
            return this.configStore().read()?.profiles ?? [];
        } catch (e) {
            if (e instanceof ConfigFileReadError) throw new UsageError(e.message);
            throw e;
        }
    }

    /**
     * Profiles by name; none given = all. Exact names always match; a unique
     * case-insensitive prefix only when `allowPrefix` (interactive use) —
     * scripts must never hit `env-prod` because `env` was deleted.
     */
    select(names: string[], allowPrefix: boolean): Profile[] {
        const all = this.profiles();
        if (names.length === 0) return all;
        const picked: Profile[] = [];
        for (const name of names) {
            let match = all.find((p) => p.name === name);
            if (!match && allowPrefix) {
                const candidates = all.filter((p) => p.name.toLowerCase().startsWith(name.toLowerCase()));
                if (candidates.length > 1) {
                    throw new UsageError(`"${name}" matches several profiles: ${candidates.map((p) => p.name).join(', ')}`);
                }
                match = candidates[0];
            }
            if (!match) {
                throw new UsageError(`No profile named "${name}"${allowPrefix ? '' : ' (scripts need exact names)'}. See \`neon-sync profile list\`.`);
            }
            if (!picked.includes(match)) picked.push(match);
        }
        return picked;
    }

    /** Absolute path for a profile, or undefined for a relative path without --base. */
    resolve(filePath: string): string | undefined {
        const expanded = expandHome(filePath, this.ctx.pathEnv);
        if (path.isAbsolute(expanded)) return expanded;
        return this.opts.base ? path.resolve(expandHome(this.opts.base, this.ctx.pathEnv), expanded) : undefined;
    }

    /**
     * Why each of `profiles` can't be synced from here (by name): a relative
     * path without --base, a local file shared with any configured profile,
     * or a file across a WSL boundary.
     */
    blockers(profiles: Profile[]): Map<string, { label: string; detail: string }> {
        const out = new Map<string, { label: string; detail: string }>();
        for (const p of profiles) {
            if (this.resolve(p.filePath) === undefined) {
                out.set(p.name, { label: 'relative path', detail: 'use ~/… or an absolute path, or pass --base <dir>' });
            }
        }
        const names = new Set(profiles.map((p) => p.name));
        const resolvable = this.profiles().filter((p) => this.resolve(p.filePath) !== undefined);
        for (const [a, b] of profilesSharingLocalFiles(resolvable, (f) => this.resolve(f)!)) {
            for (const [self, other] of [[a, b], [b, a]]) {
                if (names.has(self.name) && !out.has(self.name)) {
                    out.set(self.name, { label: 'shared file', detail: `same local file as profile "${other.name}" — give each profile its own file` });
                }
            }
        }
        for (const p of profiles) {
            if (out.has(p.name)) continue;
            const wsl = wslBoundaryError(realPathOrParent(this.resolve(p.filePath)!), this.ctx.pathEnv);
            if (wsl) out.set(p.name, { label: 'across WSL', detail: wsl });
        }
        return out;
    }

    private cachedConnection?: Promise<{ url: string; source: UrlSource }>;

    /** The URL and its source; read once per run (a keychain read can prompt on macOS). */
    connection(): Promise<{ url: string; source: UrlSource }> {
        this.cachedConnection ??= (async () => {
            const found = await resolveUrl(this.ctx.env, this.ctx.keychain);
            if (!found) {
                throw new UsageError(`No database URL. Run \`neon-sync config set-url\`, or set ${URL_ENV}.`);
            }
            const invalid = invalidUrlReason(found.url);
            if (invalid) {
                const where = found.source === 'env' ? URL_ENV : 'the stored URL';
                throw new UsageError(`${where} can't be used: ${invalid}. Fix it with \`neon-sync config set-url\`.`);
            }
            return found;
        })();
        return this.cachedConnection;
    }


    /** A SyncEngine for `profiles` (table names validated before connecting). */
    async engine(profiles: Profile[]): Promise<SyncEngine> {
        for (const p of profiles) {
            try {
                assertValidTableName(p.tableName);
            } catch (e) {
                throw new UsageError(`Profile "${p.name}": ${(e as Error).message}`);
            }
        }
        const { url } = await this.connection();
        return new SyncEngine({
            store: this.ctx.createStore(url),
            state: new SyncStateStore(this.stateDir()),
            resolvePath: (filePath) => {
                const resolved = this.resolve(filePath);
                if (!resolved) throw new UsageError(`relative path "${filePath}" needs --base`);
                return resolved;
            }
        });
    }
}
