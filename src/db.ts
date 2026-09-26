import { ConfigManager } from './config';
import { RecordStore } from './core/db';

/**
 * VS Code adapter over `core/db`'s RecordStore: resolves the connection string
 * from SecretStorage, surfaces the "not configured" prompt, and caches one
 * store per connection string (cleared when the string changes).
 */
export class DatabaseService {
    private static readonly storeCache = new Map<string, RecordStore>();
    private static isConnectionStringListenerRegistered = false;

    private static async getConnectionString(): Promise<string> {
        const connectionString = await ConfigManager.getConnectionString();
        if (!connectionString) {
            ConfigManager.promptMissingConnectionString().catch((error) => {
                console.error('Failed to surface missing-URL prompt:', error);
            });
            throw new Error('PostgreSQL connection string is not configured.');
        }
        return connectionString.trim();
    }

    /** The RecordStore for the configured connection; prompts and throws if none is set. */
    static async getRecordStore(): Promise<RecordStore> {
        this.ensureConnectionStringListenerRegistered();

        const connectionString = await this.getConnectionString();
        const cached = this.storeCache.get(connectionString);
        if (cached) {
            return cached;
        }

        const store = new RecordStore(connectionString);
        this.storeCache.set(connectionString, store);
        return store;
    }

    private static ensureConnectionStringListenerRegistered(): void {
        if (this.isConnectionStringListenerRegistered) {
            return;
        }

        ConfigManager.onConnectionStringChanged(() => {
            this.storeCache.clear();
        });
        this.isConnectionStringListenerRegistered = true;
    }
}
