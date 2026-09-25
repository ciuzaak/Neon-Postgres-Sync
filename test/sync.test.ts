import test = require('node:test');
import assert = require('node:assert/strict');
import * as path from 'node:path';
import { installModuleMocks, purgeProjectModules, resetMocks } from './helpers/moduleMocks';

installModuleMocks();

function loadSyncModule() {
    purgeProjectModules();
    return require('../src/sync') as typeof import('../src/sync');
}

test('resolvePath preserves absolute paths and anchors relative paths to the workspace root', () => {
    const { vscode } = resetMocks();
    const workspaceRoot = path.join(path.sep, 'tmp', 'workspace');
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: workspaceRoot } }];
    const { SyncManager } = loadSyncModule();

    assert.equal(SyncManager.resolvePath('/var/data/file.json'), '/var/data/file.json');
    assert.equal(SyncManager.resolvePath('nested/file.json'), path.join(workspaceRoot, 'nested/file.json'));
});

// ── single-profile flow end to end (real SQL via PGlite) ─────────────

import * as fs from 'node:fs';
import * as os from 'node:os';
import { createPgliteSql } from './helpers/pgliteSql';
import type { Profile } from '../src/config';

const T_OLD = new Date('2026-01-01T00:00:00Z');
const T_NEW = new Date('2026-01-02T00:00:00Z');

async function setupSingle(p: Profile, local: string, remote: string, opts: { localNewer: boolean }) {
    const { vscode, neon } = resetMocks();
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'neon-sync-single-'));
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: workspace } }];
    purgeProjectModules();
    const { ConfigManager } = require('../src/config') as typeof import('../src/config');
    const { SyncManager } = require('../src/sync') as typeof import('../src/sync');
    const secrets = new Map<string, string>();
    ConfigManager.initialize({
        globalStorageUri: vscode.Uri.file(fs.mkdtempSync(path.join(os.tmpdir(), 'neon-sync-single-cfg-'))),
        secrets: {
            get: async (k: string) => secrets.get(k),
            store: async (k: string, v: string) => { secrets.set(k, v); },
            delete: async (k: string) => { secrets.delete(k); }
        }
    } as never);
    await ConfigManager.setConnectionString('postgres://pglite');
    await ConfigManager.saveProfiles([p]);

    const pg = await createPgliteSql();
    const remoteTime = opts.localNewer ? T_OLD : T_NEW;
    await pg.db.query('INSERT INTO records VALUES ($1, $2, $3, $3)', [p.id, remote, remoteTime.toISOString()]);
    neon.nextSql = pg.sql;
    const file = path.join(workspace, p.filePath);
    fs.writeFileSync(file, local);
    const localTime = opts.localNewer ? T_NEW : T_OLD;
    fs.utimesSync(file, localTime, localTime);

    const remoteOf = async () =>
        (await pg.db.query<{ data: string }>('SELECT data FROM records WHERE id = $1', [p.id])).rows[0]?.data;
    return { vscode, SyncManager, ConfigManager, pg, file, remoteOf };
}

const single = (overrides: Partial<Profile> = {}): Profile =>
    ({ name: 'solo', filePath: 'solo.json', id: 'solo-id', tableName: 'records', ...overrides });

test('single sync: upload with excludeKeys keeps each side\'s own excluded values and records a baseline', async () => {
    const p = single({ excludeKeys: ['theme'] });
    const { vscode, SyncManager, ConfigManager, file, remoteOf } = await setupSingle(
        p, '{"a": 1, "theme": "dark"}', '{"a": 2, "theme": "light"}', { localNewer: true }
    );

    await SyncManager.startSync(p.name);
    await SyncManager.confirmSync();

    assert.deepEqual(JSON.parse((await remoteOf())!), { a: 1, theme: 'light' });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf-8')), { a: 1, theme: 'dark' });
    assert.match(vscode.window.infoMessages.at(-1)!, /^Uploaded solo to database/);
    assert.equal(fs.readdirSync(ConfigManager.getSyncStateDir()!).length, 1);
});

test('single sync: a remote change after the diff opened is refused with a Re-sync offer', async () => {
    const p = single();
    const { vscode, SyncManager, pg, file, remoteOf } = await setupSingle(p, 'mine', 'theirs', { localNewer: true });
    const offered: unknown[][] = [];
    vscode.window.showErrorMessage = async (message: string, ...items: unknown[]) => {
        vscode.window.errorMessages.push(message);
        offered.push(items);
        return undefined;
    };

    await SyncManager.startSync(p.name);
    await pg.db.query(`UPDATE records SET data = 'another machine' WHERE id = $1`, [p.id]);
    await SyncManager.confirmSync();

    assert.equal(await remoteOf(), 'another machine');
    assert.equal(fs.readFileSync(file, 'utf-8'), 'mine');
    assert.match(vscode.window.errorMessages.at(-1)!, /changed since this diff was opened.*Nothing was written/);
    assert.deepEqual(offered.at(-1), ['Re-sync']);
});

test('single sync: both sides changed since the last sync prompts a conflict, not a clock guess', async () => {
    const p = single();
    const { vscode, SyncManager, pg, file } = await setupSingle(p, 'base', 'base', { localNewer: true });
    await SyncManager.startSync(p.name); // identical → records a baseline
    fs.writeFileSync(file, 'mine');
    await pg.db.query(`UPDATE records SET data = 'theirs' WHERE id = $1`, [p.id]);
    const prompts: string[] = [];
    vscode.window.showWarningMessage = async (message: string) => {
        prompts.push(message);
        return undefined; // user dismisses → nothing happens
    };

    await SyncManager.startSync(p.name);

    assert.match(prompts.at(-1)!, /^Conflict in "solo": both local and remote changed since last sync/);
    assert.equal(fs.readFileSync(file, 'utf-8'), 'mine');
});

test('single sync: only the remote changed since the last sync ⇒ download without a prompt, even if local looks newer', async () => {
    const p = single();
    const { vscode, SyncManager, pg, file } = await setupSingle(p, 'base', 'base', { localNewer: true });
    await SyncManager.startSync(p.name); // records a baseline
    await pg.db.query(`UPDATE records SET data = 'theirs' WHERE id = $1`, [p.id]); // update_time untouched (old)
    fs.utimesSync(file, T_NEW, T_NEW);

    await SyncManager.startSync(p.name);
    assert.match(vscode.window.infoMessages.at(-1)!, /^Auto-picked Local ← Remote: only remote changed since last sync/);
    await SyncManager.confirmSync();

    assert.equal(fs.readFileSync(file, 'utf-8'), 'theirs');
});
