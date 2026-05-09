# Config UI Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the explicit Configure URL command, rename the two settings commands to mirror VS Code conventions, and rebuild the settings webview with macOS-style UI, modal profile editing, validation, and a native file picker.

**Architecture:** Three coordinated changes. (1) URL configuration becomes error-driven plus an in-panel field; the standalone command and InputBox prompt are removed. (2) Command titles align with `Preferences: Open User Settings` / `… (JSON)`. (3) Settings webview gets a card-based theme-aware UI, with profile add/edit isolated into a validated modal that uses VS Code's `showOpenDialog` for path selection. Profile validation logic is extracted into a pure module shared via template injection between the webview script and the host.

**Tech Stack:** TypeScript, VS Code Extension API (`vscode.window.showOpenDialog`, `WebviewPanel`, `SecretStorage`), `node:test` for unit tests.

**Spec:** [docs/superpowers/specs/2026-05-09-config-ui-rework-design.md](../specs/2026-05-09-config-ui-rework-design.md)

---

## File map

**Created:**
- `src/profileValidation.ts` — pure validators + regex constants. Single source of truth, consumed by host code directly and by the webview script via template injection.
- `test/profileValidation.test.ts` — unit tests for the validators.
- `test/settingsWebview.test.ts` — unit tests for the host-side webview message handlers.

**Modified:**
- `src/config.ts` — add `clearConnectionString`, add `promptMissingConnectionString`.
- `src/db.ts` — replace `getConnectionString` error message and call `promptMissingConnectionString` before throwing.
- `src/extension.ts` — remove `configureUrl` command registration; pass options arg to `SettingsPanel.createOrShow`.
- `src/settingsWebview.ts` — major rewrite: split into `SETTINGS_CSS` / `SETTINGS_HTML` / `SETTINGS_SCRIPT` constants; new message protocol; focus-field support; validator-source template injection.
- `package.json` — drop `neonSync.configureUrl` from `contributes.commands`; rename `neonSync.openConfigFile` title to `Neon Sync: Open Settings (JSON)`.
- `test/helpers/moduleMocks.ts` — extend `MockVscode` with `showOpenDialog` and `createWebviewPanel` test fakes.
- `test/config.test.ts` — add tests for `clearConnectionString` and `promptMissingConnectionString`.
- `test/db.test.ts` — update assertion for the new error message.
- `README.md` — update command names.
- `CHANGELOG.md` — add entry for this release.

---

### Task 1: Profile validation module (TDD)

**Files:**
- Create: `src/profileValidation.ts`
- Test: `test/profileValidation.test.ts`

- [ ] **Step 1: Write failing tests**

Create `test/profileValidation.test.ts`:

```ts
import test = require('node:test');
import assert = require('node:assert/strict');
import {
    validateProfileForm,
    hasErrors,
    PROFILE_TABLENAME_REGEX_SOURCE
} from '../src/profileValidation';

const valid = {
    name: 'my-profile',
    filePath: 'data.json',
    id: 'rec-1',
    tableName: 'json_records'
};

test('validateProfileForm returns no errors for a fully valid form', () => {
    const errors = validateProfileForm(valid, { existingNames: [] });
    assert.deepEqual(errors, {});
    assert.equal(hasErrors(errors), false);
});

test('validateProfileForm flags every empty required field', () => {
    const errors = validateProfileForm(
        { name: '  ', filePath: '', id: '', tableName: '' },
        { existingNames: [] }
    );
    assert.equal(errors.name, 'Name is required.');
    assert.equal(errors.filePath, 'File path is required.');
    assert.equal(errors.id, 'Record ID is required.');
    assert.equal(errors.tableName, 'Table name is required.');
    assert.equal(hasErrors(errors), true);
});

test('validateProfileForm rejects duplicate names but allows the original on edit', () => {
    const errorsDup = validateProfileForm(valid, { existingNames: ['my-profile', 'other'] });
    assert.equal(errorsDup.name, 'A profile with this name already exists.');

    const errorsRename = validateProfileForm(
        valid,
        { existingNames: ['my-profile', 'other'], originalName: 'my-profile' }
    );
    assert.equal(errorsRename.name, undefined);
});

test('validateProfileForm enforces SQL identifier shape on tableName', () => {
    for (const tableName of ['1bad', 'with space', 'a;b', '', 'schema.', '.table']) {
        const errors = validateProfileForm({ ...valid, tableName }, { existingNames: [] });
        assert.notEqual(errors.tableName, undefined, `expected error for "${tableName}"`);
    }
    for (const tableName of ['records', 'json_records', 'public.records', '_t1', 'Schema.Table_2']) {
        const errors = validateProfileForm({ ...valid, tableName }, { existingNames: [] });
        assert.equal(errors.tableName, undefined, `expected no error for "${tableName}"`);
    }
});

test('PROFILE_TABLENAME_REGEX_SOURCE is the same shape DatabaseService uses', () => {
    const re = new RegExp(PROFILE_TABLENAME_REGEX_SOURCE);
    assert.equal(re.test('public.records'), true);
    assert.equal(re.test('records; drop'), false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run compile:test && node --test "out-test/test/profileValidation.test.js"`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the validator module**

Create `src/profileValidation.ts`:

