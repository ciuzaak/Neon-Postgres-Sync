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
}
