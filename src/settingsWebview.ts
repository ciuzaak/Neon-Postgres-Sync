import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';
import { ConfigManager, Profile } from './config';
import {
    validateProfileForm,
    hasErrors,
    PROFILE_TABLENAME_REGEX_SOURCE,
    ProfileFormValues
} from './profileValidation';

export interface SettingsPanelOptions {
    focus?: 'connection';
}

interface SaveProfileMessage {
    command: 'saveProfile';
    profile: Profile;
    originalName?: string;
}

interface PickFilePathMessage {
    command: 'pickFilePath';
    currentValue?: string;
}

export class SettingsPanel {
    public static currentPanel: SettingsPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _disposables: vscode.Disposable[] = [];
    private _pendingFocus: 'connection' | undefined;
    private _settingsLoaded = false;

    private constructor(panel: vscode.WebviewPanel, _extensionUri: vscode.Uri) {
        this._panel = panel;
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._panel.webview.html = this._getHtmlForWebview(this._panel.webview);
        this._setWebviewMessageListener(this._panel.webview);
    }

    public static createOrShow(extensionUri: vscode.Uri, options?: SettingsPanelOptions): void {
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

    private _applyFocusOption(options?: SettingsPanelOptions): void {
        if (!options?.focus) return;
        if (this._settingsLoaded) {
            // The script is mounted and already has its message listener; post
            // directly so re-opening with focus on an existing panel works.
            void this._panel.webview.postMessage({ command: 'focusField', field: options.focus });
            return;
        }
        // First open: wait for the script to send getSettings, then re-emit
        // focus after the loadSettings reply. Posting now would race the
        // listener mount and either steal focus later or be lost.
        this._pendingFocus = options.focus;
    }

    private _setWebviewMessageListener(webview: vscode.Webview): void {
        webview.onDidReceiveMessage(async (message: any) => {
            try {
                switch (message?.command) {
                    case 'getSettings':
                        await this._handleGetSettings(webview);
                        break;
                    case 'saveConnectionString':
                        await this._handleSaveConnectionString(webview, message.url);
                        break;
                    case 'clearConnectionString':
                        await ConfigManager.clearConnectionString();
                        await webview.postMessage({ command: 'connectionStringSaved', url: '' });
                        break;
                    case 'saveProfile':
                        await webview.postMessage(await this._handleSaveProfile(message as SaveProfileMessage));
                        break;
                    case 'deleteProfile':
                        await this._handleDeleteProfile(webview, message.name);
                        break;
                    case 'pickFilePath':
                        await webview.postMessage(await this._handlePickFilePath(message as PickFilePathMessage));
                        break;
                }
            } catch (error) {
                console.error('Settings webview handler error:', error);
                const errorMessage = (error as Error)?.message ?? 'Unknown error';
                if (message?.command === 'saveProfile') {
                    await webview.postMessage({
                        command: 'profileSaveError',
                        errors: {},
                        formError: `Failed to save profile: ${errorMessage}`,
                        originalName: (message as SaveProfileMessage).originalName
                    });
                } else {
                    await webview.postMessage({
                        command: 'genericError',
                        error: errorMessage
                    });
                }
            }
        }, undefined, this._disposables);
    }

    private async _handleGetSettings(webview: vscode.Webview): Promise<void> {
        const connectionString = await ConfigManager.getConnectionString();
        await webview.postMessage({
            command: 'loadSettings',
            connectionString: connectionString ?? '',
            profiles: ConfigManager.getProfiles()
        });
        this._settingsLoaded = true;
        if (this._pendingFocus) {
            await webview.postMessage({ command: 'focusField', field: this._pendingFocus });
            this._pendingFocus = undefined;
        }
    }

    private async _handleSaveConnectionString(webview: vscode.Webview, rawUrl: unknown): Promise<void> {
        const url = typeof rawUrl === 'string' ? rawUrl : '';
        if (!url.trim()) {
            await webview.postMessage({
                command: 'connectionStringError',
                error: 'Connection URL cannot be empty.'
            });
            return;
        }
        await ConfigManager.setConnectionString(url);
        await webview.postMessage({ command: 'connectionStringSaved' });
    }

    private async _handleSaveProfile(message: SaveProfileMessage): Promise<unknown> {
        const profiles = ConfigManager.getProfiles();
        const incoming = message.profile ?? ({} as Partial<Profile>);
        const values: ProfileFormValues = {
            name: typeof incoming.name === 'string' ? incoming.name : '',
            filePath: typeof incoming.filePath === 'string' ? incoming.filePath : '',
            id: typeof incoming.id === 'string' ? incoming.id : '',
            tableName: typeof incoming.tableName === 'string' ? incoming.tableName : ''
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
        const next: Profile[] = message.originalName !== undefined
            ? profiles.map((p) => (p.name === message.originalName ? cleaned : p))
            : [...profiles, cleaned];
        await ConfigManager.saveProfiles(next);
        return { command: 'profilesSaved', profiles: next };
    }

    private async _handleDeleteProfile(webview: vscode.Webview, name: unknown): Promise<void> {
        if (typeof name !== 'string') return;
        const profiles = ConfigManager.getProfiles().filter((p) => p.name !== name);
        await ConfigManager.saveProfiles(profiles);
        await webview.postMessage({ command: 'profilesSaved', profiles });
    }

    private async _handlePickFilePath(message: PickFilePathMessage): Promise<unknown> {
        const folders = vscode.workspace.workspaceFolders;
        const workspaceRoot = folders && folders.length > 0 ? folders[0].uri.fsPath : undefined;
        const result = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            defaultUri: this._resolveDefaultUri(message.currentValue, workspaceRoot)
        });
        if (!result || result.length === 0) {
            return { command: 'filePathPicked', path: null };
        }
        const chosen = result[0].fsPath;
        if (workspaceRoot) {
            const rel = path.relative(workspaceRoot, chosen);
            if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
                return { command: 'filePathPicked', path: rel };
            }
        }
        return { command: 'filePathPicked', path: chosen };
    }

    private _resolveDefaultUri(currentValue: unknown, workspaceRoot?: string): vscode.Uri | undefined {
        if (typeof currentValue === 'string' && currentValue.trim()) {
            const value = currentValue.trim();
            const absolute = path.isAbsolute(value)
                ? value
                : workspaceRoot ? path.join(workspaceRoot, value) : undefined;
            if (absolute) return vscode.Uri.file(absolute);
        }
        return workspaceRoot ? vscode.Uri.file(workspaceRoot) : undefined;
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        return getSettingsHtml({
            validatorRegex: PROFILE_TABLENAME_REGEX_SOURCE,
            nonce: crypto.randomBytes(16).toString('base64'),
            cspSource: webview.cspSource
        });
    }
}

