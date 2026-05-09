import test = require('node:test');
import assert = require('node:assert/strict');
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    createMockWebviewPanel,
    installModuleMocks,
    purgeProjectModules,
    resetMocks,
    type MockWebviewPanel
} from './helpers/moduleMocks';

installModuleMocks();

interface MessageEnvelope {
    command: string;
    [key: string]: unknown;
}

function loadModules() {
    purgeProjectModules();
    const config = require('../src/config') as typeof import('../src/config');
    const settings = require('../src/settingsWebview') as typeof import('../src/settingsWebview');
    return { ...config, ...settings };
}

async function deliver(panel: MockWebviewPanel, message: unknown): Promise<void> {
    for (const listener of panel.webview.listeners) {
        await listener(message);
    }
}

function findReply(panel: MockWebviewPanel, command: string): MessageEnvelope | undefined {
    return panel.webview.postedMessages.find(
        (m): m is MessageEnvelope => typeof m === 'object' && m !== null && (m as MessageEnvelope).command === command
    );
}

function setupPanel() {
    const { vscode } = resetMocks();
    const { ConfigManager, SettingsPanel } = loadModules();
    const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'neon-sync-webview-'));
    const secrets = new Map<string, string>();
    ConfigManager.initialize({
        globalStorageUri: vscode.Uri.file(storagePath),
        secrets: {
            get: async (key: string) => secrets.get(key),
            store: async (key: string, value: string) => { secrets.set(key, value); },
            delete: async (key: string) => { secrets.delete(key); }
        }
    } as never);
    const panel = createMockWebviewPanel();
    vscode.__pendingWebviewPanel = panel;
    SettingsPanel.createOrShow(vscode.Uri.file('/ext') as never);
    return { vscode, ConfigManager, secrets, panel, SettingsPanel };
}

test('saveConnectionString stores the value and replies with connectionStringSaved', async () => {
    const { panel, secrets } = setupPanel();

    await deliver(panel, { command: 'saveConnectionString', url: 'postgres://x' });

    assert.equal(secrets.get('neonSync.connectionString'), 'postgres://x');
    assert.ok(findReply(panel, 'connectionStringSaved'));
});

test('saveConnectionString rejects an empty url with connectionStringError', async () => {
    const { panel, secrets } = setupPanel();

    await deliver(panel, { command: 'saveConnectionString', url: '   ' });

    const reply = findReply(panel, 'connectionStringError');
    assert.ok(reply, 'expected connectionStringError reply');
    assert.equal(reply!.error, 'Connection URL cannot be empty.');
    assert.equal(secrets.has('neonSync.connectionString'), false);
});

test('clearConnectionString removes the secret and replies with empty url', async () => {
    const { panel, secrets } = setupPanel();
    secrets.set('neonSync.connectionString', 'postgres://stored');

    await deliver(panel, { command: 'clearConnectionString' });

    assert.equal(secrets.has('neonSync.connectionString'), false);
    const reply = findReply(panel, 'connectionStringSaved');
    assert.ok(reply);
    assert.equal(reply!.url, '');
});

test('saveProfile validates input on the host and rejects invalid table names', async () => {
    const { panel } = setupPanel();

    await deliver(panel, {
        command: 'saveProfile',
        profile: { name: 'p', filePath: 'p.json', id: '1', tableName: 'bad name' }
    });

    const reply = findReply(panel, 'profileSaveError');
    assert.ok(reply, 'expected profileSaveError reply');
    const errors = reply!.errors as Record<string, string | undefined>;
    assert.notEqual(errors.tableName, undefined);
});

