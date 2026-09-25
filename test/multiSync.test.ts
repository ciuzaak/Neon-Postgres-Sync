import test = require('node:test');
import assert = require('node:assert/strict');
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createMockSql, installModuleMocks, purgeProjectModules, resetMocks } from './helpers/moduleMocks';
import type { Profile } from '../src/config';

installModuleMocks();

// Characterization tests for the multi-profile panel's persistence paths.
// They drive MultiSyncManager end-to-end (fetch → plan → confirm) through the
// module mocks so later refactors of the confirm logic can't drift silently.

const OLD = new Date('2026-01-01T00:00:00Z');
const NEW = new Date('2026-01-02T00:00:00Z');

interface Internals {
    handleMessage(msg: unknown): Promise<void>;
    items: Array<{ profile: Profile; direction: string; remotePersisted: boolean }>;
}

async function setup(rows: Array<{
    profile: Profile;
    local: string;
    localMtime: Date;
    remote: string;
    remoteTime: Date;
}>) {
    const { vscode, neon } = resetMocks();
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'neon-sync-multi-'));
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: workspace } }];
    purgeProjectModules();
    const { ConfigManager } = require('../src/config') as typeof import('../src/config');
    const { MultiSyncManager } = require('../src/multiSync') as typeof import('../src/multiSync');

    const secrets = new Map<string, string>();
    ConfigManager.initialize({
        globalStorageUri: vscode.Uri.file(fs.mkdtempSync(path.join(os.tmpdir(), 'neon-sync-multi-cfg-'))),
        secrets: {
            get: async (k: string) => secrets.get(k),
            store: async (k: string, v: string) => { secrets.set(k, v); },
            delete: async (k: string) => { secrets.delete(k); }
        }
    } as never);
    await ConfigManager.setConnectionString('postgres://example');
    await ConfigManager.saveProfiles(rows.map((r) => r.profile));

    for (const r of rows) {
        const file = path.join(workspace, r.profile.filePath);
        fs.writeFileSync(file, r.local);
        fs.utimesSync(file, r.localMtime, r.localMtime);
    }

    const sql = createMockSql();
    sql.transactionResults.push(
        rows.map((r) => [{ data: r.remote, update_time: r.remoteTime.toISOString() }])
    );
    neon.nextSql = sql;

    await MultiSyncManager.start(rows.map((r) => r.profile.name));

    const internals = MultiSyncManager as unknown as Internals;
    const upserts = () =>
        sql.queryCalls.filter((c) => /INSERT INTO/.test(c.query)).map((c) => c.params);
    const readLocal = (p: Profile) => fs.readFileSync(path.join(workspace, p.filePath), 'utf-8');
    return { internals, sql, upserts, readLocal, vscode, workspace };
}

function profile(name: string, overrides: Partial<Profile> = {}): Profile {
    return { name, filePath: `${name}.json`, id: `${name}-id`, tableName: 'records', ...overrides };
}

test('confirmAll download with excludeKeys keeps local values for excluded keys and writes nothing remote', async () => {
    const p = profile('dl', { excludeKeys: ['theme'] });
    const { internals, upserts, readLocal } = await setup([{
        profile: p,
        local: '{"a": 1, "theme": "dark"}',
        localMtime: OLD,
        remote: '{"a": 2, "theme": "light"}',
        remoteTime: NEW
    }]);
    assert.equal(internals.items[0].direction, 'download');

    await internals.handleMessage({ type: 'confirmAll' });

    assert.deepEqual(JSON.parse(readLocal(p)), { a: 2, theme: 'dark' });
    assert.deepEqual(upserts(), []);
});

test('confirmAll upload with excludeKeys keeps remote values for excluded keys and writes the same bytes locally', async () => {
    const p = profile('ul', { excludeKeys: ['theme'] });
    const { internals, sql, upserts, readLocal } = await setup([{
        profile: p,
        local: '{"a": 1, "theme": "dark"}',
        localMtime: NEW,
        remote: '{"a": 2, "theme": "light"}',
        remoteTime: OLD
    }]);
    assert.equal(internals.items[0].direction, 'upload');

    await internals.handleMessage({ type: 'confirmAll' });

    const written = upserts();
    assert.equal(written.length, 1);
    assert.equal(written[0][0], 'ul-id');
    assert.deepEqual(JSON.parse(written[0][1] as string), { a: 1, theme: 'light' });
    assert.equal(readLocal(p), written[0][1], 'local mirrors the committed bytes');
    assert.equal(sql.transactionCalls.length, 2, 'one fetch batch + one atomic write batch');
});

test('confirmAll retry after a failed local write re-writes locally without re-committing remote', async () => {
    const p = profile('retry', { excludeKeys: ['theme'] });
    const { internals, upserts, readLocal, workspace, vscode } = await setup([{
        profile: p,
        local: '{"a": 1, "theme": "dark"}',
        localMtime: NEW,
        remote: '{"a": 2, "theme": "light"}',
        remoteTime: OLD
    }]);
    const file = path.join(workspace, p.filePath);
    fs.chmodSync(file, 0o444);

    try {
        await internals.handleMessage({ type: 'confirmAll' });
    } finally {
        fs.chmodSync(file, 0o644);
    }
    assert.equal(upserts().length, 1);
    assert.equal(internals.items.length, 1, 'row stays visible');
    assert.equal(internals.items[0].remotePersisted, true);
    assert.match(vscode.window.errorMessages.at(-1)!, /already committed/);

    await internals.handleMessage({ type: 'confirmAll' });

    assert.equal(upserts().length, 1, 'no second DB commit');
    assert.deepEqual(JSON.parse(readLocal(p)), { a: 1, theme: 'light' });
    assert.equal(internals.items.length, 0);
});

test('confirm on a single download row writes the remote content verbatim when no keys are excluded', async () => {
    const p = profile('one');
    const other = profile('other');
    const { internals, upserts, readLocal } = await setup([
        { profile: p, local: 'old\n', localMtime: OLD, remote: 'new\n', remoteTime: NEW },
        { profile: other, local: 'x', localMtime: NEW, remote: 'y', remoteTime: OLD }
    ]);

    await internals.handleMessage({ type: 'confirm', profile: 'one' });

    assert.equal(readLocal(p), 'new\n');
    assert.equal(readLocal(other), 'x', 'other rows untouched');
    assert.deepEqual(upserts(), []);
    assert.deepEqual(internals.items.map((i) => i.profile.name), ['other']);
});

test('confirm on a single upload row with excludeKeys merges remote values back before committing', async () => {
    const p = profile('one-ul', { excludeKeys: ['theme'] });
    const { internals, upserts, readLocal } = await setup([{
        profile: p,
        local: '{"a": 1, "theme": "dark"}',
        localMtime: NEW,
        remote: '{"a": 2, "theme": "light"}',
        remoteTime: OLD
    }]);

    await internals.handleMessage({ type: 'confirm', profile: 'one-ul' });

    const written = upserts();
    assert.equal(written.length, 1);
    assert.deepEqual(JSON.parse(written[0][1] as string), { a: 1, theme: 'light' });
    assert.equal(readLocal(p), written[0][1]);
});