const SETTINGS_CSS = `
:root { color-scheme: var(--vscode-color-scheme, dark); }
* { box-sizing: border-box; }
body {
    font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 28px 28px 56px;
    margin: 0;
    line-height: 1.5;
    font-size: 13px;
}
.ns-app-header { margin: 0 0 22px; }
.ns-title { font-size: 22px; font-weight: 600; margin: 0; letter-spacing: -0.01em; }

.ns-card {
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-panel-border, transparent);
    border-radius: 10px;
    margin: 0 0 18px;
    box-shadow: 0 1px 0 rgba(255, 255, 255, 0.02), 0 1px 3px rgba(0, 0, 0, 0.06);
    overflow: hidden;
}
.ns-card__header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 18px;
    border-bottom: 1px solid var(--vscode-panel-border, transparent);
}
.ns-card__title { font-size: 13px; font-weight: 600; margin: 0; opacity: 0.95; }
.ns-card__body { padding: 18px; }

.ns-label { display: block; font-size: 12px; font-weight: 600; margin-bottom: 6px; opacity: 0.85; }
.ns-field-row { display: flex; gap: 8px; align-items: stretch; }
.ns-input {
    flex: 1; min-width: 0;
    font: inherit;
    padding: 7px 10px;
    border-radius: 6px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    outline: none;
    transition: border-color 120ms ease, box-shadow 120ms ease;
}
.ns-input:focus {
    border-color: var(--vscode-focusBorder);
    box-shadow: 0 0 0 1px var(--vscode-focusBorder);
}
.ns-input.ns-input--error { border-color: var(--vscode-errorForeground); }
.ns-input.ns-input--error:focus { box-shadow: 0 0 0 1px var(--vscode-errorForeground); }

.ns-btn {
    font: inherit;
    padding: 6px 14px;
    border-radius: 6px;
    border: 1px solid transparent;
    cursor: pointer;
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    transition: background-color 120ms ease, border-color 120ms ease;
    white-space: nowrap;
}
.ns-btn:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground)); }
.ns-btn:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
.ns-btn--primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.ns-btn--primary:hover { background: var(--vscode-button-hoverBackground); }
.ns-btn--danger {
    background: transparent;
    color: var(--vscode-errorForeground);
    border-color: var(--vscode-errorForeground);
}
.ns-btn--danger:hover { background: var(--vscode-inputValidation-errorBackground, transparent); }
.ns-btn--ghost { background: transparent; border-color: var(--vscode-panel-border, transparent); }

.ns-hint { color: var(--vscode-descriptionForeground); font-size: 12px; margin: 8px 0 0; }
.ns-status {
    font-size: 12px; min-height: 18px; margin-top: 8px;
    color: var(--vscode-descriptionForeground);
    transition: opacity 120ms ease;
}
.ns-status.ns-status--success { color: var(--vscode-testing-iconPassed, var(--vscode-charts-green, var(--vscode-foreground))); }
.ns-status.ns-status--error { color: var(--vscode-errorForeground); }

.ns-confirm-row {
    display: flex; gap: 8px; align-items: center;
    margin-top: 10px;
    padding: 8px 10px;
    border-radius: 6px;
    background: var(--vscode-inputValidation-warningBackground, var(--vscode-editorWidget-background));
    border: 1px solid var(--vscode-inputValidation-warningBorder, var(--vscode-panel-border));
}
.ns-confirm-row__msg { font-size: 12px; flex: 1; }

.ns-profile-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.ns-profile-card {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 14px;
    border: 1px solid var(--vscode-panel-border, transparent);
    border-radius: 8px;
    background: var(--vscode-editor-background);
}
.ns-profile-card__main { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.ns-profile-card__name { font-weight: 600; font-size: 13px; word-break: break-word; }
.ns-profile-card__meta {
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ns-profile-card__actions { display: flex; gap: 8px; flex-shrink: 0; margin-left: 12px; }
.ns-empty { color: var(--vscode-descriptionForeground); text-align: center; padding: 18px 0; margin: 0; }

.ns-modal-backdrop {
    position: fixed; inset: 0;
    background: rgba(0, 0, 0, 0.45);
    display: flex; align-items: center; justify-content: center;
    z-index: 100;
    animation: ns-fade 200ms ease-out;
}
.ns-modal-backdrop[hidden] { display: none; }
.ns-modal {
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border, transparent);
    border-radius: 10px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.3), 0 1px 2px rgba(0, 0, 0, 0.2);
    width: min(440px, 92vw);
    max-height: 92vh;
    display: flex; flex-direction: column;
    animation: ns-pop 160ms ease-out;
}
.ns-modal--confirm { width: min(380px, 92vw); }
.ns-modal__header { padding: 14px 18px; border-bottom: 1px solid var(--vscode-panel-border, transparent); }
.ns-modal__title { font-size: 14px; font-weight: 600; margin: 0; }
.ns-modal__body { padding: 16px 18px; overflow-y: auto; }
.ns-modal__footer {
    padding: 12px 18px;
    display: flex; justify-content: flex-end; gap: 8px;
    border-top: 1px solid var(--vscode-panel-border, transparent);
}

.ns-form-row { margin-bottom: 14px; }
.ns-form-row:last-child { margin-bottom: 0; }
.ns-req { color: var(--vscode-errorForeground); margin-left: 2px; }
.ns-error { color: var(--vscode-errorForeground); font-size: 12px; margin: 6px 0 0; }
code {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.95em;
    padding: 0 4px;
    border-radius: 3px;
    background: var(--vscode-textCodeBlock-background, transparent);
}

@keyframes ns-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes ns-pop { from { transform: scale(0.96); opacity: 0; } to { transform: scale(1); opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
    .ns-modal-backdrop, .ns-modal { animation: none; }
    * { transition: none !important; }
}
`;

