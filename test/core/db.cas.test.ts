import test = require('node:test');
import assert = require('node:assert/strict');
import * as crypto from 'node:crypto';
import { createMockSql, installModuleMocks, purgeProjectModules, resetMocks } from '../helpers/moduleMocks';
import { createPgliteSql } from '../helpers/pgliteSql';
import type { Profile } from '../../src/core/types';

installModuleMocks();

const OLD = '2020-01-01 00:00:00';
const sha256 = (text: string) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

function profile(id: string, overrides: Partial<Profile> = {}): Profile {
    return { name: id, filePath: `${id}.json`, id, tableName: 'records', ...overrides };
}

async function setup(
    seed: Array<[id: string, data: string | null, updateTime: string | null]> = [],
    ddl?: string
) {
    const { neon } = resetMocks();
    purgeProjectModules();
    const db = require('../../src/core/db') as typeof import('../../src/core/db');
    const pg = await createPgliteSql(ddl);
    for (const [id, data, updateTime] of seed) {
        await pg.db.query(
            'INSERT INTO records (id, data, create_time, update_time) VALUES ($1, $2, $3, $3)',
            [id, data, updateTime]
        );
    }
    neon.nextSql = pg.sql;
    const store = new db.RecordStore('postgres://pglite');
    const dataOf = async (id: string) =>
        (await pg.db.query<{ data: string }>('SELECT data FROM records WHERE id = $1', [id])).rows[0]?.data;
    return { ...db, store, dataOf, pg };
}

test('fetch returns a server-computed content hash as the version', async () => {
    const { store } = await setup([['a', 'héllo ✓\n', OLD]]);

    const rec = await store.fetch(profile('a'));

    assert.equal(rec.data, 'héllo ✓\n');
    assert.equal(rec.version, sha256('héllo ✓\n'));
    assert.deepEqual(await store.fetch(profile('missing')), { data: null, updateTime: null, version: null });
});

test('conditionalWrite updates when the version still matches and returns the new version', async () => {
    const { store, dataOf, expectationOf } = await setup([['a', 'A0', OLD]]);
    const before = await store.fetch(profile('a'));

    const version = await store.conditionalWrite(profile('a'), 'A1', expectationOf(before));

    assert.equal(await dataOf('a'), 'A1');
    assert.equal(version, sha256('A1'));
    assert.equal((await store.fetch(profile('a'))).version, version, 'returned version round-trips through fetch');
});

test('conditionalWrite rejects a stale version and writes nothing', async () => {
    const { store, dataOf, StaleRemoteError } = await setup([['a', 'A0', OLD]]);
    const stale = { exists: true, version: sha256('something else') };

    await assert.rejects(store.conditionalWrite(profile('a'), 'A1', stale), (e: unknown) => {
        assert.ok(e instanceof StaleRemoteError);
        assert.deepEqual(e.profiles.map((p) => p.id), ['a']);
        return true;
    });
    assert.equal(await dataOf('a'), 'A0');
});

test('conditionalWrite chains: a second write must use the version returned by the first', async () => {
    const { store, StaleRemoteError, expectationOf } = await setup([['a', 'A0', OLD]]);
    const first = expectationOf(await store.fetch(profile('a')));

    const v1 = await store.conditionalWrite(profile('a'), 'A1', first);

    await assert.rejects(store.conditionalWrite(profile('a'), 'A2', first), StaleRemoteError);
    await store.conditionalWrite(profile('a'), 'A2', { exists: true, version: v1 });
});

test('conditionalWrite inserts when the row is expected absent and still is', async () => {
    const { store, dataOf } = await setup();

    const version = await store.conditionalWrite(profile('b'), 'B0', { exists: false, version: null });

    assert.equal(await dataOf('b'), 'B0');
    assert.equal(typeof version, 'string');
});

test('conditionalWrite rejects when a row expected absent was created meanwhile', async () => {
    const { store, dataOf, StaleRemoteError } = await setup([['b', 'other-machine', OLD]]);

    await assert.rejects(
        store.conditionalWrite(profile('b'), 'B0', { exists: false, version: null }),
        StaleRemoteError
    );
    assert.equal(await dataOf('b'), 'other-machine');
});

test('conditionalWrite rejects when a row expected present was deleted meanwhile', async () => {
    const { store, dataOf, StaleRemoteError } = await setup();

    await assert.rejects(
        store.conditionalWrite(profile('a'), 'A1', { exists: true, version: sha256('A0') }),
        StaleRemoteError
    );
    assert.equal(await dataOf('a'), undefined, 'must not resurrect the row');
});

test('conditionalWrite handles legacy rows whose update_time is NULL', async () => {
    const { store, dataOf, expectationOf } = await setup([['legacy', 'L0', null]]);

    await store.conditionalWrite(profile('legacy'), 'L1', expectationOf(await store.fetch(profile('legacy'))));

    assert.equal(await dataOf('legacy'), 'L1');
});

