import * as vscode from 'vscode';
import { ConfigManager, Profile } from './config';
import { SyncManager } from './sync';
import { SettingsPanel } from './settingsWebview';

const PROFILE_ORDER_STATE_KEY = 'neonSync.profileOrder';

export function activate(context: vscode.ExtensionContext) {
    console.log('Congratulations, your extension "neon-postgres-sync" is now active!');

    ConfigManager.initialize(context);
    let profileOrder = context.globalState.get<string[]>(PROFILE_ORDER_STATE_KEY, []);

    const pruneAndPersistProfileOrder = async (profiles: Profile[]): Promise<void> => {
        const profileNames = new Set(profiles.map((p) => p.name));
        const pruned = profileOrder.filter((name) => profileNames.has(name));
        if (pruned.length === profileOrder.length) {
            return;
        }
        profileOrder = pruned;
        await context.globalState.update(PROFILE_ORDER_STATE_KEY, profileOrder);
    };

    const sortProfilesBySavedOrder = async (profiles: Profile[]): Promise<Profile[]> => {
        await pruneAndPersistProfileOrder(profiles);
        const orderIndex = new Map(profileOrder.map((name, index) => [name, index]));

        return [...profiles].sort((a, b) => {
            const aIndex = orderIndex.get(a.name);
            const bIndex = orderIndex.get(b.name);

            if (aIndex === undefined && bIndex === undefined) {
                return 0;
            }
            if (aIndex === undefined) {
                return 1;
            }
            if (bIndex === undefined) {
                return -1;
            }
            return aIndex - bIndex;
        });
    };

    const recordProfileUsage = async (profileName: string, profiles: Profile[]): Promise<void> => {
        const profileNames = new Set(profiles.map((p) => p.name));
        profileOrder = [profileName, ...profileOrder.filter((name) => name !== profileName)];
        profileOrder = profileOrder.filter((name) => profileNames.has(name));
        await context.globalState.update(PROFILE_ORDER_STATE_KEY, profileOrder);
    };

    const downloadDisposable = vscode.commands.registerCommand('neonSync.downloadFile', async () => {
        const profiles = ConfigManager.getProfiles();
        if (profiles.length === 0) {
            vscode.window.showErrorMessage('No profiles configured. Run "Neon Sync: Open Config File" to configure.');
            return;
        }

        // Auto-select if only one profile
        if (profiles.length === 1) {
            await recordProfileUsage(profiles[0].name, profiles);
            await SyncManager.startDownload(profiles[0].name);
            return;
        }

        // MRU ordering: keep persisted profile order across window reloads.
        const sortedProfiles = await sortProfilesBySavedOrder(profiles);

        const items = sortedProfiles.map(p => ({ label: p.name, description: p.filePath }));
        const selected = await vscode.window.showQuickPick(items, { placeHolder: 'Select profile to download' });
        if (selected) {
            await recordProfileUsage(selected.label, profiles);
            await SyncManager.startDownload(selected.label);
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
            await recordProfileUsage(profiles[0].name, profiles);
            await SyncManager.startUpload(profiles[0].name);
            return;
        }

        // MRU ordering: keep persisted profile order across window reloads.
        const sortedProfiles = await sortProfilesBySavedOrder(profiles);

        const items = sortedProfiles.map(p => ({ label: p.name, description: p.filePath }));
        const selected = await vscode.window.showQuickPick(items, { placeHolder: 'Select profile to upload' });
        if (selected) {
            await recordProfileUsage(selected.label, profiles);
            await SyncManager.startUpload(selected.label);
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
