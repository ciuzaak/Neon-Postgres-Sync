export interface Profile {
    name: string;
    filePath: string;
    id: string;
    tableName: string;
    excludeKeys?: string[];
}

export interface ConfigFile {
    connectionString?: string; // Deprecated, but kept for migration/fallback
    profiles: Profile[];
}

export type SyncDirection = 'download' | 'upload';

export interface FetchedRecord {
    data: string | null;
    updateTime: Date | null;
    /**
     * Opaque optimistic-concurrency token: a server-computed sha256 of the
     * row's content. Null when the row is absent or its data is NULL.
     * Only ever compared or sent back, never interpreted client-side.
     */
    version: string | null;
}
