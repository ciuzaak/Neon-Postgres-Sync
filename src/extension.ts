import * as vscode from 'vscode';
import { ConfigManager } from './config';
import { SyncManager } from './sync';
import { SettingsPanel } from './settingsWebview';

// Track last used profile for MRU ordering
let lastUsedProfile: string | undefined;

export function activate(context: vscode.ExtensionContext) {
    console.log('Congratulations, your extension "neon-postgres-sync" is now active!');

    ConfigManager.initialize(context);

    const downloadDisposable = vscode.commands.registerCommand('neonSync.downloadFile', async () => {
        const profiles = ConfigManager.getProfiles();
        if (profiles.length === 0) {
            vscode.window.showErrorMessage('No profiles configured. Run "Neon Sync: Open Config File" to configure.');
            return;
        }

        // Auto-select if only one profile
        if (profiles.length === 1) {
            lastUsedProfile = profiles[0].name;
            SyncManager.startDownload(profiles[0].name);
            return;
        }

        // MRU ordering: put last used profile first
        const sortedProfiles = [...profiles].sort((a, b) => {
            if (a.name === lastUsedProfile) return -1;
            if (b.name === lastUsedProfile) return 1;
            return 0;
        });

        const items = sortedProfiles.map(p => ({ label: p.name, description: p.filePath }));
        const selected = await vscode.window.showQuickPick(items, { placeHolder: 'Select profile to download' });
        if (selected) {
            lastUsedProfile = selected.label;
            SyncManager.startDownload(selected.label);
        }
    });

    const uploadDisposable = vscode.commands.registerCommand('neonSync.uploadFile', async () => {
        const profiles = ConfigManager.getProfiles();
        if (profiles.length === 0) {
            vscode.window.showErrorMessage('No profiles configured. Run "Neon Sync: Open Config File" to configure.');
            return;
        }

        // Auto-select if only one profile
        if (profiles.length === 1) {
            lastUsedProfile = profiles[0].name;
            SyncManager.startUpload(profiles[0].name);
            return;
        }

        // MRU ordering: put last used profile first
        const sortedProfiles = [...profiles].sort((a, b) => {
            if (a.name === lastUsedProfile) return -1;
            if (b.name === lastUsedProfile) return 1;
            return 0;
        });

        const items = sortedProfiles.map(p => ({ label: p.name, description: p.filePath }));
        const selected = await vscode.window.showQuickPick(items, { placeHolder: 'Select profile to upload' });
        if (selected) {
            lastUsedProfile = selected.label;
            SyncManager.startUpload(selected.label);
        }
    });

    const confirmSyncDisposable = vscode.commands.registerCommand('neonSync.confirmSync', async () => {
        await SyncManager.confirmSync();
    });

    const cancelSyncDisposable = vscode.commands.registerCommand('neonSync.cancelSync', async () => {
        await SyncManager.cancelSync();
    });

    const configureUrlDisposable = vscode.commands.registerCommand('neonSync.configureUrl', async () => {
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

    const openConfigDisposable = vscode.commands.registerCommand('neonSync.openConfigFile', async () => {
        await ConfigManager.openConfigFile();
    });

    const openSettingsDisposable = vscode.commands.registerCommand('neonSync.openSettings', () => {
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