```ts
export const PROFILE_TABLENAME_REGEX_SOURCE = '^[a-zA-Z_][a-zA-Z0-9_]*(\\.[a-zA-Z_][a-zA-Z0-9_]*)?$';
export const PROFILE_TABLENAME_RE = new RegExp(PROFILE_TABLENAME_REGEX_SOURCE);

export interface ProfileFormValues {
    name: string;
    filePath: string;
    id: string;
    tableName: string;
}

export interface ProfileFieldErrors {
    name?: string;
    filePath?: string;
    id?: string;
    tableName?: string;
}

export interface ValidateProfileOptions {
    existingNames: string[];
    originalName?: string;
}

export function validateProfileForm(
    values: ProfileFormValues,
    options: ValidateProfileOptions
): ProfileFieldErrors {
    const errors: ProfileFieldErrors = {};

    const name = values.name.trim();
    if (!name) {
        errors.name = 'Name is required.';
    } else {
        const others = options.existingNames.filter((n) => n !== options.originalName);
        if (others.includes(name)) {
            errors.name = 'A profile with this name already exists.';
        }
    }

    if (!values.filePath.trim()) {
        errors.filePath = 'File path is required.';
    }

    if (!values.id.trim()) {
        errors.id = 'Record ID is required.';
    }

    const tableName = values.tableName.trim();
    if (!tableName) {
        errors.tableName = 'Table name is required.';
    } else if (!PROFILE_TABLENAME_RE.test(tableName)) {
        errors.tableName = 'Only letters, numbers, and underscores. Optionally schema.table.';
    }

    return errors;
}

export function hasErrors(errors: ProfileFieldErrors): boolean {
    return Object.values(errors).some((v) => v !== undefined);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all tests PASS, including the new `profileValidation` tests.

- [ ] **Step 5: Commit**

```bash
git add src/profileValidation.ts test/profileValidation.test.ts
git commit -m "feat(config): add shared profile form validators"
```

---

### Task 2: ConfigManager.clearConnectionString (TDD)

**Files:**
- Modify: `src/config.ts`
- Test: `test/config.test.ts`

- [ ] **Step 1: Write failing test**

Append to `test/config.test.ts`:

```ts
test('clearConnectionString deletes the secret, removes any legacy file value, and notifies listeners', async () => {
    const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'neon-sync-config-'));
    const configPath = path.join(storagePath, 'neon-sync.json');
    fs.writeFileSync(
        configPath,
        JSON.stringify({ connectionString: 'postgres://legacy', profiles: [] }, null, 2)
    );
    const secrets = createSecretMock();
    secrets.values.set('neonSync.connectionString', 'postgres://stored');
    const { ConfigManager } = initConfig(storagePath, secrets);
    let notifications = 0;
    ConfigManager.onConnectionStringChanged(() => { notifications += 1; });

    await ConfigManager.clearConnectionString();

    assert.equal(secrets.values.has('neonSync.connectionString'), false);
    const rewritten = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as ConfigFile;
    assert.equal(rewritten.connectionString, undefined);
    assert.equal(notifications, 1);
    assert.equal(await ConfigManager.getConnectionString(), undefined);
});
```

You also need the secret mock to support `delete`. Edit the `createSecretMock` helper near the top of the file:

```ts
interface SecretMock {
    values: Map<string, string>;
    get: (key: string) => Promise<string | undefined>;
    store: (key: string, value: string) => Promise<void>;
    delete: (key: string) => Promise<void>;
}

function createSecretMock(): SecretMock {
    const values = new Map<string, string>();
    return {
        values,
        async get(key: string): Promise<string | undefined> {
            return values.get(key);
        },
        async store(key: string, value: string): Promise<void> {
            values.set(key, value);
        },
        async delete(key: string): Promise<void> {
            values.delete(key);
        }
    };
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — `ConfigManager.clearConnectionString is not a function`.

- [ ] **Step 3: Implement clearConnectionString**

Edit `src/config.ts`. Add immediately after `setConnectionString`:

```ts
    static async clearConnectionString(): Promise<void> {
        if (this.secrets) {
            await this.secrets.delete(this.SECRET_KEY);
        }
        await this.removeConnectionStringFromFile();
        this.notifyConnectionStringChanged();
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat(config): add clearConnectionString"
```

---

### Task 3: ConfigManager.promptMissingConnectionString (TDD)

**Files:**
- Modify: `src/config.ts`
- Test: `test/config.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `test/config.test.ts`:

```ts
test('promptMissingConnectionString shows an error toast with an Open Settings button', async () => {
    const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'neon-sync-config-'));
    const { ConfigManager, vscode } = initConfig(storagePath);

    await ConfigManager.promptMissingConnectionString();

    assert.deepEqual(vscode.window.errorMessages, [
        'PostgreSQL connection string is not configured.'
    ]);
    assert.deepEqual(
        vscode.commands.executed,
        [{ command: 'neonSync.openSettings', args: [{ focus: 'connection' }] }]
    );
});

