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
import { PROFILE_TABLENAME_REGEX_SOURCE } from '../src/profileValidation';

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
    assert.deepEqual(findReply(panel, 'connectionStringSaved'), { command: 'connectionStringSaved' });
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

test('createOrShow with focus posts focusField immediately when settings are already loaded', async () => {
    const { vscode, panel, SettingsPanel } = setupPanel();
    // Mark the panel as loaded by delivering an initial getSettings.
    await deliver(panel, { command: 'getSettings' });
    panel.webview.postedMessages.length = 0;

    SettingsPanel.createOrShow(vscode.Uri.file('/ext') as never, { focus: 'connection' });

    assert.deepEqual(findReply(panel, 'focusField'), { command: 'focusField', field: 'connection' });
});

test('createOrShow with focus before loadSettings does not post focusField immediately', async () => {
    const { vscode, panel, SettingsPanel } = setupPanel();
    panel.webview.postedMessages.length = 0;

    // Settings have not been loaded yet (no getSettings delivered). The host
    // must defer the focus message rather than racing the script's listener.
    SettingsPanel.createOrShow(vscode.Uri.file('/ext') as never, { focus: 'connection' });

    assert.equal(findReply(panel, 'focusField'), undefined);

    // Once loadSettings completes, the deferred focus is emitted exactly once.
    await deliver(panel, { command: 'getSettings' });
    const focusReplies = panel.webview.postedMessages.filter(
        (m): m is MessageEnvelope => typeof m === 'object' && m !== null && (m as MessageEnvelope).command === 'focusField'
    );
    assert.equal(focusReplies.length, 1);
});

test('saveProfile rejects renaming to a name that collides with another profile', async () => {
    const { panel, ConfigManager } = setupPanel();
    await ConfigManager.saveProfiles([
        { name: 'a', filePath: 'a.json', id: '1', tableName: 'records' },
        { name: 'b', filePath: 'b.json', id: '2', tableName: 'records' }
    ]);

    await deliver(panel, {
        command: 'saveProfile',
        profile: { name: 'b', filePath: 'renamed.json', id: '1', tableName: 'records' },
        originalName: 'a'
    });

    const reply = findReply(panel, 'profileSaveError');
    assert.ok(reply, 'expected profileSaveError reply');
    const errors = reply!.errors as Record<string, string | undefined>;
    assert.notEqual(errors.name, undefined);
    // Make sure no profile was overwritten.
    const persisted = ConfigManager.getProfiles();
    assert.equal(persisted.find((p) => p.name === 'a')?.filePath, 'a.json');
});

test('rendered HTML embeds the same regex source as the host-side validator', () => {
    const { vscode } = resetMocks();
    const { SettingsPanel } = loadModules();
    const panel = createMockWebviewPanel();
    vscode.__pendingWebviewPanel = panel;
    SettingsPanel.createOrShow(vscode.Uri.file('/ext') as never);

    const html = panel.webview.html;
    const match = html.match(/new RegExp\((".+?")\)/);
    assert.ok(match, 'regex literal not found in rendered HTML');
    const source = JSON.parse(match![1]);
    assert.equal(source, PROFILE_TABLENAME_REGEX_SOURCE);
    const re = new RegExp(source);
    assert.equal(re.test('public.records'), true);
    assert.equal(re.test('records; drop'), false);
});

test('pickFilePath surfaces dialog failures as a VS Code toast, not as connection-status error', async () => {
    const { vscode, panel } = setupPanel();
    vscode.window.showOpenDialog = async () => { throw new Error('disk on fire'); };

    await deliver(panel, { command: 'pickFilePath' });

    assert.equal(findReply(panel, 'genericError'), undefined);
    assert.equal(findReply(panel, 'connectionStringError'), undefined);
    assert.deepEqual(vscode.window.errorMessages, ['Neon Sync: disk on fire']);
});