test('conditionalWrite handles rows whose data is NULL', async () => {
    const { store, dataOf, expectationOf } = await setup([['nul', null, OLD]]);
    const before = await store.fetch(profile('nul'));
    assert.deepEqual([before.data, before.version], ['null', null]);

    await store.conditionalWrite(profile('nul'), 'N1', expectationOf(before));

    assert.equal(await dataOf('nul'), 'N1');
});

test('conditionalWrite detects edits that do not bump update_time (e.g. the Neon console)', async () => {
    const { store, pg, StaleRemoteError, expectationOf } = await setup([['a', 'A0', OLD]]);
    const before = expectationOf(await store.fetch(profile('a')));
    await pg.db.query(`UPDATE records SET data = 'console-edit' WHERE id = 'a'`);

    await assert.rejects(store.conditionalWrite(profile('a'), 'A1', before), StaleRemoteError);
});

test('conditionalWrite detects a second write within the same timestamp tick', async () => {
    const ddl = 'CREATE TABLE records (id TEXT PRIMARY KEY, data TEXT, create_time TIMESTAMP(0), update_time TIMESTAMP(0));';
    const { store, StaleRemoteError, expectationOf } = await setup([['a', 'A0', OLD]], ddl);
    const before = expectationOf(await store.fetch(profile('a')));
    await store.conditionalWrite(profile('a'), 'other-machine', before);

    await assert.rejects(store.conditionalWrite(profile('a'), 'mine', before), StaleRemoteError);
});

test('conditionalWrite allows the write when content changed and changed back (ABA is harmless)', async () => {
    const { store, pg, dataOf, expectationOf } = await setup([['a', 'A0', OLD]]);
    const before = expectationOf(await store.fetch(profile('a')));
    await pg.db.query(`UPDATE records SET data = 'tmp', update_time = now() WHERE id = 'a'`);
    await pg.db.query(`UPDATE records SET data = 'A0', update_time = now() WHERE id = 'a'`);

    await store.conditionalWrite(profile('a'), 'A1', before);

    assert.equal(await dataOf('a'), 'A1');
});

test('conditionalWriteMany is atomic: one stale row commits nothing and only it is reported', async () => {
    const { store, dataOf, StaleRemoteError } = await setup([
        ['a', 'A0', OLD],
        ['b', 'B0', OLD]
    ]);

    await assert.rejects(
        store.conditionalWriteMany([
            { profile: profile('a'), data: 'A1', expected: { exists: true, version: sha256('A0') } },
            { profile: profile('b'), data: 'B1', expected: { exists: true, version: sha256('stale') } },
            { profile: profile('c'), data: 'C1', expected: { exists: false, version: null } }
        ]),
        (e: unknown) => {
            assert.ok(e instanceof StaleRemoteError);
            assert.deepEqual(e.profiles.map((p) => p.id), ['b']);
            return true;
        }
    );
    assert.equal(await dataOf('a'), 'A0');
    assert.equal(await dataOf('b'), 'B0');
    assert.equal(await dataOf('c'), undefined);
});

test('conditionalWriteMany returns versions aligned with input order', async () => {
    const { store } = await setup([['a', 'A0', OLD]]);

    const versions = await store.conditionalWriteMany([
        { profile: profile('new'), data: 'N', expected: { exists: false, version: null } },
        { profile: profile('a'), data: 'A1', expected: { exists: true, version: sha256('A0') } }
    ]);

    assert.equal(versions.length, 2);
    assert.equal(versions[0], (await store.fetch(profile('new'))).version);
    assert.equal(versions[1], (await store.fetch(profile('a'))).version);
});

test('conditionalWrite passes through non-stale database errors unchanged', async () => {
    const { store, StaleRemoteError } = await setup();

    await assert.rejects(
        store.conditionalWrite(profile('a', { tableName: 'no_such_table' }), 'x', { exists: false, version: null }),
        (e: unknown) => {
            assert.ok(!(e instanceof StaleRemoteError));
            assert.equal((e as { code?: string }).code, '42P01');
            return true;
        }
    );
});

test('a division_by_zero not caused by a stale row is passed through, not relabeled stale', async () => {
    const ddl = `CREATE TABLE records (
        id TEXT PRIMARY KEY, data TEXT, create_time TIMESTAMP, update_time TIMESTAMP,
        CHECK (100 / length(data) > 0)
    );`;
    const { store, StaleRemoteError, expectationOf } = await setup([['a', 'A0', OLD]], ddl);
    const before = expectationOf(await store.fetch(profile('a')));

    await assert.rejects(store.conditionalWrite(profile('a'), '', before), (e: unknown) => {
        assert.ok(!(e instanceof StaleRemoteError));
        assert.equal((e as { code?: string }).code, '22012');
        return true;
    });
});

