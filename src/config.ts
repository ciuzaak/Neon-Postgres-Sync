import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
    CONFIG_FILENAME,
    ConfigFileReadError,
    ConfigFileStore,
    ConfigLockedError,
    normalizeProfileForWrite
} from './core/configFile';
import { resolveProfilePath, samePathKey } from './core/localFile';
import { abbreviateHome, configDir, stateDir } from './core/paths';
import { SYNC_STATE_DIRNAME } from './core/syncState';
import type { ConfigFile, Profile } from './core/types';

export type { ConfigFile, Profile } from './core/types';

/** Where the shared config and machine-local state live (injectable for tests). */
export interface SharedLocations {
    configDir: string;
    stateDir: string;
}

export interface MigrationReport {
    added: string[];
    keptShared: string[];
    skippedSameFile: string[];
    /** Entries missing a name, file, id or table: left in the backup, not copied. */
    skippedInvalid: string[];
    /** Set when the shared file couldn't be written (e.g. read-only, managed elsewhere): nothing was copied. */
    notCopied?: string[];
}

function isWriteDenied(e: unknown): boolean {
    const code = (e as NodeJS.ErrnoException)?.code;
    return code === 'EACCES' || code === 'EPERM' || code === 'EROFS';
}

/** The extension host must never freeze long on the config lock. */
const EXTENSION_LOCK_WAIT_MS = 2_000;

function isCompleteProfile(value: unknown): value is Profile {
    const p = value as Partial<Profile> | null;
    return typeof p === 'object' && p !== null
        && typeof p.name === 'string' && p.name.trim() !== ''
        && typeof p.filePath === 'string' && p.filePath.trim() !== ''
        && typeof p.id === 'string' && p.id.trim() !== ''
        && typeof p.tableName === 'string' && p.tableName.trim() !== '';
}

export class ConfigManager {
    private static readonly SECRET_KEY = 'neonSync.connectionString';
    private static globalStorageUri: vscode.Uri | undefined;
    private static secrets: vscode.SecretStorage | undefined;
    private static locations: SharedLocations | undefined;
    /**
     * Set when migration couldn't complete (e.g. the shared file is corrupt):
     * this session reads this editor's old file, read-only — edits made there
     * would be lost once the shared file is fixed and migration merges.
     */
    private static legacyFallback = false;
    private static readonly connectionStringListeners = new Set<() => void>();

    /**
     * `locations` defaults to the shared per-user config and machine-local
     * state directories (core/paths); tests pass temporary ones.
     */
    static initialize(context: vscode.ExtensionContext, locations?: SharedLocations) {
        this.globalStorageUri = context.globalStorageUri;
        this.secrets = context.secrets;
        this.locations = locations ?? { configDir: configDir(), stateDir: stateDir() };
        this.legacyFallback = false;

        // Ensure global storage directory exists
        if (!fs.existsSync(this.globalStorageUri.fsPath)) {
            fs.mkdirSync(this.globalStorageUri.fsPath, { recursive: true });
        }
    }

    /** Directory for per-machine sync baselines (see core/syncState). */
    static getSyncStateDir(): string | undefined {
        return this.locations && path.join(this.locations.stateDir, SYNC_STATE_DIRNAME);
    }

    /** The shared profiles file, `~`-abbreviated for display. */
    static getConfigPathForDisplay(): string | undefined {
        const store = this.getStore();
        return store && abbreviateHome(store.filePath);
    }

    private static sharedStore(): ConfigFileStore | undefined {
        return this.locations && new ConfigFileStore(
            path.join(this.locations.configDir, CONFIG_FILENAME),
            { lockWaitMs: EXTENSION_LOCK_WAIT_MS }
        );
    }

    private static legacyStore(): ConfigFileStore | undefined {
        return this.globalStorageUri && new ConfigFileStore(
            path.join(this.globalStorageUri.fsPath, CONFIG_FILENAME),
            { lockWaitMs: EXTENSION_LOCK_WAIT_MS }
        );
    }

    private static getStore(): ConfigFileStore | undefined {
        return this.legacyFallback ? this.legacyStore() : this.sharedStore();
    }