test('promptMissingConnectionString does not open settings when the user dismisses the toast', async () => {
    const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'neon-sync-config-'));
    const { ConfigManager, vscode } = initConfig(storagePath);
    // Override the mock to simulate the user closing the toast.
    vscode.window.showErrorMessage = async (message: string) => {
        vscode.window.errorMessages.push(message);
        return undefined;
    };

    await ConfigManager.promptMissingConnectionString();

    assert.deepEqual(vscode.commands.executed, []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `promptMissingConnectionString is not a function`.

- [ ] **Step 3: Implement promptMissingConnectionString**

Edit `src/config.ts`. Add as a new static method on `ConfigManager`:

```ts
    static async promptMissingConnectionString(): Promise<void> {
        const choice = await vscode.window.showErrorMessage(
            'PostgreSQL connection string is not configured.',
            'Open Settings'
        );
        if (choice === 'Open Settings') {
            await vscode.commands.executeCommand('neonSync.openSettings', { focus: 'connection' });
        }
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/config.test.ts
git commit -m "feat(config): centralize missing-URL prompt with Open Settings button"
```

---

### Task 4: Wire missing-URL prompt into db.ts (TDD)

**Files:**
- Modify: `src/db.ts`
- Test: `test/db.test.ts`

- [ ] **Step 1: Update existing failing-path test**

Open `test/db.test.ts` and find any test that currently asserts the missing-URL error message contains "Configure Connection URL". Replace its assertion with:

```ts
test('updateRecord triggers the missing-URL prompt and throws when no connection is configured', async () => {
    const { vscode } = resetMocks();
    const { DatabaseService } = loadModules();

    await assert.rejects(
        DatabaseService.updateRecord(profile(), '{}'),
        /PostgreSQL connection string is not configured\.$/
    );
    assert.deepEqual(vscode.window.errorMessages, [
        'PostgreSQL connection string is not configured.'
    ]);
});
```

If no such test exists yet, add this one. (Search for `Configure Connection URL` first to find references.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL — error message still contains the old "Please run …" suffix, or no toast was triggered.

- [ ] **Step 3: Update db.ts**

In `src/db.ts`, replace the `getConnectionString` method:

```ts
    private static async getConnectionString(): Promise<string> {
        const connectionString = await ConfigManager.getConnectionString();
        if (!connectionString) {
            void ConfigManager.promptMissingConnectionString();
            throw new Error('PostgreSQL connection string is not configured.');
        }
        return connectionString.trim();
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/db.ts test/db.test.ts
git commit -m "fix(db): trigger missing-URL prompt instead of pointing to a removed command"
```

---

### Task 5: Remove configureUrl command and rename openConfigFile

**Files:**
- Modify: `package.json`
- Modify: `src/extension.ts`

- [ ] **Step 1: Update package.json**

In `package.json` `contributes.commands`:

- Delete the entry for `neonSync.configureUrl`.
- Change the title of `neonSync.openConfigFile` from `Neon Sync: Open Config File` to `Neon Sync: Open Settings (JSON)`.

The `commands` array should now have 7 entries, and `openSettings` keeps its existing title.

- [ ] **Step 2: Remove the command handler from extension.ts**

In `src/extension.ts`, delete the entire `configureUrlDisposable` block (the `vscode.commands.registerCommand('neonSync.configureUrl', ...)` registration, currently around lines 232–243) and its `context.subscriptions.push(configureUrlDisposable)` line.

- [ ] **Step 3: Update the no-profiles error message in extension.ts**

In `src/extension.ts`, change the early-return inside `neonSync.syncFile` that currently reads:

```ts
vscode.window.showErrorMessage('No profiles configured. Run "Neon Sync: Open Config File" to configure.');
```

to:

```ts
vscode.window.showErrorMessage('No profiles configured. Run "Neon Sync: Open Settings" to configure.');
```

- [ ] **Step 4: Run typecheck and tests**

Run: `npm test`
Expected: all tests PASS, no compile errors.

- [ ] **Step 5: Commit**

```bash
git add package.json src/extension.ts
git commit -m "refactor: drop configureUrl command, rename openConfigFile title"
```

---

### Task 6: openSettings forwards focus options to the panel

**Files:**
- Modify: `src/extension.ts`
- Modify: `src/settingsWebview.ts`

- [ ] **Step 1: Update SettingsPanel.createOrShow signature**

In `src/settingsWebview.ts`, change the `createOrShow` signature and store the focus intent:

```ts
    public static createOrShow(extensionUri: vscode.Uri, options?: { focus?: 'connection' }): void {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (SettingsPanel.currentPanel) {
            SettingsPanel.currentPanel._panel.reveal(column);
            SettingsPanel.currentPanel._applyFocusOption(options);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'neonSyncSettings',
            'Neon Sync Settings',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
            }
        );

        SettingsPanel.currentPanel = new SettingsPanel(panel, extensionUri);
        SettingsPanel.currentPanel._applyFocusOption(options);
    }

    private _pendingFocus: 'connection' | undefined;

    private _applyFocusOption(options?: { focus?: 'connection' }): void {
        if (!options?.focus) return;
        this._pendingFocus = options.focus;
        // The webview may not have asked for settings yet. We post once now;
        // the webview also re-applies _pendingFocus when it sends getSettings.
        this._panel.webview.postMessage({ command: 'focusField', field: options.focus });
    }
```

When the webview sends `getSettings` (handled in `_setWebviewMessageListener`), after replying with `loadSettings`, also re-post `focusField` if `_pendingFocus` is set, then clear it. This guarantees focus survives the script's mount race.

- [ ] **Step 2: Update extension.ts to forward args**

In `src/extension.ts`, change the `openSettings` handler:

```ts
const openSettingsDisposable = vscode.commands.registerCommand(
    'neonSync.openSettings',
    (options?: { focus?: 'connection' }) => {
        SettingsPanel.createOrShow(context.extensionUri, options);
    }
);
```

- [ ] **Step 3: Run typecheck and tests**

Run: `npm test`
Expected: PASS (no behavioral tests yet for the new arg; just verifies the build is clean).

- [ ] **Step 4: Commit**

```bash
git add src/extension.ts src/settingsWebview.ts
git commit -m "feat(settings): accept focus option to scroll to connection field"
```

---

### Task 7: Extend test helpers for webview + dialog mocks

**Files:**
- Modify: `test/helpers/moduleMocks.ts`

- [ ] **Step 1: Extend MockVscode**

In `test/helpers/moduleMocks.ts`, extend the `MockVscode` interface and the `createVscodeMock` factory. Add to the interface:

```ts
    window: {
        infoMessages: string[];
        warningMessages: string[];
        errorMessages: string[];
        showInformationMessage: (message: string, ...items: unknown[]) => Promise<unknown>;
        showWarningMessage: (message: string, ...items: unknown[]) => Promise<unknown>;
        showErrorMessage: (message: string, ...items: unknown[]) => Promise<unknown>;
        withProgress: <T>(options: unknown, task: () => Thenable<T> | T) => Promise<T>;
        onDidChangeVisibleTextEditors: (listener: unknown) => { dispose: () => void };
        createWebviewPanel: (...args: unknown[]) => MockWebviewPanel;
        showQuickPick: () => Promise<undefined>;
        createQuickPick: () => unknown;
        showInputBox: () => Promise<undefined>;
        showTextDocument: () => Promise<undefined>;
        showOpenDialog: (options: unknown) => Promise<Array<{ fsPath: string }> | undefined>;
        activeTextEditor: undefined;
    };
```

Add a new exported interface and helper:

```ts
export interface MockWebview {
    postedMessages: unknown[];
    listeners: Array<(message: unknown) => unknown>;
    html: string;
    postMessage: (message: unknown) => Promise<boolean>;
    onDidReceiveMessage: (listener: (message: unknown) => unknown) => { dispose: () => void };
    asWebviewUri: (uri: { fsPath: string }) => { fsPath: string; toString: () => string };
}

export interface MockWebviewPanel {
    webview: MockWebview;
    revealCalls: number;
    disposed: boolean;
    reveal: (column?: number) => void;
    onDidDispose: (listener: () => void) => { dispose: () => void };
    dispose: () => void;
}

export function createMockWebviewPanel(): MockWebviewPanel {
    const webview: MockWebview = {
        postedMessages: [],
        listeners: [],
        html: '',
        async postMessage(message: unknown): Promise<boolean> {
            webview.postedMessages.push(message);
            return true;
        },
        onDidReceiveMessage(listener) {
            webview.listeners.push(listener);
            return { dispose() { /* no-op */ } };
        },
        asWebviewUri: (uri) => ({ fsPath: uri.fsPath, toString: () => `vscode-resource://${uri.fsPath}` })
    };
    const panel: MockWebviewPanel = {
        webview,
        revealCalls: 0,
        disposed: false,
        reveal() { panel.revealCalls += 1; },
        onDidDispose() { return { dispose() { /* no-op */ } }; },
        dispose() { panel.disposed = true; }
    };
    return panel;
}
```

In `createVscodeMock`, replace the `createWebviewPanel` and `showOpenDialog` slots:

```ts
        let nextWebviewPanel: MockWebviewPanel | undefined;
        // …inside vscode.window:
            createWebviewPanel: (...args: unknown[]) => {
                const panel = nextWebviewPanel ?? createMockWebviewPanel();
                nextWebviewPanel = undefined;
                return panel;
            },
            showOpenDialog: async () => undefined,
