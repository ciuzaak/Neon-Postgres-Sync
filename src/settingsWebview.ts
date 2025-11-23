import * as vscode from 'vscode';
import { ConfigManager, Profile } from './config';

export class SettingsPanel {
    public static currentPanel: SettingsPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private readonly _disposables: vscode.Disposable[] = [];

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
        this._panel = panel;
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._panel.webview.html = this._getHtmlForWebview(this._panel.webview);
        this._setWebviewMessageListener(this._panel.webview);
    }

    public static createOrShow(extensionUri: vscode.Uri) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (SettingsPanel.currentPanel) {
            SettingsPanel.currentPanel._panel.reveal(column);
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
    }

    public dispose() {
        SettingsPanel.currentPanel = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }

    private _setWebviewMessageListener(webview: vscode.Webview) {
        webview.onDidReceiveMessage(
            async (message: any) => {
                const command = message.command;
                const text = message.text;

                switch (command) {
                    case 'getSettings':
                        const connectionString = await ConfigManager.getConnectionString();
                        const profiles = ConfigManager.getProfiles();
                        webview.postMessage({
                            command: 'loadSettings',
                            connectionString: connectionString || '',
                            profiles: profiles
                        });
                        break;
                    case 'saveSettings':
                        const { connectionString: newUrl, profiles: newProfiles } = message.data;
                        await ConfigManager.setConnectionString(newUrl);
                        await ConfigManager.saveProfiles(newProfiles);
                        vscode.window.showInformationMessage('Settings saved!');
                        break;
                }
            },
            undefined,
            this._disposables
        );
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Neon Sync Settings</title>
    <style>
        body { font-family: var(--vscode-font-family); padding: 20px; color: var(--vscode-editor-foreground); background-color: var(--vscode-editor-background); }
        h2 { border-bottom: 1px solid var(--vscode-settings-headerBorder); padding-bottom: 5px; }
        .form-group { margin-bottom: 15px; }
        label { display: block; margin-bottom: 5px; font-weight: bold; }
        input[type="text"], input[type="password"] { width: 100%; padding: 8px; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); }
        button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 8px 16px; cursor: pointer; }
        button:hover { background: var(--vscode-button-hoverBackground); }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; }
        th, td { text-align: left; padding: 8px; border-bottom: 1px solid var(--vscode-settings-dropdownBorder); }
        th { background-color: var(--vscode-editor-lineHighlightBackground); }
        .remove-btn { background: var(--vscode-errorForeground); color: white; padding: 4px 8px; font-size: 12px; }
    </style>
</head>
<body>
    <h2>Connection</h2>
    <div class="form-group">
        <label for="connectionString">PostgreSQL Connection URL</label>
        <input type="password" id="connectionString" placeholder="postgres://user:password@host:port/dbname">
    </div>

    <h2>Profiles</h2>
    <table id="profilesTable">
        <thead>
            <tr>
                <th>Name</th>
                <th>File Path</th>
                <th>ID</th>
                <th>Table Name</th>
                <th>Action</th>
            </tr>
        </thead>
        <tbody></tbody>
    </table>
    <br>
    <button id="addProfileBtn">Add Profile</button>

    <br><br><hr><br>
    <button id="saveBtn" style="width: 100%;">Save Settings</button>

    <script>
        const vscode = acquireVsCodeApi();
        const profilesTableBody = document.querySelector('#profilesTable tbody');
        const addProfileBtn = document.getElementById('addProfileBtn');
        const saveBtn = document.getElementById('saveBtn');
        const connectionStringInput = document.getElementById('connectionString');

        // Initial Load
        vscode.postMessage({ command: 'getSettings' });

        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.command) {
                case 'loadSettings':
                    connectionStringInput.value = message.connectionString;
                    renderProfiles(message.profiles);
                    break;
            }
        });

        function renderProfiles(profiles) {
            profilesTableBody.innerHTML = '';
            profiles.forEach((profile, index) => {
                addProfileRow(profile);
            });
        }

        function addProfileRow(profile = { name: '', filePath: '', id: '', tableName: 'json_records' }) {
            const row = document.createElement('tr');
            row.innerHTML = \`
                <td><input type="text" class="p-name" value="\${profile.name}"></td>
                <td><input type="text" class="p-filePath" value="\${profile.filePath}"></td>
                <td><input type="text" class="p-id" value="\${profile.id}"></td>
                <td><input type="text" class="p-tableName" value="\${profile.tableName}"></td>
                <td><button class="remove-btn" onclick="this.closest('tr').remove()">Remove</button></td>
            \`;
            profilesTableBody.appendChild(row);
        }

        addProfileBtn.addEventListener('click', () => {
            addProfileRow();
        });

        saveBtn.addEventListener('click', () => {
            const profiles = [];
            document.querySelectorAll('#profilesTable tbody tr').forEach(row => {
                profiles.push({
                    name: row.querySelector('.p-name').value,
                    filePath: row.querySelector('.p-filePath').value,
                    id: row.querySelector('.p-id').value,
                    tableName: row.querySelector('.p-tableName').value
                });
            });

            vscode.postMessage({
                command: 'saveSettings',
                data: {
                    connectionString: connectionStringInput.value,
                    profiles: profiles
                }
            });
        });
    </script>
</body>
</html>`;
    }
}