    /**
     * One-time move of this editor's profiles (globalStorage) into the shared
     * file (spec: 2026-09-26-cli-design.md, Part 1). Safe to call on every
     * activation: a marker file next to the old config records completion.
     * The old file stays as a backup, minus any legacy plaintext secret.
     */
    static async migrateLegacyConfig(): Promise<MigrationReport | undefined> {
        const legacy = this.legacyStore();
        const shared = this.sharedStore();
        if (!legacy || !shared || !legacy.exists()) return undefined;
        const marker = `${legacy.filePath}.migrated`;
        if (fs.existsSync(marker)) return undefined;

        let old: ConfigFile;
        try {
            old = legacy.read() ?? { profiles: [] };
        } catch (e) {
            if (!(e instanceof ConfigFileReadError)) throw e;
            vscode.window.showErrorMessage(`Neon Sync couldn't migrate this editor's profiles: ${e.message}`);
            return undefined;
        }

        // Secrets first: move a legacy plaintext URL into SecretStorage and
        // strip it from the old file. Only profiles are ever copied.
        if (old.connectionString) {
            if (this.secrets && !(await this.secrets.get(this.SECRET_KEY))) {
                await this.secrets.store(this.SECRET_KEY, old.connectionString);
            }
            legacy.removeConnectionString();
        }

        const report: MigrationReport = { added: [], keptShared: [], skippedSameFile: [], skippedInvalid: [] };
        const incoming = Array.isArray(old.profiles) ? old.profiles : [];
        const complete = incoming.filter(isCompleteProfile);
        const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const fileKey = (p: Profile) => samePathKey(resolveProfilePath(p.filePath, workspace));
        try {
            shared.update((config) => {
                report.added = [];
                report.keptShared = [];
                report.skippedSameFile = [];
                report.skippedInvalid = incoming.flatMap((p, i) => isCompleteProfile(p)
                    ? []
                    : [(typeof (p as Partial<Profile> | null)?.name === 'string' && (p as Profile).name) || `#${i + 1}`]);
                for (const profile of complete) {
                    const sameName = config.profiles.find((p) => p.name === profile.name);
                    if (sameName) {
                        const a = JSON.stringify(normalizeProfileForWrite(sameName));
                        const b = JSON.stringify(normalizeProfileForWrite(profile));
                        if (a !== b) report.keptShared.push(profile.name);
                        continue;
                    }
                    if (config.profiles.some((p) => isCompleteProfile(p) && fileKey(p) === fileKey(profile))) {
                        report.skippedSameFile.push(profile.name);
                        continue;
                    }
                    config.profiles.push(profile);
                    report.added.push(profile.name);
                }
                return report.added.length > 0 || !shared.exists() ? config : undefined;
            });
        } catch (e) {
            if (e instanceof ConfigLockedError) {
                // Busy, not broken: retry next launch. Until then show this
                // editor's own profiles (read-only) if there's no shared file yet.
                if (!shared.exists()) this.legacyFallback = true;
                vscode.window.showWarningMessage(`Neon Sync will move this editor's profiles to the shared config next time: ${e.message}`);
                return undefined;
            }
            if (isWriteDenied(e)) {
                // A read-only shared config (e.g. managed by home-manager) is
                // supported: keep using it, record that nothing was copied,
                // and say so once. The profiles stay in this editor's backup.
                const notCopied = complete.map((p) => p.name).filter((n) => !(shared.read()?.profiles ?? []).some((p) => p.name === n));
                fs.writeFileSync(marker, JSON.stringify({ notCopiedTo: shared.filePath, notCopied, at: new Date().toISOString() }, null, 2));
                if (notCopied.length > 0) {
                    vscode.window.showWarningMessage(
                        `Neon Sync uses ${abbreviateHome(shared.filePath)}, which is read-only here, so these profiles from this editor were not added: ${notCopied.join(', ')}. ` +
                        `They remain in ${legacy.filePath}.`
                    );
                }
                return { ...report, added: [], notCopied };
            }
            this.legacyFallback = true;
            const reason = e instanceof Error ? e.message : String(e);
            vscode.window.showErrorMessage(
                `Neon Sync couldn't move profiles to the shared config ${abbreviateHome(shared.filePath)}: ${reason} ` +
                'Until that is fixed, this editor shows its own profile list (read-only).'
            );
            return undefined;
        }

        fs.writeFileSync(marker, JSON.stringify({
            migratedTo: shared.filePath,
            at: new Date().toISOString(),
            editor: vscode.env?.appName
        }, null, 2));

        if (report.added.length + report.keptShared.length + report.skippedSameFile.length + report.skippedInvalid.length > 0) {
            const parts = [`Neon Sync now keeps profiles in ${abbreviateHome(shared.filePath)}, shared with the neon-sync CLI and your other editors.`];
            if (report.added.length) parts.push(`Added from ${vscode.env?.appName ?? 'this editor'}: ${report.added.join(', ')}.`);
            if (report.keptShared.length) parts.push(`Kept the shared version of: ${report.keptShared.join(', ')}.`);
            if (report.skippedSameFile.length) parts.push(`Skipped (same file as an existing profile): ${report.skippedSameFile.join(', ')}.`);
            if (report.skippedInvalid.length) parts.push(`Skipped (incomplete, left in the old file): ${report.skippedInvalid.join(', ')}.`);
            vscode.window.showInformationMessage(parts.join(' '));
        }
        return report;
    }

    private static readConfig(): ConfigFile | undefined {
        try {
            return this.getStore()?.read();
        } catch (e) {
            if (e instanceof ConfigFileReadError) {
                vscode.window.showErrorMessage(e.message);
                return undefined;
            }
            throw e;
        }
    }

