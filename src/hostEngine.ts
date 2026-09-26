import * as vscode from 'vscode';
import { ConfigManager, Profile } from './config';
import { DatabaseService } from './db';
import { assertValidTableName } from './core/db';
import { profilesSharingLocalFiles, SyncEngine } from './core/engine';
import { resolveProfilePath } from './core/localFile';
import { SyncStateStore } from './core/syncState';

/**
 * Profiles among `profiles` that share their local file with any configured
 * profile (they'd corrupt each other's sync history), mapped by name to a
 * message naming both profiles and both paths.
 */
export function sharedFileClashes(profiles: Profile[]): Map<string, string> {
    const names = new Set(profiles.map((p) => p.name));
    const out = new Map<string, string>();
    for (const [a, b] of profilesSharingLocalFiles(ConfigManager.getProfiles(), resolveWorkspacePath)) {
        const message = `Profiles "${a.name}" (${a.filePath}) and "${b.name}" (${b.filePath}) use the same local file. Give each profile its own file.`;
        for (const p of [a, b]) {
            if (names.has(p.name) && !out.has(p.name)) out.set(p.name, message);
        }
    }
    return out;
}

/** Relative profile paths anchor to the first workspace folder, if any. */
export function resolveWorkspacePath(filePath: string): string {
    return resolveProfilePath(filePath, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
}

/**
 * A SyncEngine wired to this host: the configured connection (prompting and
 * throwing if none is set) and baselines under globalStorage. The profiles
 * about to be synced are validated first, so a bad table name fails as such
 * instead of surfacing the missing-connection prompt, and a profile sharing
 * its local file with any configured profile is refused (see
 * profilesSharingLocalFiles).
 */
export async function createSyncEngine(profiles: Profile[]): Promise<SyncEngine> {
    profiles.forEach((p) => assertValidTableName(p.tableName));
    const clashes = sharedFileClashes(profiles);
    if (clashes.size > 0) {
        throw new Error([...clashes.values()][0]);
    }
    const store = await DatabaseService.getRecordStore();
    const stateDir = ConfigManager.getSyncStateDir();
    if (!stateDir) {
        throw new Error('Extension not initialized correctly.');
    }
    return new SyncEngine({ store, state: new SyncStateStore(stateDir), resolvePath: resolveWorkspacePath });
}
