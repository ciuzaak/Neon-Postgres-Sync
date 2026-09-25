import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { CONFIG_FILENAME, ConfigFileParseError, ConfigFileStore } from './core/configFile';
import type { ConfigFile, Profile } from './core/types';

export type { ConfigFile, Profile } from './core/types';

export class ConfigManager {
    private static readonly SECRET_KEY = 'neonSync.connectionString';
    private static globalStorageUri: vscode.Uri | undefined;
    private static secrets: vscode.SecretStorage | undefined;
    private static readonly connectionStringListeners = new Set<() => void>();

    static initialize(context: vscode.ExtensionContext) {
        this.globalStorageUri = context.globalStorageUri;
        this.secrets = context.secrets;

        // Ensure global storage directory exists
        if (!fs.existsSync(this.globalStorageUri.fsPath)) {
            fs.mkdirSync(this.globalStorageUri.fsPath, { recursive: true });
        }
    }

    private static getStore(): ConfigFileStore | undefined {
        if (!this.globalStorageUri) {
            return undefined;
        }
        return new ConfigFileStore(path.join(this.globalStorageUri.fsPath, CONFIG_FILENAME));
    }

    private static readConfig(): ConfigFile | undefined {
        try {
            return this.getStore()?.read();
        } catch (e) {
            if (e instanceof ConfigFileParseError) {
                vscode.window.showErrorMessage(e.message);
                return undefined;
            }
            throw e;
        }
    }

    static getProfiles(): Profile[] {
        const config = this.readConfig();
        return config?.profiles || [];
    }

    static getProfile(name: string): Profile | undefined {
        const profiles = this.getProfiles();
        return profiles.find(p => p.name === name);
    }

    static async getConnectionString(): Promise<string | undefined> {
        // 1. Try SecretStorage
        if (this.secrets) {
            const secret = await this.secrets.get(this.SECRET_KEY);
            if (secret) {
                return secret;
            }
        }

        // 2. Fallback to file (and maybe migrate?)
        const config = this.readConfig();
        if (config?.connectionString) {
            // Auto-migrate to secrets if found in file
            if (this.secrets) {
                await this.secrets.store(this.SECRET_KEY, config.connectionString);
                // Optionally remove from file? Let's keep it simple and just use it.
                // Ideally we should remove it to be secure.
                await this.removeConnectionStringFromFile();
                vscode.window.showInformationMessage('Migrated connection string to secure storage.');
            }
            return config.connectionString;
        }

        return undefined;
    }

    static async setConnectionString(url: string): Promise<void> {
        if (this.secrets) {
            await this.secrets.store(this.SECRET_KEY, url);
            // Ensure it's not in the file
            await this.removeConnectionStringFromFile();
            this.notifyConnectionStringChanged();
        } else {
            vscode.window.showErrorMessage('SecretStorage not initialized.');
        }
    }

    static async clearConnectionString(): Promise<void> {
        if (this.secrets) {
            await this.secrets.delete(this.SECRET_KEY);
        }
        await this.removeConnectionStringFromFile();
        this.notifyConnectionStringChanged();
    }

    static async promptMissingConnectionString(): Promise<void> {
        const choice = await vscode.window.showErrorMessage(
            'PostgreSQL connection string is not configured.',
            'Open Settings'
        );
        if (choice === 'Open Settings') {
            await vscode.commands.executeCommand('neonSync.openSettings', { focus: 'connection' });
        }
    }

    static onConnectionStringChanged(listener: () => void): vscode.Disposable {
        this.connectionStringListeners.add(listener);
        return new vscode.Disposable(() => {
            this.connectionStringListeners.delete(listener);
        });
    }

    private static notifyConnectionStringChanged() {
        for (const listener of this.connectionStringListeners) {
            try {
                listener();
            } catch (error) {
                console.error('Error in connection string change listener:', error);
            }
        }
    }

    private static async removeConnectionStringFromFile() {
        try {
            this.getStore()?.removeConnectionString();
        } catch (e) {
            if (!(e instanceof ConfigFileParseError)) throw e;
            vscode.window.showErrorMessage(e.message);
        }
    }

    static async saveProfiles(profiles: Profile[]): Promise<void> {
        const store = this.getStore();
        if (!store) {
            vscode.window.showErrorMessage('Extension not initialized correctly.');
            return;
        }

        // readConfig surfaces a parse error and falls back to an empty base,
        // matching the pre-core behavior of overwriting a corrupt file.
        store.saveProfiles(profiles, this.readConfig() ?? { profiles: [] });
    }

    static async openConfigFile(): Promise<void> {
        const store = this.getStore();
        if (!store) {
            vscode.window.showErrorMessage('Extension not initialized correctly.');
            return;
        }

        const created = store.ensureExists({
            profiles: [
                {
                    name: "Example Profile",
                    filePath: "example.json",
                    id: "example-id",
                    tableName: "json_records"
                }
            ]
        });
        if (created) {
            vscode.window.showInformationMessage(`Created ${CONFIG_FILENAME} in global storage.`);
        }

        // Open the file
        const doc = await vscode.workspace.openTextDocument(store.filePath);
        await vscode.window.showTextDocument(doc);
    }
}