    static getProfiles(): Profile[] {
        const config = this.readConfig();
        return config?.profiles || [];
    }

    static getProfile(name: string): Profile | undefined {
        const profiles = this.getProfiles();
        return profiles.find(p => p.name === name);
    }

    static async getConnectionString(): Promise<string | undefined> {
        // 1. Try SecretStorage
        if (this.secrets) {
            const secret = await this.secrets.get(this.SECRET_KEY);
            if (secret) {
                return secret;
            }
        }

        // 2. Fallback to file (and maybe migrate?)
        const config = this.readConfig();
        if (config?.connectionString) {
            // Auto-migrate to secrets if found in file
            if (this.secrets) {
                await this.secrets.store(this.SECRET_KEY, config.connectionString);
                // Optionally remove from file? Let's keep it simple and just use it.
                // Ideally we should remove it to be secure.
                await this.removeConnectionStringFromFile();
                vscode.window.showInformationMessage('Migrated connection string to secure storage.');
            }
            return config.connectionString;
        }

        return undefined;
    }

    static async setConnectionString(url: string): Promise<void> {
        if (this.secrets) {
            await this.secrets.store(this.SECRET_KEY, url);
            // Ensure it's not in the file
            await this.removeConnectionStringFromFile();
            this.notifyConnectionStringChanged();
        } else {
            vscode.window.showErrorMessage('SecretStorage not initialized.');
        }
    }

    static async clearConnectionString(): Promise<void> {
        if (this.secrets) {
            await this.secrets.delete(this.SECRET_KEY);
        }
        await this.removeConnectionStringFromFile();
        this.notifyConnectionStringChanged();
    }

    static async promptMissingConnectionString(): Promise<void> {
        const choice = await vscode.window.showErrorMessage(
            'PostgreSQL connection string is not configured.',
            'Open Settings'
        );
        if (choice === 'Open Settings') {
            await vscode.commands.executeCommand('neonSync.openSettings', { focus: 'connection' });
        }
    }

    static onConnectionStringChanged(listener: () => void): vscode.Disposable {
        this.connectionStringListeners.add(listener);
        return new vscode.Disposable(() => {
            this.connectionStringListeners.delete(listener);
        });
    }

    private static notifyConnectionStringChanged() {
        for (const listener of this.connectionStringListeners) {
            try {
                listener();
            } catch (error) {
                console.error('Error in connection string change listener:', error);
            }
        }
    }

    /** Best-effort cleanup of the legacy plaintext field; never blocks setting or clearing the secret. */
    private static async removeConnectionStringFromFile() {
        try {
            this.getStore()?.removeConnectionString();
        } catch (e) {
            vscode.window.showErrorMessage(`Couldn't clean up ${CONFIG_FILENAME}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    /**
     * Change the profile list on a fresh read under the config lock (so a
     * concurrent edit from the CLI or another editor isn't clobbered).
     * `mutate` returns the new list, or undefined for no change. A corrupt
     * or locked config is reported and left untouched. Returns the written
     * list, or undefined when nothing was written.
     */
    static updateProfiles(mutate: (profiles: Profile[]) => Profile[] | undefined): Profile[] | undefined {
        const store = this.getStore();
        if (!store) {
            vscode.window.showErrorMessage('Extension not initialized correctly.');
            return undefined;
        }
        if (this.legacyFallback) {
            vscode.window.showErrorMessage(
                `Profiles can't be edited until the shared config ${this.sharedStore() ? abbreviateHome(this.sharedStore()!.filePath) : ''} is fixed (it couldn't be read at startup). Reload the window after fixing it.`
            );
            return undefined;
        }
        try {
            const written = store.update((config) => {
                const next = mutate(config.profiles);
                return next === undefined ? undefined : { ...config, profiles: next };
            });
            return written?.profiles;
        } catch (e) {
            if (!(e instanceof ConfigFileReadError) && !(e instanceof ConfigLockedError)) throw e;
            vscode.window.showErrorMessage(`Couldn't save profiles: ${e.message}`);
            return undefined;
        }
    }

    /** Replace the whole profile list (under the lock; refuses a corrupt file). */
    static async saveProfiles(profiles: Profile[]): Promise<void> {
        this.updateProfiles(() => profiles);
    }

    static async openConfigFile(): Promise<void> {
        // Always the shared file — also when it's the corrupt one to fix.
        const store = this.sharedStore();
        if (!store) {
            vscode.window.showErrorMessage('Extension not initialized correctly.');
            return;
        }

        const created = store.ensureExists({
            profiles: [
                {
                    name: "Example Profile",
                    filePath: "~/example.json",
                    id: "example-id",
                    tableName: "json_records"
                }
            ]
        });
        if (created) {
            vscode.window.showInformationMessage(`Created ${abbreviateHome(store.filePath)}.`);
        }

        // Open the file
        const doc = await vscode.workspace.openTextDocument(store.filePath);
        await vscode.window.showTextDocument(doc);
    }
}