test('saveConnectionString routes unexpected failures to connectionStringError', async () => {
    const { ConfigManager, panel } = setupPanel();
    ConfigManager.setConnectionString = async () => { throw new Error('keychain locked'); };

    await deliver(panel, { command: 'saveConnectionString', url: 'postgres://x' });

    const reply = findReply(panel, 'connectionStringError');
    assert.ok(reply);
    assert.equal(reply!.error, 'keychain locked');
});

test('pickFilePath uses an absolute defaultUri resolved from a relative currentValue', async () => {
    const { vscode, panel } = setupPanel();
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'neon-sync-ws-'));
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(workspaceRoot) }];
    let captured: any = null;
    vscode.window.showOpenDialog = async (options: unknown) => {
        captured = options;
        return undefined;
    };

    await deliver(panel, { command: 'pickFilePath', currentValue: 'subdir/file.json' });

    assert.ok(captured.defaultUri, 'expected defaultUri to be passed');
    assert.equal(captured.defaultUri.fsPath, path.resolve(workspaceRoot, 'subdir/file.json'));
});

test('pickFilePath omits defaultUri when no workspace and the value is relative', async () => {
    const { vscode, panel } = setupPanel();
    vscode.workspace.workspaceFolders = undefined;
    let captured: any = null;
    vscode.window.showOpenDialog = async (options: unknown) => {
        captured = options;
        return undefined;
    };

    await deliver(panel, { command: 'pickFilePath', currentValue: 'relative.json' });

    assert.equal(captured.defaultUri, undefined);
});

test('rendered CSS overrides hidden for any class that sets display: flex', () => {
    // Plain `hidden` attribute relies on the UA `[hidden] { display: none }` rule,
    // which a custom `display: flex` rule beats on specificity. Every class that
    // is toggled via `.hidden = true` AND has `display: flex|grid|inline-flex|inline-grid`
    // must add an explicit `.cls[hidden] { display: none; }` override, or the
    // attribute is silently ignored.
    const { vscode } = resetMocks();
    const { SettingsPanel } = loadModules();
    const panel = createMockWebviewPanel();
    vscode.__pendingWebviewPanel = panel;
    SettingsPanel.createOrShow(vscode.Uri.file('/ext') as never);

    const html = panel.webview.html;
    // Regression guard: classes we know are toggled via the hidden attribute.
    const togglesHidden = ['.ns-confirm-row', '.ns-modal-backdrop'];
    for (const cls of togglesHidden) {
        const escaped = cls.replace(/[.]/g, '\\.');
        const display = new RegExp(escaped + '\\s*\\{[^}]*display:\\s*(flex|grid|inline-flex|inline-grid)');
        if (!display.test(html)) continue;
        const override = new RegExp(escaped + '\\[hidden\\]\\s*\\{[^}]*display:\\s*none');
        assert.ok(override.test(html), `${cls} sets display: flex/grid but has no [hidden] override; the hidden attribute will be ignored`);
    }
});

test('rendered HTML applies a CSP meta tag and a nonce to inline script and style', () => {
    const { vscode } = resetMocks();
    const { SettingsPanel } = loadModules();
    const panel = createMockWebviewPanel();
    vscode.__pendingWebviewPanel = panel;
    SettingsPanel.createOrShow(vscode.Uri.file('/ext') as never);

    const html = panel.webview.html;
    const cspMatch = html.match(/Content-Security-Policy"\s+content="([^"]+)"/);
    assert.ok(cspMatch, 'expected CSP meta tag');
    const csp = cspMatch![1];
    const nonceMatch = csp.match(/'nonce-([^']+)'/);
    assert.ok(nonceMatch, 'expected nonce in CSP');
    const nonce = nonceMatch![1];
    assert.ok(html.includes(`<style nonce="${nonce}">`), 'expected style tag with matching nonce');
    assert.ok(html.includes(`<script nonce="${nonce}">`), 'expected script tag with matching nonce');
    assert.ok(csp.includes(`default-src 'none'`), 'expected default-src none in CSP');
});