const SETTINGS_BODY = `
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
        <header class="ns-modal__header">
            <h3 id="confirmDeleteTitle" class="ns-modal__title">Delete profile</h3>
        </header>
        <div class="ns-modal__body">
            <p id="confirmDeleteBody"></p>
        </div>
        <footer class="ns-modal__footer">
            <button type="button" class="ns-btn ns-btn--ghost" id="confirmDeleteCancel">Cancel</button>
            <button type="button" class="ns-btn ns-btn--danger" id="confirmDeleteOk">Delete</button>
        </footer>
    </div>
</div>

<div class="ns-modal-backdrop" id="profileModalBackdrop" hidden>
    <form class="ns-modal" id="profileModal" role="dialog" aria-modal="true" aria-labelledby="profileModalTitle" novalidate>
        <header class="ns-modal__header">
            <h3 id="profileModalTitle" class="ns-modal__title">Add profile</h3>
        </header>
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
                    <button type="button" class="ns-btn ns-btn--ghost" id="pmBrowse">Browse&hellip;</button>
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
`;

const SETTINGS_SCRIPT = `
(function () {
    const vscode = acquireVsCodeApi();
    const TABLE_NAME_RE = new RegExp("__VALIDATOR_REGEX__");

    const state = {
        connectionLoaded: '',
        profiles: [],
        editingOriginalName: null,
        modalDirty: false,
        clearConfirmActive: false,
        statusTimer: null
    };

    const $ = (id) => document.getElementById(id);

    const els = {
        connInput: $('connectionString'),
        connToggle: $('toggleConnVisibility'),
        connStatus: $('connectionStatus'),
        connClearRow: $('connectionClearRow'),
        connClearBtn: $('clearConnBtn'),
        connKeepBtn: $('keepConnBtn'),
        addProfileBtn: $('addProfileBtn'),
        profileList: $('profileList'),
        profileEmpty: $('profileEmpty'),
        confirmBackdrop: $('confirmDeleteBackdrop'),
        confirmBody: $('confirmDeleteBody'),
        confirmCancel: $('confirmDeleteCancel'),
        confirmOk: $('confirmDeleteOk'),
        modalBackdrop: $('profileModalBackdrop'),
        modal: $('profileModal'),
        modalTitle: $('profileModalTitle'),
        pmName: $('pmName'),
        pmFilePath: $('pmFilePath'),
        pmBrowse: $('pmBrowse'),
        pmId: $('pmId'),
        pmTableName: $('pmTableName'),
        pmCancel: $('pmCancel'),
        pmSave: $('pmSave'),
        pmFormError: $('pmFormError')
    };

    // ---- Connection field ----

    function setConnectionStatus(text, kind) {
        els.connStatus.textContent = text;
        els.connStatus.classList.remove('ns-status--success', 'ns-status--error');
        if (kind === 'success') els.connStatus.classList.add('ns-status--success');
        if (kind === 'error') els.connStatus.classList.add('ns-status--error');
        if (state.statusTimer) { clearTimeout(state.statusTimer); state.statusTimer = null; }
        if (kind === 'success') {
            state.statusTimer = setTimeout(() => {
                els.connStatus.textContent = '';
                els.connStatus.classList.remove('ns-status--success');
            }, 1500);
        }
    }

    function showClearConfirm() {
        state.clearConfirmActive = true;
        els.connClearRow.hidden = false;
    }

    function hideClearConfirm() {
        state.clearConfirmActive = false;
        els.connClearRow.hidden = true;
    }

    function maybeSaveConnection() {
        const value = els.connInput.value;
        if (value === state.connectionLoaded) return;
        if (value.trim() === '') {
            if (state.connectionLoaded.trim() !== '') {
                showClearConfirm();
            } else {
                state.connectionLoaded = value;
            }
            return;
        }
        hideClearConfirm();
        setConnectionStatus('Saving…', '');
        vscode.postMessage({ command: 'saveConnectionString', url: value });
    }

    els.connInput.addEventListener('blur', maybeSaveConnection);
    els.connInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            els.connInput.blur();
        }
    });
    els.connInput.addEventListener('input', () => {
        if (state.clearConfirmActive && els.connInput.value.trim() !== '') hideClearConfirm();
    });

    els.connToggle.addEventListener('click', () => {
        const showing = els.connInput.type === 'text';
        els.connInput.type = showing ? 'password' : 'text';
        els.connToggle.textContent = showing ? 'Show' : 'Hide';
        els.connToggle.setAttribute('aria-pressed', showing ? 'false' : 'true');
    });

    els.connClearBtn.addEventListener('click', () => {
        hideClearConfirm();
        setConnectionStatus('Clearing…', '');
        vscode.postMessage({ command: 'clearConnectionString' });
    });
    els.connKeepBtn.addEventListener('click', () => {
        hideClearConfirm();
        els.connInput.value = state.connectionLoaded;
        setConnectionStatus('', '');
    });

    // ---- Profile list rendering ----

    function renderProfiles(profiles) {
        state.profiles = Array.isArray(profiles) ? profiles : [];
        els.profileList.innerHTML = '';
        if (state.profiles.length === 0) {
            els.profileEmpty.hidden = false;
            return;
        }
        els.profileEmpty.hidden = true;
        for (const profile of state.profiles) {
            const li = document.createElement('li');
            li.className = 'ns-profile-card';

            const main = document.createElement('div');
            main.className = 'ns-profile-card__main';
            const nameEl = document.createElement('div');
            nameEl.className = 'ns-profile-card__name';
            nameEl.textContent = profile.name;
            const metaEl = document.createElement('div');
            metaEl.className = 'ns-profile-card__meta';
            metaEl.textContent = profile.filePath + '  ·  ' + profile.tableName;
            metaEl.title = profile.filePath + '  ·  ' + profile.tableName;
            main.appendChild(nameEl);
            main.appendChild(metaEl);

            const actions = document.createElement('div');
            actions.className = 'ns-profile-card__actions';
            const editBtn = document.createElement('button');
            editBtn.type = 'button';
            editBtn.className = 'ns-btn ns-btn--ghost';
            editBtn.textContent = 'Edit';
            editBtn.addEventListener('click', () => openProfileModal(profile));
            const delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.className = 'ns-btn ns-btn--danger';
            delBtn.textContent = 'Delete';
            delBtn.addEventListener('click', () => openDeleteConfirm(profile.name));
            actions.appendChild(editBtn);
            actions.appendChild(delBtn);

            li.appendChild(main);
            li.appendChild(actions);
            els.profileList.appendChild(li);
        }
    }

    // ---- Delete confirmation ----

    let deleteTarget = null;

    function openDeleteConfirm(name) {
        deleteTarget = name;
        els.confirmBody.textContent = 'Delete profile "' + name + '"? This cannot be undone.';
        els.confirmBackdrop.hidden = false;
        setTimeout(() => els.confirmCancel.focus(), 0);
    }

    function closeDeleteConfirm() {
        deleteTarget = null;
        els.confirmBackdrop.hidden = true;
    }

    els.confirmCancel.addEventListener('click', closeDeleteConfirm);
    els.confirmOk.addEventListener('click', () => {
        if (deleteTarget != null) vscode.postMessage({ command: 'deleteProfile', name: deleteTarget });
        closeDeleteConfirm();
    });
    els.confirmBackdrop.addEventListener('click', (e) => {
        if (e.target === els.confirmBackdrop) closeDeleteConfirm();
    });

    // ---- Profile modal ----

    function openProfileModal(existing) {
        state.editingOriginalName = existing ? existing.name : null;
        state.modalDirty = false;
        els.modalTitle.textContent = existing ? 'Edit profile' : 'Add profile';
        els.pmName.value = existing ? existing.name : '';
        els.pmFilePath.value = existing ? existing.filePath : '';
        els.pmId.value = existing ? existing.id : '';
        els.pmTableName.value = existing ? existing.tableName : 'json_records';
        clearFormErrors();
        els.modalBackdrop.hidden = false;
        setTimeout(() => els.pmName.focus(), 0);
    }

    function closeProfileModal(force) {
        if (!force && state.modalDirty) {
            if (!confirm('Discard changes?')) return;
        }
        state.editingOriginalName = null;
        state.modalDirty = false;
        els.modalBackdrop.hidden = true;
        clearFormErrors();
    }

    function readModalValues() {
        return {
            name: els.pmName.value,
            filePath: els.pmFilePath.value,
            id: els.pmId.value,
            tableName: els.pmTableName.value
        };
    }

    function clearFormErrors() {
        for (const input of [els.pmName, els.pmFilePath, els.pmId, els.pmTableName]) {
            input.classList.remove('ns-input--error');
        }
        for (const node of els.modal.querySelectorAll('.ns-error')) {
            node.textContent = '';
            node.hidden = true;
        }
        els.pmFormError.hidden = true;
        els.pmFormError.textContent = '';
    }

    function applyErrors(errors, formError) {
        clearFormErrors();
        const map = {
            name: els.pmName,
            filePath: els.pmFilePath,
            id: els.pmId,
            tableName: els.pmTableName
        };
        let any = false;
        for (const key of Object.keys(map)) {
            const msg = errors && errors[key];
            if (!msg) continue;
            any = true;
            map[key].classList.add('ns-input--error');
            const node = els.modal.querySelector('[data-error-for="' + key + '"]');
            if (node) {
                node.textContent = msg;
                node.hidden = false;
            }
        }
        if (formError) {
            els.pmFormError.textContent = formError;
            els.pmFormError.hidden = false;
        } else if (any) {
            els.pmFormError.textContent = 'Please fix the errors below.';
            els.pmFormError.hidden = false;
        }
    }

    function localValidate(values) {
        const errors = {};
        const name = values.name.trim();
        if (!name) {
            errors.name = 'Name is required.';
        } else {
            const others = state.profiles
                .filter((p) => p.name !== state.editingOriginalName)
                .map((p) => p.name);
            if (others.includes(name)) errors.name = 'A profile with this name already exists.';
        }
        if (!values.filePath.trim()) errors.filePath = 'File path is required.';
        if (!values.id.trim()) errors.id = 'Record ID is required.';
        const tableName = values.tableName.trim();
        if (!tableName) {
            errors.tableName = 'Table name is required.';
        } else if (!TABLE_NAME_RE.test(tableName)) {
            errors.tableName = 'Only letters, numbers, and underscores. Optionally schema.table.';
        }
        return errors;
    }

    els.addProfileBtn.addEventListener('click', () => openProfileModal());
    els.pmCancel.addEventListener('click', () => closeProfileModal(false));
    els.modalBackdrop.addEventListener('click', (e) => {
        if (e.target === els.modalBackdrop) closeProfileModal(false);
    });
    for (const input of [els.pmName, els.pmFilePath, els.pmId, els.pmTableName]) {
        input.addEventListener('input', () => { state.modalDirty = true; });
    }

    els.modal.addEventListener('submit', (e) => {
        e.preventDefault();
        const values = readModalValues();
        const errors = localValidate(values);
        if (Object.keys(errors).length > 0) {
            applyErrors(errors);
            return;
        }
        clearFormErrors();
        vscode.postMessage({
            command: 'saveProfile',
            profile: values,
            originalName: state.editingOriginalName == null ? undefined : state.editingOriginalName
        });
    });

    els.pmBrowse.addEventListener('click', () => {
        vscode.postMessage({ command: 'pickFilePath', currentValue: els.pmFilePath.value });
    });

    // ---- Global keys ----

    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (!els.confirmBackdrop.hidden) { closeDeleteConfirm(); return; }
        if (!els.modalBackdrop.hidden) { closeProfileModal(false); return; }
    });

    // ---- Inbound messages ----

    window.addEventListener('message', (event) => {
        const msg = event.data;
        if (!msg || !msg.command) return;
        switch (msg.command) {
            case 'loadSettings':
                state.connectionLoaded = msg.connectionString || '';
                els.connInput.value = state.connectionLoaded;
                hideClearConfirm();
                setConnectionStatus('', '');
                renderProfiles(msg.profiles || []);
                break;
            case 'connectionStringSaved':
                state.connectionLoaded = typeof msg.url === 'string' ? msg.url : els.connInput.value;
                if (typeof msg.url === 'string') els.connInput.value = msg.url;
                setConnectionStatus('Saved', 'success');
                break;
            case 'connectionStringError':
                setConnectionStatus(msg.error || 'Failed to save URL.', 'error');
                break;
            case 'profilesSaved':
                renderProfiles(msg.profiles || []);
                closeProfileModal(true);
                break;
            case 'profileSaveError':
                applyErrors(msg.errors || {}, msg.formError);
                break;
            case 'filePathPicked':
                if (msg.path) {
                    els.pmFilePath.value = msg.path;
                    state.modalDirty = true;
                }
                break;
            case 'focusField':
                if (msg.field === 'connection') {
                    document.querySelector('[data-section="connection"]')?.scrollIntoView({ block: 'start' });
                    setTimeout(() => els.connInput.focus(), 0);
                }
                break;
            case 'genericError':
                setConnectionStatus(msg.error || 'Unexpected error.', 'error');
                break;
        }
    });

    vscode.postMessage({ command: 'getSettings' });
}());
`;

function getSettingsHtml(ctx: { validatorRegex: string; nonce: string; cspSource: string }): string {
    // Use function-form replace so $ in the regex source isn't interpreted as a
    // back-reference. JSON.stringify produces a valid JS string literal that
    // round-trips backslashes safely (the source uses \. which a naïve substitution
    // would collapse to . in JS).
    const script = SETTINGS_SCRIPT.replace(
        '"__VALIDATOR_REGEX__"',
        () => JSON.stringify(ctx.validatorRegex)
    );
    const csp = [
        `default-src 'none'`,
        `style-src ${ctx.cspSource} 'nonce-${ctx.nonce}'`,
        `script-src 'nonce-${ctx.nonce}'`,
        `font-src ${ctx.cspSource}`
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>Neon Sync Settings</title>
<style nonce="${ctx.nonce}">${SETTINGS_CSS}</style>
</head>
<body>
${SETTINGS_BODY}
<script nonce="${ctx.nonce}">${script}</script>
</body>
</html>`;
}
