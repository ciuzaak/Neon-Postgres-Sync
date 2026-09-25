import test = require('node:test');
import assert = require('node:assert/strict');
import * as path from 'node:path';
import { installModuleMocks, purgeProjectModules, resetMocks } from './helpers/moduleMocks';

installModuleMocks();

function loadSyncModule() {
    purgeProjectModules();
    return require('../src/sync') as typeof import('../src/sync');
}

test('resolvePath preserves absolute paths and anchors relative paths to the workspace root', () => {
    const { vscode } = resetMocks();
    const workspaceRoot = path.join(path.sep, 'tmp', 'workspace');
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: workspaceRoot } }];
    const { SyncManager } = loadSyncModule();

    assert.equal(SyncManager.resolvePath('/var/data/file.json'), '/var/data/file.json');
    assert.equal(SyncManager.resolvePath('nested/file.json'), path.join(workspaceRoot, 'nested/file.json'));
});