test('conditionalWriteMany rejects two items targeting the same row before issuing SQL', async () => {
    const { neon } = resetMocks();
    purgeProjectModules();
    const { RecordStore } = require('../../src/core/db') as typeof import('../../src/core/db');
    const expected = { exists: false, version: null };

    await assert.rejects(
        new RecordStore('postgres://x').conditionalWriteMany([
            { profile: profile('a', { name: 'first' }), data: '1', expected },
            { profile: profile('a', { name: 'second', tableName: 'RECORDS' }), data: '2', expected }
        ]),
        /Profiles "first" and "second" both target record "a" in RECORDS/
    );
    await assert.rejects(
        new RecordStore('postgres://x').conditionalWriteMany([
            { profile: profile('a', { name: 'bare' }), data: '1', expected },
            { profile: profile('a', { name: 'qualified', tableName: 'public.records' }), data: '2', expected }
        ]),
        /Profiles "bare" and "qualified" both target record "a"/
    );
    assert.deepEqual(neon.calls, []);
});

test('a race undone before the re-read (changed then restored) is retried once and succeeds', async () => {
    const { store, pg, dataOf, expectationOf } = await setup([['a', 'A0', OLD]]);
    const before = expectationOf(await store.fetch(profile('a')));
    // Simulate: another writer's change is visible to our write, then restored before our re-read.
    const realTransaction = pg.sql.transaction;
    let calls = 0;
    pg.sql.transaction = async (queries: unknown[]) => {
        calls += 1;
        if (calls === 1) {
            await pg.db.query(`UPDATE records SET data = 'transient' WHERE id = 'a'`);
            try {
                return await realTransaction(queries);
            } finally {
                await pg.db.query(`UPDATE records SET data = 'A0' WHERE id = 'a'`);
            }
        }
        return realTransaction(queries);
    };

    const version = await store.conditionalWrite(profile('a'), 'A1', before);

    assert.equal(await dataOf('a'), 'A1');
    assert.equal(version, sha256('A1'));
    assert.equal(calls, 3, 'failed write + re-read + one retry');
});

test('conditionalWriteMany sends the CAS statement shapes and parameter lists', async () => {
    const { neon } = resetMocks();
    purgeProjectModules();
    const { RecordStore } = require('../../src/core/db') as typeof import('../../src/core/db');
    const sql = createMockSql();
    sql.transactionResults.push([[{ version: 'v1' }], [{ version: 'v2' }]]);
    neon.nextSql = sql;

    const versions = await new RecordStore('postgres://x').conditionalWriteMany([
        { profile: profile('a'), data: 'A', expected: { exists: true, version: 'h' } },
        { profile: profile('b', { tableName: 'public.records' }), data: 'B', expected: { exists: false, version: null } }
    ]);

    assert.deepEqual(versions, ['v1', 'v2']);
    assert.equal(sql.transactionCalls.length, 1);
    const [upd, ins] = sql.queryCalls;
    assert.match(upd.query, /UPDATE records\s+SET data = \$2, update_time = CURRENT_TIMESTAMP\s+WHERE id = \$1 AND encode\(sha256\(convert_to\(data::text, current_setting\('server_encoding'\)\)\), 'hex'\) IS NOT DISTINCT FROM \$3/);
    assert.deepEqual(upd.params, ['a', 'A', 'h']);
    assert.match(ins.query, /INSERT INTO public\.records .*ON CONFLICT \(id\) DO NOTHING/s);
    assert.deepEqual(ins.params, ['b', 'B']);
    for (const q of [upd.query, ins.query]) {
        assert.match(q, /1 \/ count\(\*\)::int AS cas_ok FROM w/);
    }
});

test('conditionalWriteMany with no items does not open a client', async () => {
    const { neon } = resetMocks();
    purgeProjectModules();
    const { RecordStore } = require('../../src/core/db') as typeof import('../../src/core/db');

    assert.deepEqual(await new RecordStore('postgres://x').conditionalWriteMany([]), []);
    assert.deepEqual(neon.calls, []);
});

test('StaleRemoteError still surfaces with an empty list when the follow-up read fails', async () => {
    const { neon } = resetMocks();
    purgeProjectModules();
    const { RecordStore, StaleRemoteError } = require('../../src/core/db') as typeof import('../../src/core/db');
    const sql = createMockSql();
    let calls = 0;
    sql.transaction = async () => {
        calls += 1;
        throw calls === 1
            ? Object.assign(new Error('division by zero'), { code: '22012' })
            : new Error('network down');
    };
    neon.nextSql = sql;

    await assert.rejects(
        new RecordStore('postgres://x').conditionalWrite(profile('a'), 'A1', { exists: true, version: 'h' }),
        (e: unknown) => {
            assert.ok(e instanceof StaleRemoteError);
            assert.deepEqual(e.profiles, []);
            assert.equal(e.message, 'Remote changed since it was fetched.');
            return true;
        }
    );
});
