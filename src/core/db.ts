import { neon, type NeonQueryFunction } from '@neondatabase/serverless';
import { PROFILE_TABLENAME_RE } from './profileValidation';
import type { FetchedRecord, Profile } from './types';

type QueryRow = Record<string, unknown>;
type HttpSql = NeonQueryFunction<false, false>;

const ID_COLUMN = 'id';
const DATA_COLUMN = 'data';
const CREATE_TIME_COLUMN = 'create_time';
const UPDATE_TIME_COLUMN = 'update_time';
const VERSION_ALIAS = 'version';
const STORED_ALIAS = 'stored';
// Content-derived version token, computed server-side. Deliberately NOT based
// on update_time: its ::text form depends on the column's precision (two
// writes in one second collide under timestamp(0)) and, for timestamptz, on
// the session TimeZone; and writers that skip update_time (the Neon console)
// would go unnoticed. A content hash has none of these problems, and ABA is
// harmless here — if the remote holds exactly what the user reviewed,
// overwriting it loses nothing. `::text` also covers json/jsonb data columns.
// sha256 rather than md5: md5() errors on FIPS-mode servers, and this
// expression is on every fetch. Bytes are taken in the server's own encoding
// (a no-op conversion that can't fail), not forced to UTF8, which would error
// on non-UTF8 bytes in e.g. a SQL_ASCII database. NULL data yields a NULL token.
const VERSION_EXPR = `encode(sha256(convert_to(${DATA_COLUMN}::text, current_setting('server_encoding'))), 'hex')`;
const STALE_SQLSTATE = '22012'; // division_by_zero — raised by the CAS sentinel below

/** What the caller last saw on the remote side; a conditional write succeeds only if it still holds. */
export interface RemoteExpectation {
    exists: boolean;
    /** `FetchedRecord.version` as fetched. Ignored when `exists` is false. */
    version: string | null;
}

export function expectationOf(record: FetchedRecord): RemoteExpectation {
    return { exists: record.data !== null, version: record.version };
}

/**
 * A conditional write found the remote row changed since it was fetched.
 * Nothing in the batch was committed. `profiles` lists the rows confirmed
 * stale by a follow-up read; it is empty only when that read itself failed
 * (staleness is then likely but unconfirmed).
 */
export class StaleRemoteError extends Error {
    constructor(public readonly profiles: Profile[]) {
        super(
            profiles.length > 0
                ? `Remote changed since it was fetched: ${profiles.map((p) => p.name).join(', ')}.`
                : 'Remote changed since it was fetched.'
        );
        this.name = 'StaleRemoteError';
    }
}

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
        return { data: null, updateTime: null, version: null };
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

    const rawVersion = row[VERSION_ALIAS];
    const version = typeof rawVersion === 'string' ? rawVersion : null;

    return { data, updateTime, version };
}

/**
 * `data::text` so the driver hands back the column's text verbatim for text
 * and json columns (it would otherwise parse json/jsonb, and re-serializing
 * rewrites the user's content: `1.0` → `1`, key order, formatting). jsonb
 * has no verbatim text; `::text` is its canonical form.
 */
function selectQuery(tableName: string): string {
    return `SELECT ${DATA_COLUMN}::text AS ${DATA_COLUMN}, ${UPDATE_TIME_COLUMN}, ${VERSION_EXPR} AS ${VERSION_ALIAS} FROM ${tableName} WHERE ${ID_COLUMN} = $1`;
}

/**
 * Compare-and-swap write. The data-modifying CTE affects 0 or 1 rows; the
 * outer aggregate always yields exactly one row, so `1 / count(*)` raises
 * division_by_zero when the expectation no longer holds. That error is what
 * makes a non-interactive (HTTP) transaction roll back the whole batch — a
 * zero-row UPDATE alone would commit silently.
 *
 * - Row expected to exist: update only if its content hash still matches
 *   (`IS NOT DISTINCT FROM` so rows whose data is NULL work).
 * - Row expected absent: insert only if nobody created it meanwhile.
 *
 * Params: $1 id, $2 data, $3 expected version (update form only).
 */
function conditionalWriteQuery(tableName: string, expectExists: boolean): string {
    const write = expectExists
        ? `UPDATE ${tableName}
               SET ${DATA_COLUMN} = $2, ${UPDATE_TIME_COLUMN} = CURRENT_TIMESTAMP
               WHERE ${ID_COLUMN} = $1 AND ${VERSION_EXPR} IS NOT DISTINCT FROM $3
               RETURNING ${VERSION_EXPR} AS ${VERSION_ALIAS}, ${DATA_COLUMN}::text AS ${STORED_ALIAS}`
        : `INSERT INTO ${tableName} (${ID_COLUMN}, ${DATA_COLUMN}, ${CREATE_TIME_COLUMN}, ${UPDATE_TIME_COLUMN})
               VALUES ($1, $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
               ON CONFLICT (${ID_COLUMN}) DO NOTHING
               RETURNING ${VERSION_EXPR} AS ${VERSION_ALIAS}, ${DATA_COLUMN}::text AS ${STORED_ALIAS}`;
    return `
        WITH w AS (${write})
        SELECT max(${VERSION_ALIAS}) AS ${VERSION_ALIAS}, max(${STORED_ALIAS}) AS ${STORED_ALIAS}, 1 / count(*)::int AS cas_ok FROM w
    `;
}

