import { PGlite } from '@electric-sql/pglite';
import type { MockSql } from './moduleMocks';

export const RECORDS_DDL = `
    CREATE TABLE records (
        id TEXT PRIMARY KEY,
        data TEXT,
        create_time TIMESTAMP,
        update_time TIMESTAMP
    );
`;

interface PendingQuery extends PromiseLike<unknown[]> {
    text: string;
    params: unknown[];
}

/**
 * A stand-in for `neon()`'s HTTP `sql` function backed by an in-process
 * Postgres (PGlite), so SQL is exercised against a real planner/executor.
 * Mirrors the Neon behaviors RecordStore relies on:
 *   - `sql.query()` is lazy: it runs only when awaited, and can instead be
 *     handed to `sql.transaction()`.
 *   - `sql.transaction([...])` is non-interactive: all statements run in one
 *     transaction that rolls back if any statement errors.
 *   - `sql.transaction()` only accepts query objects produced by `sql.query()`
 *     (Neon rejects anything else).
 * Errors keep PGlite's `code` (SQLSTATE), like NeonDbError.
 */
export async function createPgliteSql(ddl: string = RECORDS_DDL): Promise<{ sql: MockSql; db: PGlite }> {
    const db = new PGlite();
    await db.exec(ddl);
    const issued = new WeakSet<object>();

    const sql: MockSql = {
        queryCalls: [],
        transactionCalls: [],
        queryResults: [],
        transactionResults: [],
        query(text: string, params: unknown[] = []): Promise<unknown> {
            sql.queryCalls.push({ query: text, params });
            const pending: PendingQuery = {
                text,
                params,
                then(onFulfilled, onRejected) {
                    return db.query(text, params).then((r) => r.rows).then(onFulfilled, onRejected);
                }
            };
            issued.add(pending);
            return pending as unknown as Promise<unknown>;
        },
        async transaction(queries: unknown[]): Promise<unknown> {
            sql.transactionCalls.push(queries);
            if (!queries.every((q) => typeof q === 'object' && q !== null && issued.has(q))) {
                throw new Error('transaction() expects an array of queries built by sql.query()');
            }
            return db.transaction(async (tx) => {
                const out: unknown[] = [];
                for (const q of queries as PendingQuery[]) {
                    out.push((await tx.query(q.text, q.params)).rows);
                }
                return out;
            });
        }
    };
    return { sql, db };
}
