import test = require('node:test');
import assert = require('node:assert/strict');
import { createMockSql, installModuleMocks, purgeProjectModules, resetMocks } from '../helpers/moduleMocks';
import type { Profile } from '../../src/core/types';

installModuleMocks();

function loadCoreDb() {
    const { neon } = resetMocks();
    purgeProjectModules();
    const db = require('../../src/core/db') as typeof import('../../src/core/db');
    return { ...db, neon };
}

function profile(overrides: Partial<Profile> = {}): Profile {
    return { name: 'alpha', filePath: 'alpha.json', id: 'row-1', tableName: 'records', ...overrides };
}

test('RecordStore does not create a client until the first query', () => {
    const { RecordStore, neon } = loadCoreDb();

    new RecordStore('postgres://example');

    assert.deepEqual(neon.calls, []);
});

test('RecordStore rejects unsafe table names before creating a client', async () => {
    const { RecordStore, neon } = loadCoreDb();
    const store = new RecordStore('postgres://example');

    await assert.rejects(store.fetch(profile({ tableName: 'x; drop table y' })), /Invalid table name/);
    await assert.rejects(store.upsertMany([{ profile: profile({ tableName: 'a.b.c' }), data: '' }]), /Invalid table name/);
    assert.deepEqual(neon.calls, []);
});

test('RecordStore reuses one client across queries', async () => {
    const { RecordStore, neon } = loadCoreDb();
    const sql = createMockSql();
    neon.nextSql = sql;
    const store = new RecordStore('postgres://example');

    await store.fetch(profile());
    await store.upsert(profile(), 'x');

    assert.deepEqual(neon.calls, ['postgres://example']);
    assert.equal(sql.queryCalls.length, 2);
});

test('RecordStore.fetchMany returns results aligned with input order', async () => {
    const { RecordStore, neon } = loadCoreDb();
    const sql = createMockSql();
    sql.transactionResults.push([
        [{ data: 'A', update_time: '2026-01-01T00:00:00.000Z' }],
        []
    ]);
    neon.nextSql = sql;

    const results = await new RecordStore('postgres://example').fetchMany([
        profile({ id: 'a' }),
        profile({ id: 'b', tableName: 'public.records' })
    ]);

    assert.equal(sql.transactionCalls.length, 1);
    assert.deepEqual(sql.queryCalls.map((c) => c.params), [['a'], ['b']]);
    assert.match(sql.queryCalls[1].query, /FROM public\.records/);
    assert.equal(results[0].data, 'A');
    assert.equal(results[0].updateTime?.toISOString(), '2026-01-01T00:00:00.000Z');
    assert.deepEqual(results[1], { data: null, updateTime: null });
});

test('RecordStore surfaces malformed transport responses', async () => {
    const { RecordStore, neon } = loadCoreDb();
    const sql = createMockSql();
    sql.queryResults.push({ unexpected: true });
    neon.nextSql = sql;

    await assert.rejects(
        new RecordStore('postgres://example').fetch(profile()),
        /Unexpected query response format/
    );
});
