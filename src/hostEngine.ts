import * as vscode from 'vscode';
import { ConfigManager, Profile } from './config';
import { DatabaseService } from './db';
import { assertValidTableName } from './core/db';
import { profilesSharingLocalFiles, SyncEngine } from './core/engine';
import { resolveProfilePath } from './core/localFile';
import { SyncStateStore } from './core/syncState';

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
    const names = new Set(profiles.map((p) => p.name));
    const clash = profilesSharingLocalFiles(ConfigManager.getProfiles(), resolveWorkspacePath)
        .find(([a, b]) => names.has(a.name) || names.has(b.name));
    if (clash) {
        throw new Error(
            `Profiles "${clash[0].name}" and "${clash[1].name}" use the same local file (${clash[1].filePath}). Give each profile its own file.`
        );
    }
    const store = await DatabaseService.getRecordStore();
    const stateDir = ConfigManager.getSyncStateDir();
    if (!stateDir) {
        throw new Error('Extension not initialized correctly.');
    }
    return new SyncEngine({ store, state: new SyncStateStore(stateDir), resolvePath: resolveWorkspacePath });
}