function conditionalWriteParams(profile: Profile, data: string, expected: RemoteExpectation): unknown[] {
    return expected.exists ? [profile.id, data, expected.version] : [profile.id, data];
}

/** What a conditional write left in the row. */
export interface WrittenRecord {
    version: string;
    /**
     * The row's content as stored, read back as `data::text` — identical to
     * what was sent for text/json columns, canonicalized for jsonb. Record
     * baselines from this, not from the bytes sent, so they match the next fetch.
     */
    data: string;
}

function parseWritten(result: unknown): WrittenRecord {
    const row = parseQueryRows(result)[0];
    const version = row?.[VERSION_ALIAS];
    const data = row?.[STORED_ALIAS];
    if (typeof version !== 'string' || typeof data !== 'string') {
        throw new Error('Unexpected conditional write response from HTTP transport.');
    }
    return { version, data };
}

/**
 * Two items addressing the same row can't both be conditional on the same
 * version: the first write changes it, so the second would always look stale.
 * Keyed on the unqualified, lowercased table name: `records` and
 * `public.records` usually name the same table (and unquoted identifiers are
 * case-insensitive). Same-named tables in two schemas are rejected too — a
 * false positive whose only cost is "sync them separately".
 */
function assertNoDuplicateRows(items: Array<{ profile: Profile }>): void {
    const seen = new Map<string, Profile>();
    for (const { profile } of items) {
        const table = profile.tableName.toLowerCase().split('.').pop()!;
        const key = `${table}\u0000${profile.id}`;
        const first = seen.get(key);
        if (first) {
            throw new Error(
                `Profiles "${first.name}" and "${profile.name}" both target record "${profile.id}" in ${profile.tableName}; sync them separately.`
            );
        }
        seen.set(key, profile);
    }
}

function isStaleSentinel(error: unknown): boolean {
    return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === STALE_SQLSTATE;
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

    /** One round trip (`SELECT 1`): checks the URL, credentials and network. */
    async ping(): Promise<void> {
        parseQueryRows(await this.sql.query('SELECT 1 AS ok', []));
    }

    async fetch(profile: Profile): Promise<FetchedRecord> {
        assertValidTableName(profile.tableName);
        const result: unknown = await this.sql.query(selectQuery(profile.tableName), [profile.id]);
        return parseFetchedRow(parseQueryRows(result)[0]);
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
     * Write `data` only if the remote row still matches `expected`. Returns
     * the row's new version and stored content. Throws StaleRemoteError
     * (nothing written) otherwise.
     */
    async conditionalWrite(profile: Profile, data: string, expected: RemoteExpectation): Promise<WrittenRecord> {
        const [written] = await this.conditionalWriteMany([{ profile, data, expected }]);
        return written;
    }

    /**
     * Conditional writes for many profiles in one atomic HTTP transaction:
     * if any row is stale, none are committed and StaleRemoteError names the
     * stale rows. Returns what each row now holds, aligned with the input order.
     */
    async conditionalWriteMany(
        items: Array<{ profile: Profile; data: string; expected: RemoteExpectation }>
    ): Promise<WrittenRecord[]> {
        if (items.length === 0) {
            return [];
        }
        for (const { profile } of items) {
            assertValidTableName(profile.tableName);
        }
        assertNoDuplicateRows(items);

        const sql = this.sql;
        const attempt = () => sql.transaction(
            items.map(({ profile, data, expected }) =>
                sql.query(
                    conditionalWriteQuery(profile.tableName, expected.exists),
                    conditionalWriteParams(profile, data, expected)
                )
            )
        );

        // At most two attempts. After a sentinel hit, a re-read that finds
        // nothing stale means either a race already undone (another writer
        // changed the row and restored it — or created and deleted it — within
        // one round trip) or a division_by_zero from elsewhere (a user trigger
        // or CHECK). One retry tells them apart: the race resolves, the other
        // cause fails again and is rethrown as-is, not relabeled stale.
        for (let tries = 1; ; tries++) {
            try {
                return (await attempt()).map(parseWritten);
            } catch (error) {
                if (!isStaleSentinel(error)) throw error;
                const stale = await this.findStale(items);
                if (stale === undefined) throw new StaleRemoteError([]);
                if (stale.length > 0) throw new StaleRemoteError(stale);
                if (tries >= 2) throw error;
            }
        }
    }

    /** Which items no longer match their expectation; undefined if the re-read fails. */
    private async findStale(
        items: Array<{ profile: Profile; expected: RemoteExpectation }>
    ): Promise<Profile[] | undefined> {
        let current: FetchedRecord[];
        try {
            current = await this.fetchMany(items.map((i) => i.profile));
        } catch {
            return undefined;
        }
        return items
            .filter(({ expected }, idx) => {
                const now = expectationOf(current[idx]);
                return now.exists !== expected.exists || (expected.exists && now.version !== expected.version);
            })
            .map((i) => i.profile);
    }
}
