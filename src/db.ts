import { neon, type NeonQueryFunction } from '@neondatabase/serverless';
import { Profile, ConfigManager } from './config';

type QueryRow = Record<string, unknown>;
type HttpSql = NeonQueryFunction<false, false>;

export interface FetchedRecord {
    data: string | null;
    updateTime: Date | null;
}

export class DatabaseService {
    // Table name is now dynamic from profile
    private static readonly ID_COLUMN = 'id';
    private static readonly DATA_COLUMN = 'data';
    private static readonly CREATE_TIME_COLUMN = 'create_time';
    private static readonly UPDATE_TIME_COLUMN = 'update_time';
    private static readonly sqlCache = new Map<string, HttpSql>();
    private static isConnectionStringListenerRegistered = false;

    /**
     * Validates table name to prevent SQL injection.
     * Allows only valid SQL identifiers: letters, numbers, underscores.
     * Supports schema.table format.
     */
    private static validateTableName(tableName: string): boolean {
        return /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)?$/.test(tableName);
    }

    private static isRecord(value: unknown): value is QueryRow {
        return typeof value === 'object' && value !== null && !Array.isArray(value);
    }

    private static parseQueryRows(result: unknown): QueryRow[] {
        let rows: unknown[] | undefined;

        if (Array.isArray(result)) {
            rows = result;
        } else if (this.isRecord(result) && Array.isArray((result as { rows?: unknown }).rows)) {
            rows = (result as { rows: unknown[] }).rows;
        }

        if (!rows) {
            throw new Error('Unexpected query response format from HTTP transport.');
        }

        if (!rows.every((row) => this.isRecord(row))) {
            throw new Error('Unexpected row shape from HTTP transport.');
        }

        return rows as QueryRow[];
    }

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

    private static async getSql(): Promise<HttpSql> {
        this.ensureConnectionStringListenerRegistered();

        const connectionString = await this.getConnectionString();
        const cached = this.sqlCache.get(connectionString);
        if (cached) {
            return cached;
        }

        const sql = neon(connectionString);
        this.sqlCache.set(connectionString, sql);
        return sql;
    }

    private static ensureConnectionStringListenerRegistered(): void {
        if (this.isConnectionStringListenerRegistered) {
            return;
        }

        ConfigManager.onConnectionStringChanged(() => {
            this.sqlCache.clear();
        });
        this.isConnectionStringListenerRegistered = true;
    }

    private static parseFetchedRow(row: QueryRow | undefined): FetchedRecord {
        if (!row) {
            return { data: null, updateTime: null };
        }
        const rawData = row[this.DATA_COLUMN];
        const data = typeof rawData === 'string' ? rawData : JSON.stringify(rawData, null, 2);

        const rawUpdateTime = row[this.UPDATE_TIME_COLUMN];
        let updateTime: Date | null = null;
        if (rawUpdateTime instanceof Date) {
            updateTime = rawUpdateTime;
        } else if (typeof rawUpdateTime === 'string' || typeof rawUpdateTime === 'number') {
            const parsed = new Date(rawUpdateTime);
            if (!isNaN(parsed.getTime())) {
                updateTime = parsed;
            }
        }

        return { data, updateTime };
    }

    private static async fetchRecordWithMetaViaHttp(
        sql: HttpSql,
        profile: Profile
    ): Promise<FetchedRecord> {
        const query = `SELECT ${this.DATA_COLUMN}, ${this.UPDATE_TIME_COLUMN} FROM ${profile.tableName} WHERE ${this.ID_COLUMN} = $1`;
        const result: unknown = await sql.query(query, [profile.id]);
        const rows = this.parseQueryRows(result);
        return this.parseFetchedRow(rows[0]);
    }

    private static async updateRecordViaHttp(sql: HttpSql, profile: Profile, data: string): Promise<void> {
        // `profile.tableName` is interpolated as an identifier, so we must validate it first.
        const query = `
            INSERT INTO ${profile.tableName} (${this.ID_COLUMN}, ${this.DATA_COLUMN}, ${this.CREATE_TIME_COLUMN}, ${this.UPDATE_TIME_COLUMN})
            VALUES ($1, $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            ON CONFLICT (${this.ID_COLUMN})
            DO UPDATE SET ${this.DATA_COLUMN} = $2, ${this.UPDATE_TIME_COLUMN} = CURRENT_TIMESTAMP
        `;

        await sql.query(query, [profile.id, data]);
    }

    static async fetchRecordWithMeta(profile: Profile): Promise<FetchedRecord> {
        if (!this.validateTableName(profile.tableName)) {
            throw new Error(`Invalid table name: "${profile.tableName}". Only letters, numbers, and underscores are allowed.`);
        }

        try {
            const sql = await this.getSql();
            return await this.fetchRecordWithMetaViaHttp(sql, profile);
        } catch (error) {
            console.error('Error fetching record with meta:', error);
            throw error;
        }
    }

    static async updateRecord(profile: Profile, data: string): Promise<void> {
        if (!this.validateTableName(profile.tableName)) {
            throw new Error(`Invalid table name: "${profile.tableName}". Only letters, numbers, and underscores are allowed.`);
        }

        try {
            const sql = await this.getSql();
            await this.updateRecordViaHttp(sql, profile, data);
        } catch (error) {
            console.error('Error updating record:', error);
            throw error;
        }
    }

    /**
     * Fetch records for many profiles in a single HTTP round-trip via
     * a non-interactive transaction. Results are returned aligned with
     * the input order.
     */
    static async fetchRecordsWithMeta(profiles: Profile[]): Promise<FetchedRecord[]> {
        if (profiles.length === 0) {
            return [];
        }

        for (const profile of profiles) {
            if (!this.validateTableName(profile.tableName)) {
                throw new Error(`Invalid table name: "${profile.tableName}". Only letters, numbers, and underscores are allowed.`);
            }
        }

        try {
            const sql = await this.getSql();
            const queries = profiles.map((profile) =>
                sql.query(
                    `SELECT ${this.DATA_COLUMN}, ${this.UPDATE_TIME_COLUMN} FROM ${profile.tableName} WHERE ${this.ID_COLUMN} = $1`,
                    [profile.id]
                )
            );
            const results = await sql.transaction(queries);

            return results.map((result) => {
                const rows = this.parseQueryRows(result);
                return this.parseFetchedRow(rows[0]);
            });
        } catch (error) {
            console.error('Error fetching records batch:', error);
            throw error;
        }
    }

    /**
     * Update records for many profiles in a single HTTP round-trip via
     * a non-interactive transaction. Either all writes succeed or none
     * are committed.
     */
    static async updateRecords(items: Array<{ profile: Profile; data: string }>): Promise<void> {
        if (items.length === 0) {
            return;
        }

        for (const { profile } of items) {
            if (!this.validateTableName(profile.tableName)) {
                throw new Error(`Invalid table name: "${profile.tableName}". Only letters, numbers, and underscores are allowed.`);
            }
        }

        try {
            const sql = await this.getSql();
            const queries = items.map(({ profile, data }) =>
                sql.query(
                    `
                        INSERT INTO ${profile.tableName} (${this.ID_COLUMN}, ${this.DATA_COLUMN}, ${this.CREATE_TIME_COLUMN}, ${this.UPDATE_TIME_COLUMN})
                        VALUES ($1, $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                        ON CONFLICT (${this.ID_COLUMN})
                        DO UPDATE SET ${this.DATA_COLUMN} = $2, ${this.UPDATE_TIME_COLUMN} = CURRENT_TIMESTAMP
                    `,
                    [profile.id, data]
                )
            );
            await sql.transaction(queries);
        } catch (error) {
            console.error('Error updating records batch:', error);
            throw error;
        }
    }
}