```

Also add a small accessor so tests can pre-stage a panel:

```ts
export function setNextWebviewPanel(panel: MockWebviewPanel): void {
    pendingWebviewPanel = panel;
}
```

(You will need a module-level `pendingWebviewPanel` that the factory reads. Pick a small refactor of the closure that avoids globals — reasonable approach: stash the next panel onto the returned `vscode` object as `vscode.__pendingWebviewPanel`, and have `createWebviewPanel` read/clear it.)

- [ ] **Step 2: Verify existing tests still pass**

Run: `npm test`
Expected: all existing tests PASS.

- [ ] **Step 3: Commit**

```bash
git add test/helpers/moduleMocks.ts
git commit -m "test: extend mock vscode with webview panel and showOpenDialog"
```

---

### Task 8: Settings webview — host-side message protocol (TDD)

**Files:**
- Modify: `src/settingsWebview.ts`
- Test: `test/settingsWebview.test.ts` (new)

- [ ] **Step 1: Write failing tests**

Create `test/settingsWebview.test.ts`:

```ts
import test = require('node:test');
import assert = require('node:assert/strict');
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    createMockWebviewPanel,
    installModuleMocks,
    purgeProjectModules,
    resetMocks
} from './helpers/moduleMocks';

installModuleMocks();

function loadModule() {
    purgeProjectModules();
    return require('../src/settingsWebview') as typeof import('../src/settingsWebview');
}

function loadConfigModule() {
    return require('../src/config') as typeof import('../src/config');
}

function initConfig(storagePath: string) {
    const { vscode } = resetMocks();
    const { ConfigManager } = loadConfigModule();
    const secrets = new Map<string, string>();
    ConfigManager.initialize({
        globalStorageUri: vscode.Uri.file(storagePath),
        secrets: {
            get: async (key: string) => secrets.get(key),
            store: async (key: string, value: string) => { secrets.set(key, value); },
            delete: async (key: string) => { secrets.delete(key); }
        }
    } as never);
    return { vscode, ConfigManager, secrets };
}

async function deliver(panel: ReturnType<typeof createMockWebviewPanel>, message: unknown) {
    for (const listener of panel.webview.listeners) {
        await listener(message);
    }
}

function findReply(panel: ReturnType<typeof createMockWebviewPanel>, command: string): any {
    return panel.webview.postedMessages.find((m: any) => m && m.command === command);
}

test('saveConnectionString stores the value and replies with connectionStringSaved', async () => {
    const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'neon-sync-webview-'));
    const { vscode, secrets } = initConfig(storagePath);
    const panel = createMockWebviewPanel();
    (vscode as any).__pendingWebviewPanel = panel;
    const { SettingsPanel } = loadModule();
    SettingsPanel.createOrShow(vscode.Uri.file('/ext') as never);

    await deliver(panel, { command: 'saveConnectionString', url: 'postgres://x' });

    assert.equal(secrets.get('neonSync.connectionString'), 'postgres://x');
    assert.ok(findReply(panel, 'connectionStringSaved'));
});

test('saveProfile validates input on the host and rejects invalid table names', async () => {
    const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'neon-sync-webview-'));
    const { vscode } = initConfig(storagePath);
    const panel = createMockWebviewPanel();
    (vscode as any).__pendingWebviewPanel = panel;
    const { SettingsPanel } = loadModule();
    SettingsPanel.createOrShow(vscode.Uri.file('/ext') as never);

    await deliver(panel, {
        command: 'saveProfile',
        profile: { name: 'p', filePath: 'p.json', id: '1', tableName: 'bad name' }
    });

    const errorReply: any = findReply(panel, 'profileSaveError');
    assert.ok(errorReply);
    assert.equal(errorReply.errors.tableName !== undefined, true);
});

test('pickFilePath returns workspace-relative path when the choice is inside the workspace', async () => {
    const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'neon-sync-webview-'));
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'neon-sync-ws-'));
    const chosen = path.join(workspaceRoot, 'subdir', 'file.json');
    const { vscode } = initConfig(storagePath);
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(workspaceRoot) }];
    vscode.window.showOpenDialog = async () => [{ fsPath: chosen }];
    const panel = createMockWebviewPanel();
    (vscode as any).__pendingWebviewPanel = panel;
    const { SettingsPanel } = loadModule();
    SettingsPanel.createOrShow(vscode.Uri.file('/ext') as never);

    await deliver(panel, { command: 'pickFilePath' });

    const reply: any = findReply(panel, 'filePathPicked');
    assert.equal(reply.path, path.join('subdir', 'file.json'));
});

test('pickFilePath returns absolute path when the choice is outside the workspace', async () => {
    const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'neon-sync-webview-'));
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'neon-sync-ws-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'neon-sync-elsewhere-'));
    const chosen = path.join(outside, 'file.json');
    const { vscode } = initConfig(storagePath);
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(workspaceRoot) }];
    vscode.window.showOpenDialog = async () => [{ fsPath: chosen }];
    const panel = createMockWebviewPanel();
    (vscode as any).__pendingWebviewPanel = panel;
    const { SettingsPanel } = loadModule();
    SettingsPanel.createOrShow(vscode.Uri.file('/ext') as never);

    await deliver(panel, { command: 'pickFilePath' });

    const reply: any = findReply(panel, 'filePathPicked');
    assert.equal(reply.path, chosen);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `SettingsPanel` doesn't speak the new protocol yet.

- [ ] **Step 3: Implement the host-side protocol**

Replace `src/settingsWebview.ts` with the structure below. (This task only updates the message handler logic and the supporting helpers — the HTML/CSS/JS strings can stay as their current values for now; later tasks will rewrite them.)

