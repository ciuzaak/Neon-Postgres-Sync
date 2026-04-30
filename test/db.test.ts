import test = require('node:test');
import assert = require('node:assert/strict');
import * as fs from 'node:fs';
import * as os from 'node:os';
import {
    createMockSql,
    installModuleMocks,
    purgeProjectModules,
    resetMocks
} from './helpers/moduleMocks';
import type { Profile } from '../src/config';

installModuleMocks();

function loadModules() {
    purgeProjectModules();
    const config = require('../src/config') as typeof import('../src/config');
    const db = require('../src/db') as typeof import('../src/db');
    return { ...config, ...db };
}

async function configureConnection(connectionString: string) {
    const { vscode, neon } = resetMocks();
    const { ConfigManager, DatabaseService } = loadModules();
    const secrets = new Map<string, string>();
    ConfigManager.initialize({
        globalStorageUri: vscode.Uri.file(fs.mkdtempSync(`${os.tmpdir()}/neon-sync-db-`)),
        secrets: {
            get: async (key: string) => secrets.get(key),
            store: async (key: string, value: string) => {
                secrets.set(key, value);
            }
        }
    } as never);
    await ConfigManager.setConnectionString(connectionString);
    return { DatabaseService, neon };
}

function profile(overrides: Partial<Profile> = {}): Profile {
    return {
        name: 'alpha',
        filePath: 'alpha.json',
        id: 'row-1',
        tableName: 'public.records',
        ...overrides
    };
}

test('updateRecord rejects unsafe table names before creating a database client', async () => {
    const { neon } = resetMocks();
    const { DatabaseService } = loadModules();

    await assert.rejects(
        DatabaseService.updateRecord(profile({ tableName: 'records; drop table records' }), '{}'),
        /Invalid table name/
    );
    assert.deepEqual(neon.calls, []);
});

test('fetchRecordWithMeta queries by id and parses object data and string update_time', async () => {
    const { DatabaseService, neon } = await configureConnection('  postgres://example  ');
    const sql = createMockSql();
    sql.queryResults.push({
        rows: [
            {
                data: { ok: true },
                update_time: '2026-01-02T03:04:05.000Z'
            }
        ]
    });
    neon.nextSql = sql;

    const result = await DatabaseService.fetchRecordWithMeta(profile());

    assert.equal(neon.calls[0], 'postgres://example');
    assert.equal(sql.queryCalls.length, 1);
    assert.match(sql.queryCalls[0].query, /SELECT data, update_time FROM public\.records WHERE id = \$1/);
    assert.deepEqual(sql.queryCalls[0].params, ['row-1']);
    assert.equal(result.data, '{\n  "ok": true\n}');
    assert.equal(result.updateTime?.toISOString(), '2026-01-02T03:04:05.000Z');
});

test('fetchRecordWithMeta returns null fields when the row is absent', async () => {
    const { DatabaseService, neon } = await configureConnection('postgres://example');
    const sql = createMockSql();
    sql.queryResults.push([]);
    neon.nextSql = sql;

    const result = await DatabaseService.fetchRecordWithMeta(profile());

    assert.deepEqual(result, { data: null, updateTime: null });
});

test('updateRecord upserts the selected table with parameterized id and data', async () => {
    const { DatabaseService, neon } = await configureConnection('postgres://example');
    const sql = createMockSql();
    neon.nextSql = sql;

    await DatabaseService.updateRecord(profile({ id: 'abc', tableName: 'records' }), '{"hello":"world"}');

    assert.equal(sql.queryCalls.length, 1);
    assert.match(sql.queryCalls[0].query, /INSERT INTO records \(id, data, create_time, update_time\)/);
    assert.match(sql.queryCalls[0].query, /ON CONFLICT \(id\)/);
    assert.deepEqual(sql.queryCalls[0].params, ['abc', '{"hello":"world"}']);
});

test('fetchRecordsWithMeta returns early for an empty batch without opening a database client', async () => {
    const { neon } = resetMocks();
    const { DatabaseService } = await configureConnection('postgres://example');

    const result = await DatabaseService.fetchRecordsWithMeta([]);

    assert.deepEqual(result, []);
    assert.deepEqual(neon.calls, []);
});

test('updateRecords builds one query per item and sends them through a transaction', async () => {
    const { DatabaseService, neon } = await configureConnection('postgres://example');
    const sql = createMockSql();
    neon.nextSql = sql;

    await DatabaseService.updateRecords([
        { profile: profile({ id: 'a', tableName: 'records' }), data: 'A' },
        { profile: profile({ id: 'b', tableName: 'public.records' }), data: 'B' }
    ]);

    assert.equal(sql.queryCalls.length, 2);
    assert.match(sql.queryCalls[0].query, /INSERT INTO records/);
    assert.deepEqual(sql.queryCalls[0].params, ['a', 'A']);
    assert.match(sql.queryCalls[1].query, /INSERT INTO public\.records/);
    assert.deepEqual(sql.queryCalls[1].params, ['b', 'B']);
    assert.equal(sql.transactionCalls.length, 1);
    assert.equal(sql.transactionCalls[0].length, 2);
});
