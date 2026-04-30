import test = require('node:test');
import assert = require('node:assert/strict');
import * as path from 'node:path';
import { installModuleMocks, purgeProjectModules, resetMocks } from './helpers/moduleMocks';

installModuleMocks();

function loadSyncModule() {
    purgeProjectModules();
    return require('../src/sync') as typeof import('../src/sync');
}

test('decideSyncDirection downloads when the local file is missing', () => {
    resetMocks();
    const { SyncManager } = loadSyncModule();

    const result = SyncManager.decideSyncDirection(false, true, null, new Date('2026-01-01T00:00:00Z'));

    assert.equal(result.direction, 'download');
    assert.equal(result.ambiguous, false);
    assert.equal(result.reason, 'no local file yet');
});

test('decideSyncDirection uploads when the remote row is missing', () => {
    resetMocks();
    const { SyncManager } = loadSyncModule();

    const result = SyncManager.decideSyncDirection(true, false, new Date('2026-01-01T00:00:00Z'), null);

    assert.equal(result.direction, 'upload');
    assert.equal(result.ambiguous, false);
    assert.equal(result.reason, 'no remote record yet');
});

test('decideSyncDirection chooses the newer remote timestamp outside the ambiguity window', () => {
    resetMocks();
    const { SyncManager } = loadSyncModule();

    const result = SyncManager.decideSyncDirection(
        true,
        true,
        new Date('2026-01-01T00:00:00.000Z'),
        new Date('2026-01-01T00:00:10.000Z')
    );

    assert.equal(result.direction, 'download');
    assert.equal(result.ambiguous, false);
    assert.match(result.reason, /remote is newer/);
});

test('decideSyncDirection marks close timestamps as ambiguous', () => {
    resetMocks();
    const { SyncManager } = loadSyncModule();

    const result = SyncManager.decideSyncDirection(
        true,
        true,
        new Date('2026-01-01T00:00:00.000Z'),
        new Date('2026-01-01T00:00:04.999Z')
    );

    assert.equal(result.direction, 'download');
    assert.equal(result.ambiguous, true);
});

test('resolvePath preserves absolute paths and anchors relative paths to the workspace root', () => {
    const { vscode } = resetMocks();
    const workspaceRoot = path.join(path.sep, 'tmp', 'workspace');
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: workspaceRoot } }];
    const { SyncManager } = loadSyncModule();

    assert.equal(SyncManager.resolvePath('/var/data/file.json'), '/var/data/file.json');
    assert.equal(SyncManager.resolvePath('nested/file.json'), path.join(workspaceRoot, 'nested/file.json'));
});
