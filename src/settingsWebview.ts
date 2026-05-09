import * as vscode from 'vscode';
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
        this._pendingFocus = options.focus;
        // The webview may not have asked for settings yet. Post once now; if
        // the script is still mounting, the listener will re-emit after the
        // initial loadSettings reply (see _setWebviewMessageListener).
        void this._panel.webview.postMessage({ command: 'focusField', field: options.focus });
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
                        await webview.postMessage(await this._handlePickFilePath());
                        break;
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

    private async _handleGetSettings(webview: vscode.Webview): Promise<void> {
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

    private _getHtmlForWebview(_webview: vscode.Webview): string {
        const validatorRegex = PROFILE_TABLENAME_REGEX_SOURCE;
        return getSettingsHtml({ validatorRegex });
    }
}

// Stub HTML — Tasks 9–12 rebuild the macOS-style UI on top of this scaffold.
// The minimum required behavior is that the script posts `getSettings` on
// load so the host's loadSettings reply is exercised; everything else is
// tested via the host-side message protocol.
function getSettingsHtml(_ctx: { validatorRegex: string }): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Neon Sync Settings</title>
</head>
<body>
<p>Settings panel is loading…</p>
<script>
const vscode = acquireVsCodeApi();
vscode.postMessage({ command: 'getSettings' });
</script>
</body>
</html>`;
}
