import * as vscode from 'vscode';
import { ConfigManager } from './config';
import { SyncManager } from './sync';
import { SettingsPanel } from './settingsWebview';

export function activate(context: vscode.ExtensionContext) {
    console.log('Congratulations, your extension "neon-postgres-sync" is now active!');

    ConfigManager.initialize(context);

    let downloadDisposable = vscode.commands.registerCommand('neonSync.downloadFile', async () => {
        const profiles = ConfigManager.getProfiles();
        if (profiles.length === 0) {
            vscode.window.showErrorMessage('No profiles configured. Run "Neon Sync: Open Config File" to configure.');
            return;
        }

        const items = profiles.map(p => ({ label: p.name, description: p.filePath }));
        const selected = await vscode.window.showQuickPick(items, { placeHolder: 'Select profile to download' });
        if (selected) {
            SyncManager.startDownload(selected.label);
        }
    });

    let uploadDisposable = vscode.commands.registerCommand('neonSync.uploadFile', async () => {
        const profiles = ConfigManager.getProfiles();
        if (profiles.length === 0) {
            vscode.window.showErrorMessage('No profiles configured. Run "Neon Sync: Open Config File" to configure.');
            return;
        }

        const items = profiles.map(p => ({ label: p.name, description: p.filePath }));
        const selected = await vscode.window.showQuickPick(items, { placeHolder: 'Select profile to upload' });
        if (selected) {
            SyncManager.startUpload(selected.label);
        }
    });

    let confirmSyncDisposable = vscode.commands.registerCommand('neonSync.confirmSync', async () => {
        await SyncManager.confirmSync();
    });

    let cancelSyncDisposable = vscode.commands.registerCommand('neonSync.cancelSync', async () => {
        await SyncManager.cancelSync();
    });

    let configureUrlDisposable = vscode.commands.registerCommand('neonSync.configureUrl', async () => {
        const url = await vscode.window.showInputBox({
            prompt: 'Enter PostgreSQL Connection URL',
            placeHolder: 'postgres://user:password@host:port/dbname',
            ignoreFocusOut: true
        });

        if (url) {
            await ConfigManager.setConnectionString(url);
            vscode.window.showInformationMessage('Connection URL updated in secure storage.');
        }
    });

    let openConfigDisposable = vscode.commands.registerCommand('neonSync.openConfigFile', async () => {
        await ConfigManager.openConfigFile();
    });

    let openSettingsDisposable = vscode.commands.registerCommand('neonSync.openSettings', () => {
        SettingsPanel.createOrShow(context.extensionUri);
    });

    context.subscriptions.push(downloadDisposable);
    context.subscriptions.push(uploadDisposable);
    context.subscriptions.push(configureUrlDisposable);
    context.subscriptions.push(confirmSyncDisposable);
    context.subscriptions.push(cancelSyncDisposable);
    context.subscriptions.push(openConfigDisposable);
    context.subscriptions.push(openSettingsDisposable);
}

export function deactivate() { }
