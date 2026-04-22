import * as vscode from 'vscode';
import { ConfigManager, Profile } from './config';
import { SyncManager } from './sync';
import { MultiSyncManager } from './multiSync';
import { SettingsPanel } from './settingsWebview';

const PROFILE_ORDER_STATE_KEY = 'neonSync.profileOrder';
const MULTI_SELECT_KEY = '__neonSync.multiSelect';
const MULTI_PICKER_CONTEXT_KEY = 'neonSync.multiPickerActive';

interface QuickItem extends vscode.QuickPickItem {
    sortKey: string;
    isMultiSelect: boolean;
}

interface ProfilePickItem extends vscode.QuickPickItem {
    profile: Profile;
}

let currentMultiPicker: vscode.QuickPick<ProfilePickItem> | null = null;

/**
 * Filter items by the picker's current search query using case-insensitive
 * substring matching against label and description — a close-enough
 * approximation of the native QuickPick filter (VS Code doesn't expose its
 * filtered-items list to the extension host).
 */
function filterItemsByQuery(items: readonly ProfilePickItem[], query: string): ProfilePickItem[] {
    const q = query.trim().toLowerCase();
    if (!q) return [...items];
    return items.filter((item) => {
        const label = (item.label ?? '').toLowerCase();
        const description = (item.description ?? '').toLowerCase();
        return label.includes(q) || description.includes(q);
    });
}

function toggleSelectAllInMultiPicker(): void {
    const qp = currentMultiPicker;
    if (!qp) return;

    const visible = filterItemsByQuery(qp.items, qp.value);
    if (visible.length === 0) return;

    const selected = new Set(qp.selectedItems);
    const allVisibleSelected = visible.every((item) => selected.has(item));

    if (allVisibleSelected) {
        // Deselect every visible item, preserving selections outside the current filter.
        const visibleSet = new Set(visible);
        qp.selectedItems = qp.selectedItems.filter((item) => !visibleSet.has(item));
    } else {
        // Add every visible item to the existing selection.
        const next = new Set(qp.selectedItems);
        for (const item of visible) next.add(item);
        qp.selectedItems = qp.items.filter((item) => next.has(item));
    }
}