```ts
import * as vscode from 'vscode';
import * as path from 'path';
import { ConfigManager, Profile } from './config';
import {
    validateProfileForm,
    hasErrors,
    PROFILE_TABLENAME_REGEX_SOURCE,
    ProfileFormValues
} from './profileValidation';

interface SaveProfileMessage {
    command: 'saveProfile';
    profile: Profile;
    originalName?: string;
}

export class SettingsPanel {
    public static currentPanel: SettingsPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _disposables: vscode.Disposable[] = [];
    private _pendingFocus: 'connection' | undefined;

    private constructor(panel: vscode.WebviewPanel, _extensionUri: vscode.Uri) {
        this._panel = panel;
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._panel.webview.html = this._getHtmlForWebview(this._panel.webview);
        this._setWebviewMessageListener(this._panel.webview);
    }

    public static createOrShow(extensionUri: vscode.Uri, options?: { focus?: 'connection' }): void {
        const column = vscode.window.activeTextEditor?.viewColumn;
        if (SettingsPanel.currentPanel) {
            SettingsPanel.currentPanel._panel.reveal(column);
            SettingsPanel.currentPanel._applyFocusOption(options);
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            'neonSyncSettings',
            'Neon Sync Settings',
            column ?? vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
            }
        );
        SettingsPanel.currentPanel = new SettingsPanel(panel, extensionUri);
        SettingsPanel.currentPanel._applyFocusOption(options);
    }

    public dispose(): void {
        SettingsPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            this._disposables.pop()?.dispose();
        }
    }

    private _applyFocusOption(options?: { focus?: 'connection' }): void {
        if (!options?.focus) return;
        this._pendingFocus = options.focus;
        void this._panel.webview.postMessage({ command: 'focusField', field: options.focus });
    }

    private _setWebviewMessageListener(webview: vscode.Webview): void {
        webview.onDidReceiveMessage(async (message: any) => {
            try {
                switch (message?.command) {
                    case 'getSettings': {
                        const connectionString = await ConfigManager.getConnectionString();
                        await webview.postMessage({
                            command: 'loadSettings',
                            connectionString: connectionString ?? '',
                            profiles: ConfigManager.getProfiles()
                        });
                        if (this._pendingFocus) {
                            await webview.postMessage({ command: 'focusField', field: this._pendingFocus });
                            this._pendingFocus = undefined;
                        }
                        break;
                    }
                    case 'saveConnectionString': {
                        const url: string = message.url ?? '';
                        if (!url.trim()) {
                            await webview.postMessage({
                                command: 'connectionStringError',
                                error: 'Connection URL cannot be empty.'
                            });
                            break;
                        }
                        await ConfigManager.setConnectionString(url);
                        await webview.postMessage({ command: 'connectionStringSaved' });
                        break;
                    }
                    case 'clearConnectionString': {
                        await ConfigManager.clearConnectionString();
                        await webview.postMessage({ command: 'connectionStringSaved', url: '' });
                        break;
                    }
                    case 'saveProfile': {
                        const reply = await this._handleSaveProfile(message as SaveProfileMessage);
                        await webview.postMessage(reply);
                        break;
                    }
                    case 'deleteProfile': {
                        const profiles = ConfigManager.getProfiles().filter((p) => p.name !== message.name);
                        await ConfigManager.saveProfiles(profiles);
                        await webview.postMessage({ command: 'profilesSaved', profiles });
                        break;
                    }
                    case 'pickFilePath': {
                        const reply = await this._handlePickFilePath();
                        await webview.postMessage(reply);
                        break;
                    }
                }
            } catch (error) {
                console.error('Settings webview handler error:', error);
                await webview.postMessage({
                    command: 'genericError',
                    error: (error as Error)?.message ?? 'Unknown error'
                });
            }
        }, undefined, this._disposables);
    }

    private async _handleSaveProfile(message: SaveProfileMessage): Promise<unknown> {
        const profiles = ConfigManager.getProfiles();
        const values: ProfileFormValues = {
            name: message.profile.name ?? '',
            filePath: message.profile.filePath ?? '',
            id: message.profile.id ?? '',
            tableName: message.profile.tableName ?? ''
        };
        const errors = validateProfileForm(values, {
            existingNames: profiles.map((p) => p.name),
            originalName: message.originalName
        });
        if (hasErrors(errors)) {
            return { command: 'profileSaveError', errors, originalName: message.originalName };
        }
        const cleaned: Profile = {
            name: values.name.trim(),
            filePath: values.filePath.trim(),
            id: values.id.trim(),
            tableName: values.tableName.trim()
        };
        let next: Profile[];
        if (message.originalName !== undefined) {
            next = profiles.map((p) => (p.name === message.originalName ? cleaned : p));
        } else {
            next = [...profiles, cleaned];
        }
        await ConfigManager.saveProfiles(next);
        return { command: 'profilesSaved', profiles: next };
    }

    private async _handlePickFilePath(): Promise<unknown> {
        const result = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false
        });
        if (!result || result.length === 0) {
            return { command: 'filePathPicked', path: null };
        }
        const chosen = result[0].fsPath;
        const folders = vscode.workspace.workspaceFolders;
        if (folders && folders.length > 0) {
            const root = folders[0].uri.fsPath;
            const rel = path.relative(root, chosen);
            if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
                return { command: 'filePathPicked', path: rel };
            }
        }
        return { command: 'filePathPicked', path: chosen };
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        const validatorRegex = PROFILE_TABLENAME_REGEX_SOURCE;
        // The HTML/CSS/JS template still lives below; later tasks rebuild it.
        // For now, splice the regex into the script so the webview can validate locally.
        return getSettingsHtml(webview, { validatorRegex });
    }
}

function getSettingsHtml(_webview: vscode.Webview, _ctx: { validatorRegex: string }): string {
    // Placeholder: existing inline template stays in this function during Task 8.
    // Tasks 9-12 replace it with the macOS-style UI, modal, etc.
    return /* the current HTML string from the previous version */ '';
}
```

When you actually edit this file, keep the existing HTML string in `getSettingsHtml` (paste the current template literal verbatim, then add the small JS shim that handles the new message commands wired to the existing inputs — minimal, so tests pass before Task 9 starts the visual rewrite). Don't drop the existing UI yet.

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: PASS — including all four new `settingsWebview` tests.

- [ ] **Step 5: Commit**

```bash
git add src/settingsWebview.ts test/settingsWebview.test.ts
git commit -m "feat(settings): new message protocol with host-side validation"
```

---

### Task 9: Settings webview — restructure file into CSS/HTML/SCRIPT constants

**Files:**
- Modify: `src/settingsWebview.ts`

- [ ] **Step 1: Extract template constants**

Replace the placeholder `getSettingsHtml` body with three named exports inside the file, composed in the function:

