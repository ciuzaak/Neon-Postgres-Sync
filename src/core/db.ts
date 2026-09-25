import { neon, type NeonQueryFunction } from '@neondatabase/serverless';
import { PROFILE_TABLENAME_RE } from './profileValidation';
import type { FetchedRecord, Profile } from './types';

type QueryRow = Record<string, unknown>;
type HttpSql = NeonQueryFunction<false, false>;

const ID_COLUMN = 'id';
const DATA_COLUMN = 'data';
const CREATE_TIME_COLUMN = 'create_time';
const UPDATE_TIME_COLUMN = 'update_time';

/**
 * Throws unless `tableName` is a plain SQL identifier (optionally
 * `schema.table`). Table names are interpolated as identifiers, so every
 * query path must call this before building SQL.
 */
export function assertValidTableName(tableName: string): void {
    if (!PROFILE_TABLENAME_RE.test(tableName)) {
        throw new Error(`Invalid table name: "${tableName}". Only letters, numbers, and underscores are allowed.`);
    }
}

function isRecord(value: unknown): value is QueryRow {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseQueryRows(result: unknown): QueryRow[] {
    let rows: unknown[] | undefined;

    if (Array.isArray(result)) {
        rows = result;
    } else if (isRecord(result) && Array.isArray((result as { rows?: unknown }).rows)) {
        rows = (result as { rows: unknown[] }).rows;
    }

    if (!rows) {
        throw new Error('Unexpected query response format from HTTP transport.');
    }

    if (!rows.every((row) => isRecord(row))) {
        throw new Error('Unexpected row shape from HTTP transport.');
    }

    return rows as QueryRow[];
}

function parseFetchedRow(row: QueryRow | undefined): FetchedRecord {
    if (!row) {
        return { data: null, updateTime: null };
    }
    const rawData = row[DATA_COLUMN];
    const data = typeof rawData === 'string' ? rawData : JSON.stringify(rawData, null, 2);

    const rawUpdateTime = row[UPDATE_TIME_COLUMN];
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

function selectQuery(tableName: string): string {
    return `SELECT ${DATA_COLUMN}, ${UPDATE_TIME_COLUMN} FROM ${tableName} WHERE ${ID_COLUMN} = $1`;
}

function upsertQuery(tableName: string): string {
    return `
        INSERT INTO ${tableName} (${ID_COLUMN}, ${DATA_COLUMN}, ${CREATE_TIME_COLUMN}, ${UPDATE_TIME_COLUMN})
        VALUES ($1, $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT (${ID_COLUMN})
        DO UPDATE SET ${DATA_COLUMN} = $2, ${UPDATE_TIME_COLUMN} = CURRENT_TIMESTAMP
    `;
}

/**
 * Reads and writes sync records over Neon's HTTP transport. Host-agnostic:
 * callers resolve the connection string (SecretStorage, keychain, env var…)
 * and hand it in. Table names are validated before any client is created.
 */
export class RecordStore {
    private sqlClient: HttpSql | undefined;

    constructor(private readonly connectionString: string) {}

    private get sql(): HttpSql {
        if (!this.sqlClient) {
            this.sqlClient = neon(this.connectionString);
        }
        return this.sqlClient;
    }

    async fetch(profile: Profile): Promise<FetchedRecord> {
        assertValidTableName(profile.tableName);
        const result: unknown = await this.sql.query(selectQuery(profile.tableName), [profile.id]);
        return parseFetchedRow(parseQueryRows(result)[0]);
    }

    async upsert(profile: Profile, data: string): Promise<void> {
        assertValidTableName(profile.tableName);
        await this.sql.query(upsertQuery(profile.tableName), [profile.id, data]);
    }

    /**
     * Fetch records for many profiles in a single HTTP round-trip via
     * a non-interactive transaction. Results are returned aligned with
     * the input order.
     */
    async fetchMany(profiles: Profile[]): Promise<FetchedRecord[]> {
        if (profiles.length === 0) {
            return [];
        }
        for (const profile of profiles) {
            assertValidTableName(profile.tableName);
        }

        const sql = this.sql;
        const results = await sql.transaction(
            profiles.map((profile) => sql.query(selectQuery(profile.tableName), [profile.id]))
        );
        return results.map((result) => parseFetchedRow(parseQueryRows(result)[0]));
    }

    /**
     * Update records for many profiles in a single HTTP round-trip via
     * a non-interactive transaction. Either all writes succeed or none
     * are committed.
     */
    async upsertMany(items: Array<{ profile: Profile; data: string }>): Promise<void> {
        if (items.length === 0) {
            return;
        }
        for (const { profile } of items) {
            assertValidTableName(profile.tableName);
        }

        const sql = this.sql;
        await sql.transaction(
            items.map(({ profile, data }) => sql.query(upsertQuery(profile.tableName), [profile.id, data]))
        );
    }
}
