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

test('createSyncEngine rejects unsafe table names before resolving the connection (no missing-URL prompt)', async () => {
    const { vscode, neon } = resetMocks();
    const { ConfigManager } = loadModules();
    ConfigManager.initialize({
        globalStorageUri: vscode.Uri.file(fs.mkdtempSync(`${os.tmpdir()}/neon-sync-db-`)),
        secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined }
    } as never);
    const { createSyncEngine } = require('../src/hostEngine') as typeof import('../src/hostEngine');

    await assert.rejects(
        createSyncEngine([profile({ tableName: 'records; drop table records' })]),
        /Invalid table name/
    );
    assert.deepEqual(vscode.window.errorMessages, []);
    assert.deepEqual(neon.calls, []);
});

test('getRecordStore triggers the missing-URL prompt and throws when no connection is configured', async () => {
    const { vscode, neon } = resetMocks();
    const { ConfigManager, DatabaseService } = loadModules();
    const secrets = new Map<string, string>();
    ConfigManager.initialize({
        globalStorageUri: vscode.Uri.file(fs.mkdtempSync(`${os.tmpdir()}/neon-sync-db-`)),
        secrets: {
            get: async (key: string) => secrets.get(key),
            store: async (key: string, value: string) => { secrets.set(key, value); },
            delete: async (key: string) => { secrets.delete(key); }
        }
    } as never);

    await assert.rejects(
        DatabaseService.getRecordStore(),
        /^Error: PostgreSQL connection string is not configured\.$/
    );
    assert.deepEqual(vscode.window.errorMessages, [
        'PostgreSQL connection string is not configured.'
    ]);
    assert.deepEqual(neon.calls, []);
});

test('the record store queries by id and parses object data and string update_time', async () => {
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

    const result = await (await DatabaseService.getRecordStore()).fetch(profile());

    assert.equal(neon.calls[0], 'postgres://example');
    assert.equal(sql.queryCalls.length, 1);
    assert.match(sql.queryCalls[0].query, /SELECT data::text AS data, update_time, encode\(sha256\(convert_to\(data::text, current_setting\('server_encoding'\)\)\), 'hex'\) AS version FROM public\.records WHERE id = \$1/);
    assert.deepEqual(sql.queryCalls[0].params, ['row-1']);
    assert.equal(result.data, '{\n  "ok": true\n}');
    assert.equal(result.updateTime?.toISOString(), '2026-01-02T03:04:05.000Z');
});

test('the record store returns null fields when the row is absent', async () => {
    const { DatabaseService, neon } = await configureConnection('postgres://example');
    const sql = createMockSql();
    sql.queryResults.push([]);
    neon.nextSql = sql;

    const result = await (await DatabaseService.getRecordStore()).fetch(profile());

    assert.deepEqual(result, { data: null, updateTime: null, version: null });
});

test('an empty batch fetch returns early without opening a database client', async () => {
    const { neon } = resetMocks();
    const { DatabaseService } = await configureConnection('postgres://example');

    const result = await (await DatabaseService.getRecordStore()).fetchMany([]);

    assert.deepEqual(result, []);
    assert.deepEqual(neon.calls, []);
});

test('after the connection string changes, the next call connects with the new string', async () => {
    const { DatabaseService, neon } = await configureConnection('postgres://first');
    const { ConfigManager } = require('../src/config') as typeof import('../src/config');

    await (await DatabaseService.getRecordStore()).fetch(profile());
    await (await DatabaseService.getRecordStore()).fetch(profile());
    await ConfigManager.setConnectionString('postgres://second');
    await (await DatabaseService.getRecordStore()).fetch(profile());

    assert.deepEqual(neon.calls, ['postgres://first', 'postgres://second']);
});