```ts
const SETTINGS_CSS = `…`;
const SETTINGS_BODY = `…`;
const SETTINGS_SCRIPT = `…`;

function getSettingsHtml(_webview: vscode.Webview, ctx: { validatorRegex: string }): string {
    const script = SETTINGS_SCRIPT.replace('__VALIDATOR_REGEX__', ctx.validatorRegex);
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Neon Sync Settings</title>
<style>${SETTINGS_CSS}</style>
</head>
<body>
${SETTINGS_BODY}
<script>${script}</script>
</body>
</html>`;
}
```

For this task, populate `SETTINGS_CSS` / `SETTINGS_BODY` / `SETTINGS_SCRIPT` with the existing implementation moved verbatim into the constants. **The visible UI does not change yet.** This is a pure refactor that prepares for Tasks 10–12.

- [ ] **Step 2: Verify nothing regressed**

Run: `npm test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/settingsWebview.ts
git commit -m "refactor(settings): split webview template into named constants"
```

---

### Task 10: Settings webview — Connection card (UI rebuild)

**Files:**
- Modify: `src/settingsWebview.ts`

- [ ] **Step 1: Rewrite Connection card markup, styles, and script**

Replace the connection portion of `SETTINGS_BODY` with:

```html
<header class="ns-app-header">
    <h1 class="ns-title">Neon Sync Settings</h1>
</header>

<section class="ns-card" data-section="connection">
    <header class="ns-card__header">
        <h2 class="ns-card__title">Connection</h2>
    </header>
    <div class="ns-card__body">
        <label class="ns-label" for="connectionString">PostgreSQL Connection URL</label>
        <div class="ns-field-row">
            <input class="ns-input" type="password" id="connectionString" placeholder="postgres://user:password@host:port/dbname" autocomplete="off" spellcheck="false">
            <button type="button" class="ns-btn ns-btn--ghost" id="toggleConnVisibility" aria-pressed="false">Show</button>
        </div>
        <p class="ns-hint">Stored securely in VS Code Secret Storage.</p>
        <div class="ns-status" id="connectionStatus" role="status" aria-live="polite"></div>
        <div class="ns-confirm-row" id="connectionClearRow" hidden>
            <span class="ns-confirm-row__msg">Clear stored URL?</span>
            <button type="button" class="ns-btn ns-btn--danger" id="clearConnBtn">Clear</button>
            <button type="button" class="ns-btn ns-btn--ghost" id="keepConnBtn">Keep</button>
        </div>
    </div>
</section>
```

Add CSS for these classes in `SETTINGS_CSS`:

```css
:root {
    color-scheme: var(--vscode-color-scheme, dark);
}
* { box-sizing: border-box; }
body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 32px 28px 56px;
    margin: 0;
    line-height: 1.5;
}
.ns-app-header { margin: 0 0 24px; }
.ns-title { font-size: 22px; font-weight: 600; margin: 0; letter-spacing: -0.01em; }
.ns-card {
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-panel-border, transparent);
    border-radius: 10px;
    margin: 0 0 20px;
    box-shadow: 0 1px 0 rgba(255, 255, 255, 0.02), 0 1px 3px rgba(0, 0, 0, 0.06);
}
.ns-card__header { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; border-bottom: 1px solid var(--vscode-panel-border, transparent); }
.ns-card__title { font-size: 14px; font-weight: 600; margin: 0; opacity: 0.95; }
.ns-card__body { padding: 18px; }
.ns-label { display: block; font-size: 12px; font-weight: 600; margin-bottom: 6px; opacity: 0.85; }
.ns-field-row { display: flex; gap: 8px; align-items: stretch; }
.ns-input {
    flex: 1;
    font: inherit;
    padding: 8px 10px;
    border-radius: 6px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    outline: none;
}
.ns-input:focus { border-color: var(--vscode-focusBorder); box-shadow: 0 0 0 1px var(--vscode-focusBorder); }
.ns-input.ns-input--error { border-color: var(--vscode-errorForeground); }
.ns-btn {
    font: inherit;
    padding: 7px 14px;
    border-radius: 6px;
    border: 1px solid transparent;
    cursor: pointer;
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
}
.ns-btn:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground)); }
.ns-btn--primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.ns-btn--primary:hover { background: var(--vscode-button-hoverBackground); }
.ns-btn--danger { background: transparent; color: var(--vscode-errorForeground); border-color: var(--vscode-errorForeground); }
.ns-btn--danger:hover { background: var(--vscode-inputValidation-errorBackground, transparent); }
.ns-btn--ghost { background: transparent; border-color: var(--vscode-panel-border, transparent); }
.ns-hint { color: var(--vscode-descriptionForeground); font-size: 12px; margin: 8px 0 0; }
.ns-status { font-size: 12px; min-height: 16px; margin-top: 8px; color: var(--vscode-descriptionForeground); }
.ns-status.ns-status--success { color: var(--vscode-charts-green, var(--vscode-foreground)); }
.ns-status.ns-status--error { color: var(--vscode-errorForeground); }
.ns-confirm-row { display: flex; gap: 8px; align-items: center; margin-top: 10px; }
.ns-confirm-row__msg { font-size: 12px; color: var(--vscode-foreground); }
@media (prefers-reduced-motion: reduce) {
    * { animation: none !important; transition: none !important; }
}
```

In `SETTINGS_SCRIPT`, replace the connection-handling JS with logic that:

- On `loadSettings`, populates the input.
- Stores the loaded value as `lastSavedConnection`.
- On `Show`/`Hide` button click, toggles `type` and updates the button label.
- On blur or Enter:
  - If value === `lastSavedConnection`, do nothing.
  - Else if new value is non-empty, post `saveConnectionString` and show transient `Saving…` status.
  - Else (empty and was non-empty), reveal the confirm row.
- On `Clear`, post `clearConnectionString`.
- On `Keep`, restore the input to `lastSavedConnection` and hide the row.
- On `connectionStringSaved`: update `lastSavedConnection`, show `Saved` for 1500ms, then clear status.
- On `connectionStringError`: show error in status.
- On `focusField` with `field === 'connection'`: scroll the connection card into view, focus the input.

(Write the script body inline; the example pattern: dispatch on `event.data.command`.)

- [ ] **Step 2: Verify**

Run: `npm test`
Expected: PASS — host-side tests still hold; connection logic now uses the new UI but the protocol is unchanged.

- [ ] **Step 3: Commit**

```bash
git add src/settingsWebview.ts
git commit -m "feat(settings): macOS-style Connection card with show/hide and blur-save"
```

---

### Task 11: Settings webview — Profiles list and delete confirmation

**Files:**
- Modify: `src/settingsWebview.ts`

- [ ] **Step 1: Replace the profiles section markup**

Replace the existing Profiles `<table>` and Add button in `SETTINGS_BODY` with:

```html
<section class="ns-card" data-section="profiles">
    <header class="ns-card__header">
        <h2 class="ns-card__title">Profiles</h2>
        <button type="button" class="ns-btn ns-btn--primary" id="addProfileBtn">+ Add</button>
    </header>
    <div class="ns-card__body">
        <ul class="ns-profile-list" id="profileList"></ul>
        <p class="ns-empty" id="profileEmpty" hidden>No profiles yet. Click + Add to create one.</p>
    </div>
