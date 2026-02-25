import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export interface Profile {
    name: string;
    filePath: string;
    id: string;
    tableName: string;
}

export interface ConfigFile {
    connectionString?: string; // Deprecated, but kept for migration/fallback
    profiles: Profile[];
}

export class ConfigManager {
    private static readonly CONFIG_FILENAME = 'neon-sync.json';
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

    private static getConfigPath(): string | undefined {
        if (!this.globalStorageUri) {
            return undefined;
        }
        return path.join(this.globalStorageUri.fsPath, this.CONFIG_FILENAME);
    }

    private static readConfig(): ConfigFile | undefined {
        const configPath = this.getConfigPath();
        if (configPath && fs.existsSync(configPath)) {
            try {
                const content = fs.readFileSync(configPath, 'utf-8');
                return JSON.parse(content);
            } catch (e) {
                vscode.window.showErrorMessage(`Failed to parse ${this.CONFIG_FILENAME}: ${e}`);
            }
        }
        return undefined;
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
        const configPath = this.getConfigPath();
        if (configPath && fs.existsSync(configPath)) {
            const config = this.readConfig();
            if (config && config.connectionString) {
                delete config.connectionString;
                fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
            }
        }
    }

    static async saveProfiles(profiles: Profile[]): Promise<void> {
        const configPath = this.getConfigPath();
        if (!configPath) {
            vscode.window.showErrorMessage('Extension not initialized correctly.');
            return;
        }

        let config: ConfigFile = { profiles: [] };
        if (fs.existsSync(configPath)) {
            config = this.readConfig() || { profiles: [] };
        }
        config.profiles = profiles;
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    }

    static async openConfigFile(): Promise<void> {
        const configPath = this.getConfigPath();
        if (!configPath) {
            vscode.window.showErrorMessage('Extension not initialized correctly.');
            return;
        }

        if (!fs.existsSync(configPath)) {
            const initialConfig: ConfigFile = {
                profiles: [
                    {
                        name: "Example Profile",
                        filePath: "example.json",
                        id: "example-id",
                        tableName: "json_records"
                    }
                ]
            };
            fs.writeFileSync(configPath, JSON.stringify(initialConfig, null, 2));
            vscode.window.showInformationMessage(`Created ${this.CONFIG_FILENAME} in global storage.`);
        }

        // Open the file
        const doc = await vscode.workspace.openTextDocument(configPath);
        await vscode.window.showTextDocument(doc);
    }
}