export function activate(context: vscode.ExtensionContext) {
    console.log('Congratulations, your extension "neon-postgres-sync" is now active!');

    ConfigManager.initialize(context);
    let profileOrder = context.globalState.get<string[]>(PROFILE_ORDER_STATE_KEY, []);

    const validKeys = (profiles: Profile[]): Set<string> => {
        const keys = new Set<string>(profiles.map((p) => p.name));
        keys.add(MULTI_SELECT_KEY);
        return keys;
    };

    const pruneAndPersistProfileOrder = async (profiles: Profile[]): Promise<void> => {
        const keys = validKeys(profiles);
        const pruned = profileOrder.filter((name) => keys.has(name));
        if (pruned.length === profileOrder.length) {
            return;
        }
        profileOrder = pruned;
        await context.globalState.update(PROFILE_ORDER_STATE_KEY, profileOrder);
    };

    const sortItemsBySavedOrder = async <T extends { sortKey: string }>(
        items: T[],
        profiles: Profile[]
    ): Promise<T[]> => {
        await pruneAndPersistProfileOrder(profiles);
        const orderIndex = new Map(profileOrder.map((name, index) => [name, index]));

        return [...items].sort((a, b) => {
            const aIndex = orderIndex.get(a.sortKey);
            const bIndex = orderIndex.get(b.sortKey);

            if (aIndex === undefined && bIndex === undefined) return 0;
            if (aIndex === undefined) return 1;
            if (bIndex === undefined) return -1;
            return aIndex - bIndex;
        });
    };

    const recordUsage = async (sortKey: string, profiles: Profile[]): Promise<void> => {
        const keys = validKeys(profiles);
        profileOrder = [sortKey, ...profileOrder.filter((name) => name !== sortKey)];
        profileOrder = profileOrder.filter((name) => keys.has(name));
        await context.globalState.update(PROFILE_ORDER_STATE_KEY, profileOrder);
    };

    const buildQuickItems = (profiles: Profile[]): QuickItem[] => {
        const profileItems: QuickItem[] = profiles.map((p) => ({
            label: p.name,
            description: p.filePath,
            sortKey: p.name,
            isMultiSelect: false
        }));

        const multiItem: QuickItem = {
            label: '$(checklist) Sync Multiple Profiles…',
            description: 'Pick several profiles and sync them in one pass',
            sortKey: MULTI_SELECT_KEY,
            isMultiSelect: true
        };

        return [...profileItems, multiItem];
    };

    const pickMultipleProfiles = async (profiles: Profile[]): Promise<Profile[] | undefined> => {
        const sorted = await sortItemsBySavedOrder(
            profiles.map((p) => ({ sortKey: p.name, profile: p })),
            profiles
        );
        const items: ProfilePickItem[] = sorted.map(({ profile }) => ({
            label: profile.name,
            description: profile.filePath,
            profile
        }));

        const qp = vscode.window.createQuickPick<ProfilePickItem>();
        qp.canSelectMany = true;
        qp.items = items;
        qp.title = 'Sync Multiple Profiles';
        qp.placeholder = 'Space toggles, Enter confirms, Alt+A toggles Select All';
        const selectAllButton: vscode.QuickInputButton = {
            iconPath: new vscode.ThemeIcon('check-all'),
            tooltip: 'Select / Deselect All (Alt+A)'
        };
        qp.buttons = [selectAllButton];

        return new Promise<Profile[] | undefined>((resolve) => {
            const disposables: vscode.Disposable[] = [];
            let settled = false;
            const finish = (value: Profile[] | undefined) => {
                if (settled) return;
                settled = true;
                resolve(value);
            };

            disposables.push(qp.onDidTriggerButton((btn) => {
                if (btn === selectAllButton) toggleSelectAllInMultiPicker();
            }));
            disposables.push(qp.onDidAccept(() => {
                const picks = qp.selectedItems.map((i) => i.profile);
                finish(picks.length === 0 ? undefined : picks);
                qp.hide();
            }));
            disposables.push(qp.onDidHide(() => {
                finish(undefined);
                for (const d of disposables) d.dispose();
                qp.dispose();
                currentMultiPicker = null;
                void vscode.commands.executeCommand('setContext', MULTI_PICKER_CONTEXT_KEY, false);
            }));

            currentMultiPicker = qp;
            void vscode.commands.executeCommand('setContext', MULTI_PICKER_CONTEXT_KEY, true);
            qp.show();
        });
    };

    const syncDisposable = vscode.commands.registerCommand('neonSync.syncFile', async () => {
        if (MultiSyncManager.isActive()) {
            vscode.window.showInformationMessage('A multi-profile sync panel is already open.');
            return;
        }

        const profiles = ConfigManager.getProfiles();
        if (profiles.length === 0) {
            vscode.window.showErrorMessage('No profiles configured. Run "Neon Sync: Open Config File" to configure.');
            return;
        }

        if (profiles.length === 1) {
            await recordUsage(profiles[0].name, profiles);
            await SyncManager.startSync(profiles[0].name);
            return;
        }

        const items = buildQuickItems(profiles);
        const sortedItems = await sortItemsBySavedOrder(items, profiles);
        const selected = await vscode.window.showQuickPick<QuickItem>(sortedItems, {
            placeHolder: 'Select profile to sync, or choose Sync Multiple Profiles…'
        });
        if (!selected) return;

        if (selected.isMultiSelect) {
            await recordUsage(MULTI_SELECT_KEY, profiles);
            const picks = await pickMultipleProfiles(profiles);
            if (!picks) return;
            for (const p of picks) {
                await recordUsage(p.name, profiles);
            }
            await MultiSyncManager.start(picks.map((p) => p.name));
            return;
        }

        await recordUsage(selected.sortKey, profiles);
        await SyncManager.startSync(selected.sortKey);
    });

    const swapDirectionDisposable = vscode.commands.registerCommand('neonSync.swapSyncDirection', async () => {
        await SyncManager.swapSyncDirection();
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

    const multiPickerSelectAllDisposable = vscode.commands.registerCommand(
        'neonSync.multiPickerSelectAll',
        toggleSelectAllInMultiPicker
    );

    context.subscriptions.push(syncDisposable);
    context.subscriptions.push(swapDirectionDisposable);
    context.subscriptions.push(configureUrlDisposable);
    context.subscriptions.push(confirmSyncDisposable);
    context.subscriptions.push(cancelSyncDisposable);
    context.subscriptions.push(openConfigDisposable);
    context.subscriptions.push(openSettingsDisposable);
    context.subscriptions.push(multiPickerSelectAllDisposable);
}

export function deactivate() { }