</section>

<div class="ns-modal-backdrop" id="confirmDeleteBackdrop" hidden>
    <div class="ns-modal ns-modal--confirm" role="dialog" aria-modal="true" aria-labelledby="confirmDeleteTitle">
        <header class="ns-modal__header"><h3 id="confirmDeleteTitle" class="ns-modal__title">Delete profile</h3></header>
        <div class="ns-modal__body">
            <p id="confirmDeleteBody"></p>
        </div>
        <footer class="ns-modal__footer">
            <button type="button" class="ns-btn ns-btn--ghost" id="confirmDeleteCancel">Cancel</button>
            <button type="button" class="ns-btn ns-btn--danger" id="confirmDeleteOk">Delete</button>
        </footer>
    </div>
</div>
```

Add to `SETTINGS_CSS`:

```css
.ns-profile-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.ns-profile-card {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 14px;
    border: 1px solid var(--vscode-panel-border, transparent);
    border-radius: 8px;
    background: var(--vscode-editor-background);
}
.ns-profile-card__main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.ns-profile-card__name { font-weight: 600; font-size: 13px; }
.ns-profile-card__meta { color: var(--vscode-descriptionForeground); font-size: 12px; overflow: hidden; text-overflow: ellipsis; }
.ns-profile-card__actions { display: flex; gap: 8px; flex-shrink: 0; margin-left: 12px; }
.ns-empty { color: var(--vscode-descriptionForeground); text-align: center; padding: 18px 0; }

.ns-modal-backdrop {
    position: fixed; inset: 0;
    background: rgba(0, 0, 0, 0.45);
    display: flex; align-items: center; justify-content: center;
    z-index: 100;
    animation: ns-fade 200ms ease-out;
}
.ns-modal {
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border, transparent);
    border-radius: 10px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
    width: min(440px, 90vw);
    animation: ns-pop 160ms ease-out;
}
.ns-modal--confirm { width: min(380px, 90vw); }
.ns-modal__header { padding: 14px 18px; border-bottom: 1px solid var(--vscode-panel-border, transparent); }
.ns-modal__title { font-size: 14px; font-weight: 600; margin: 0; }
.ns-modal__body { padding: 16px 18px; }
.ns-modal__footer { padding: 12px 18px; display: flex; justify-content: flex-end; gap: 8px; border-top: 1px solid var(--vscode-panel-border, transparent); }
@keyframes ns-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes ns-pop { from { transform: scale(0.96); opacity: 0; } to { transform: scale(1); opacity: 1; } }
```

In `SETTINGS_SCRIPT`, add a `renderProfiles(profiles)` function that:

- Empties `#profileList`.
- Toggles `#profileEmpty` based on `profiles.length === 0`.
- For each profile, creates an `<li class="ns-profile-card">` with name, `${filePath} · ${tableName}` meta, and Edit + Delete buttons. Edit calls `openProfileModal(profile)` (Task 12). Delete opens the confirm modal with body text `Delete profile "<name>"? This cannot be undone.`; on `Delete` click, post `deleteProfile`.
- On receipt of `profilesSaved`, call `renderProfiles(message.profiles)`.

- [ ] **Step 2: Verify**

Run: `npm test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/settingsWebview.ts
git commit -m "feat(settings): card-based profile list with delete confirmation"
```

---

### Task 12: Settings webview — Profile add/edit modal with validation and Browse picker

**Files:**
- Modify: `src/settingsWebview.ts`

- [ ] **Step 1: Add modal markup**

Append to `SETTINGS_BODY`:

```html
<div class="ns-modal-backdrop" id="profileModalBackdrop" hidden>
    <form class="ns-modal" id="profileModal" role="dialog" aria-modal="true" aria-labelledby="profileModalTitle">
        <header class="ns-modal__header"><h3 id="profileModalTitle" class="ns-modal__title">Add profile</h3></header>
        <div class="ns-modal__body">
            <div class="ns-form-row">
                <label class="ns-label" for="pmName">Name<span class="ns-req">*</span></label>
                <input class="ns-input" type="text" id="pmName" autocomplete="off" spellcheck="false">
                <p class="ns-error" data-error-for="name" hidden></p>
            </div>
            <div class="ns-form-row">
                <label class="ns-label" for="pmFilePath">Local File Path<span class="ns-req">*</span></label>
                <div class="ns-field-row">
                    <input class="ns-input" type="text" id="pmFilePath" autocomplete="off" spellcheck="false">
                    <button type="button" class="ns-btn ns-btn--ghost" id="pmBrowse">Browse…</button>
                </div>
                <p class="ns-hint">Relative paths resolve from the workspace root.</p>
                <p class="ns-error" data-error-for="filePath" hidden></p>
            </div>
            <div class="ns-form-row">
                <label class="ns-label" for="pmId">Record ID<span class="ns-req">*</span></label>
                <input class="ns-input" type="text" id="pmId" autocomplete="off" spellcheck="false">
                <p class="ns-error" data-error-for="id" hidden></p>
            </div>
            <div class="ns-form-row">
                <label class="ns-label" for="pmTableName">Table Name<span class="ns-req">*</span></label>
                <input class="ns-input" type="text" id="pmTableName" autocomplete="off" spellcheck="false" value="json_records">
                <p class="ns-hint">Letters, numbers, and underscores. Optionally <code>schema.table</code>.</p>
                <p class="ns-error" data-error-for="tableName" hidden></p>
            </div>
            <p class="ns-status ns-status--error" id="pmFormError" hidden></p>
        </div>
        <footer class="ns-modal__footer">
            <button type="button" class="ns-btn ns-btn--ghost" id="pmCancel">Cancel</button>
            <button type="submit" class="ns-btn ns-btn--primary" id="pmSave">Save</button>
        </footer>
    </form>
</div>
```

Add to `SETTINGS_CSS`:

