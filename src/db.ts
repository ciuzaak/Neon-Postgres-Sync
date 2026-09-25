import { ConfigManager } from './config';
import { RecordStore, assertValidTableName } from './core/db';
import type { FetchedRecord, Profile } from './core/types';

export type { FetchedRecord } from './core/types';

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

    private static async getStore(): Promise<RecordStore> {
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

    static async fetchRecordWithMeta(profile: Profile): Promise<FetchedRecord> {
        // Validate before resolving the connection string so a bad profile
        // fails fast instead of triggering the missing-URL prompt.
        assertValidTableName(profile.tableName);
        try {
            return await (await this.getStore()).fetch(profile);
        } catch (error) {
            console.error('Error fetching record with meta:', error);
            throw error;
        }
    }

    static async updateRecord(profile: Profile, data: string): Promise<void> {
        assertValidTableName(profile.tableName);
        try {
            await (await this.getStore()).upsert(profile, data);
        } catch (error) {
            console.error('Error updating record:', error);
            throw error;
        }
    }

    static async fetchRecordsWithMeta(profiles: Profile[]): Promise<FetchedRecord[]> {
        if (profiles.length === 0) {
            return [];
        }
        profiles.forEach((p) => assertValidTableName(p.tableName));
        try {
            return await (await this.getStore()).fetchMany(profiles);
        } catch (error) {
            console.error('Error fetching records batch:', error);
            throw error;
        }
    }

    static async updateRecords(items: Array<{ profile: Profile; data: string }>): Promise<void> {
        if (items.length === 0) {
            return;
        }
        items.forEach(({ profile }) => assertValidTableName(profile.tableName));
        try {
            await (await this.getStore()).upsertMany(items);
        } catch (error) {
            console.error('Error updating records batch:', error);
            throw error;
        }
    }
}
