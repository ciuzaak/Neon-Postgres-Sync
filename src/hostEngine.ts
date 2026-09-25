import * as vscode from 'vscode';
import { ConfigManager } from './config';
import { DatabaseService } from './db';
import { SyncEngine } from './core/engine';
import { resolveProfilePath } from './core/localFile';
import { SyncStateStore } from './core/syncState';

/** Relative profile paths anchor to the first workspace folder, if any. */
export function resolveWorkspacePath(filePath: string): string {
    return resolveProfilePath(filePath, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
}

/**
 * A SyncEngine wired to this host: the configured connection (prompting and
 * throwing if none is set) and baselines under globalStorage.
 */
export async function createSyncEngine(): Promise<SyncEngine> {
    const store = await DatabaseService.getRecordStore();
    const stateDir = ConfigManager.getSyncStateDir();
    if (!stateDir) {
        throw new Error('Extension not initialized correctly.');
    }
    return new SyncEngine({ store, state: new SyncStateStore(stateDir), resolvePath: resolveWorkspacePath });
}