```css
.ns-form-row { margin-bottom: 14px; }
.ns-form-row:last-of-type { margin-bottom: 0; }
.ns-req { color: var(--vscode-errorForeground); margin-left: 2px; }
.ns-error { color: var(--vscode-errorForeground); font-size: 12px; margin: 6px 0 0; }
code { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.95em; padding: 0 4px; border-radius: 3px; background: var(--vscode-textCodeBlock-background, transparent); }
```

- [ ] **Step 2: Modal logic in SETTINGS_SCRIPT**

Add functions:

- `openProfileModal(existing?)` — sets title to `Add profile` or `Edit profile`, prefills inputs (or defaults `tableName` to `json_records`), clears errors, sets `currentEditingOriginalName`, focuses Name input.
- `closeProfileModal()` — hides the backdrop, clears `currentEditingOriginalName`.
- `runValidation(values)` — local copy of `validateProfileForm`, using injected regex `__VALIDATOR_REGEX__`. Returns the same `errors` shape as the host.
- Submit handler:

```js
profileModal.addEventListener('submit', (e) => {
    e.preventDefault();
    const values = readModalValues();
    const errors = runValidation(values, profilesSnapshot, currentEditingOriginalName);
    applyErrorsToForm(errors);
    if (Object.keys(errors).filter(k => errors[k]).length > 0) return;
    vscode.postMessage({
        command: 'saveProfile',
        profile: values,
        originalName: currentEditingOriginalName
    });
});
```

- On `profileSaveError`: call `applyErrorsToForm(message.errors)` and show the form-error banner with text `Please fix the errors below.`
- On `profilesSaved`: refresh `profilesSnapshot`, call `renderProfiles`, then `closeProfileModal()`.
- Esc key handler closes the modal (with confirm only if any input differs from its loaded value — track `dirty` flag on input changes).
- Backdrop click closes the modal (same dirty check).
- `pmBrowse` button posts `pickFilePath`. On `filePathPicked` with non-null `path`, set `pmFilePath.value = path` and mark form dirty.

Wire `addProfileBtn` to `openProfileModal()` (no arg). Wire each profile card's Edit button to `openProfileModal(profile)`.

The script must inline the regex via the placeholder, e.g.:

```js
const TABLE_NAME_RE = new RegExp('__VALIDATOR_REGEX__');
```

The host substitutes the regex source via `SETTINGS_SCRIPT.replace('__VALIDATOR_REGEX__', ctx.validatorRegex)` (already done in Task 9).

- [ ] **Step 3: Verify**

Run: `npm test`
Expected: PASS — host-side tests untouched.

- [ ] **Step 4: Manual sanity (optional but recommended)**

Run `npm run watch` in one terminal, launch the Extension Development Host (`F5` in VS Code), and:

- Open Settings → Add a profile with empty fields → all four show errors.
- Add `bad name` for table → tableName error.
- Add a duplicate name → name error.
- Click Browse, pick a file inside the current workspace → relative path appears.
- Pick a file outside → absolute path appears.
- Save valid profile → modal closes, card appears.
- Edit, delete with confirm.
- Theme switch (light/dark) → still legible.

- [ ] **Step 5: Commit**

```bash
git add src/settingsWebview.ts
git commit -m "feat(settings): add profile modal with validation and file picker"
```

---

### Task 13: README and CHANGELOG

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: README**

In `README.md`, find the section that lists commands or describes configuration. Replace any reference to `Configure Connection URL` or `Open Config File` with the new flow:

- Set up: open the Command Palette, run `Neon Sync: Open Settings`. Add the connection URL and at least one profile via the in-panel UI. The connection URL is stored in VS Code Secret Storage.
- Power-user JSON access: `Neon Sync: Open Settings (JSON)` opens the underlying file.

- [ ] **Step 2: CHANGELOG**

Prepend an entry to `CHANGELOG.md` describing this release:

```
## 0.6.0

- Removed the standalone `Neon Sync: Configure Connection URL` command. The settings panel now handles URL configuration, and a "Open Settings" button appears on the missing-URL error toast.
- Renamed `Neon Sync: Open Config File` to `Neon Sync: Open Settings (JSON)` to match VS Code's own naming convention.
- Redesigned the settings panel: theme-aware macOS-inspired styling, profile add/edit moved into a validated modal, and a native file picker for the local file path.
```

(Bump version in `package.json` to `0.6.0`.)

- [ ] **Step 3: Commit**

```bash
git add README.md CHANGELOG.md package.json
git commit -m "docs: update README and CHANGELOG for v0.6.0"
```

---

### Task 14: Final verification

- [ ] **Step 1: Clean build**

Run: `npm test`
Expected: clean compile + all tests PASS.

- [ ] **Step 2: Verify the command surface**

Run: `node -e "console.log(JSON.stringify(require('./package.json').contributes.commands.map(c => c.command + ' :: ' + c.title), null, 2))"`
Expected: 7 commands, none of them `neonSync.configureUrl`. `neonSync.openConfigFile` shows title `Neon Sync: Open Settings (JSON)`.

- [ ] **Step 3: Grep for stale references**

Run: `grep -rn "Configure Connection URL\|Open Config File\|configureUrl" src test package.json README.md CHANGELOG.md` (use the Grep tool).
Expected: zero hits.

- [ ] **Step 4: Commit if anything was missed**

If the grep produced hits, fix them and commit:

```bash
git commit -am "chore: remove stray references to removed command"
```

If clean, no commit needed.

---

## Self-review notes

- Spec coverage: every numbered section in the design spec maps to one of Tasks 1–13. Part 1 (URL flow) → Tasks 2, 3, 4, 5. Part 2 (rename) → Task 5 + 13. Part 3 (UI) → Tasks 6, 7, 8, 9, 10, 11, 12.
- Type consistency: `ProfileFormValues`, `ProfileFieldErrors`, `validateProfileForm` referenced consistently between Tasks 1, 8, 12. Message names (`saveConnectionString`, `clearConnectionString`, `connectionStringSaved`, `connectionStringError`, `saveProfile`, `profileSaveError`, `profilesSaved`, `deleteProfile`, `pickFilePath`, `filePathPicked`, `focusField`) are consistent across spec and tasks.
- Placeholder scan: every code step shows the actual code; no "TBD" / "implement later".
- Tests precede implementations (TDD) on Tasks 1–4 and 8.
- Deliberately not covered: webview UI assertions (no DOM in node:test). Manual smoke step is called out in Task 12 Step 4.