test('saveProfile rejects duplicate names but accepts the original on edit', async () => {
    const { panel, ConfigManager } = setupPanel();
    await ConfigManager.saveProfiles([
        { name: 'a', filePath: 'a.json', id: '1', tableName: 'records' },
        { name: 'b', filePath: 'b.json', id: '2', tableName: 'records' }
    ]);

    // Adding a new "a" must fail.
    await deliver(panel, {
        command: 'saveProfile',
        profile: { name: 'a', filePath: 'c.json', id: '3', tableName: 'records' }
    });
    const errReply = findReply(panel, 'profileSaveError');
    assert.ok(errReply);
    const errs = errReply!.errors as Record<string, string | undefined>;
    assert.notEqual(errs.name, undefined);

    // Editing "a" with the same name should succeed (originalName excludes self).
    panel.webview.postedMessages.length = 0;
    await deliver(panel, {
        command: 'saveProfile',
        profile: { name: 'a', filePath: 'a2.json', id: '1', tableName: 'records' },
        originalName: 'a'
    });
    const okReply = findReply(panel, 'profilesSaved');
    assert.ok(okReply);
    const profiles = okReply!.profiles as Array<{ name: string; filePath: string }>;
    assert.equal(profiles.length, 2);
    assert.equal(profiles.find((p) => p.name === 'a')?.filePath, 'a2.json');
});

test('deleteProfile removes the profile and replies with the new list', async () => {
    const { panel, ConfigManager } = setupPanel();
    await ConfigManager.saveProfiles([
        { name: 'a', filePath: 'a.json', id: '1', tableName: 'records' },
        { name: 'b', filePath: 'b.json', id: '2', tableName: 'records' }
    ]);

    await deliver(panel, { command: 'deleteProfile', name: 'a' });

    const reply = findReply(panel, 'profilesSaved');
    assert.ok(reply);
    const profiles = reply!.profiles as Array<{ name: string }>;
    assert.deepEqual(profiles.map((p) => p.name), ['b']);
});

test('pickFilePath returns workspace-relative path when the choice is inside the workspace', async () => {
    const { vscode, panel } = setupPanel();
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'neon-sync-ws-'));
    const chosen = path.join(workspaceRoot, 'subdir', 'file.json');
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(workspaceRoot) }];
    vscode.window.showOpenDialog = async () => [{ fsPath: chosen }];

    await deliver(panel, { command: 'pickFilePath' });

    const reply = findReply(panel, 'filePathPicked');
    assert.ok(reply);
    assert.equal(reply!.path, path.join('subdir', 'file.json'));
});

test('pickFilePath returns absolute path when the choice is outside the workspace', async () => {
    const { vscode, panel } = setupPanel();
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'neon-sync-ws-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'neon-sync-elsewhere-'));
    const chosen = path.join(outside, 'file.json');
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(workspaceRoot) }];
    vscode.window.showOpenDialog = async () => [{ fsPath: chosen }];

    await deliver(panel, { command: 'pickFilePath' });

    const reply = findReply(panel, 'filePathPicked');
    assert.ok(reply);
    assert.equal(reply!.path, chosen);
});

test('pickFilePath returns null when the user cancels the dialog', async () => {
    const { vscode, panel } = setupPanel();
    vscode.window.showOpenDialog = async () => undefined;

    await deliver(panel, { command: 'pickFilePath' });

    const reply = findReply(panel, 'filePathPicked');
    assert.ok(reply);
    assert.equal(reply!.path, null);
});

test('getSettings replies with loadSettings and re-emits focusField when pending', async () => {
    const { vscode, ConfigManager, panel, SettingsPanel } = setupPanel();
    await ConfigManager.setConnectionString('postgres://stored');

    // Re-open with focus option (uses existing panel — reveals it and re-applies focus).
    SettingsPanel.createOrShow(vscode.Uri.file('/ext') as never, { focus: 'connection' });
    panel.webview.postedMessages.length = 0;

    await deliver(panel, { command: 'getSettings' });

    const load = findReply(panel, 'loadSettings');
    assert.ok(load);
    assert.equal(load!.connectionString, 'postgres://stored');
    const focus = findReply(panel, 'focusField');
    assert.ok(focus);
    assert.equal(focus!.field, 'connection');
});
