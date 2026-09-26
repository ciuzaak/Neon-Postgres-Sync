import test = require('node:test');
import assert = require('node:assert/strict');
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createMockSql, installModuleMocks, purgeProjectModules, resetMocks, testLocations } from './helpers/moduleMocks';
import type { Profile } from '../src/config';

installModuleMocks();

// Characterization tests for the multi-profile panel's persistence paths.
// They drive MultiSyncManager end-to-end (fetch → plan → confirm) through the
// module mocks so refactors of the confirm logic can't drift silently.

const OLD = new Date('2026-01-01T00:00:00Z');
const NEW = new Date('2026-01-02T00:00:00Z');

interface Internals {
    handleMessage(msg: unknown): Promise<void>;
    items: Array<{ plan: { profile: Profile }; direction: string; remoteCommitted: boolean; conflict: boolean }>;
}

async function setup(rows: Array<{
    profile: Profile;
    local: string;
    localMtime: Date;
    remote: string;
    remoteTime: Date;
}>, extraSelected: Profile[] = []) {
    const { vscode, neon } = resetMocks();
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'neon-sync-multi-'));
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: workspace } }];
    purgeProjectModules();
    const { ConfigManager } = require('../src/config') as typeof import('../src/config');
    const { MultiSyncManager } = require('../src/multiSync') as typeof import('../src/multiSync');

    const secrets = new Map<string, string>();
    const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neon-sync-multi-cfg-'));
    ConfigManager.initialize({
        globalStorageUri: vscode.Uri.file(storageDir),
        secrets: {
            get: async (k: string) => secrets.get(k),
            store: async (k: string, v: string) => { secrets.set(k, v); },
            delete: async (k: string) => { secrets.delete(k); }
        }
    } as never, testLocations(storageDir));
    await ConfigManager.setConnectionString('postgres://example');
    await ConfigManager.saveProfiles([...rows.map((r) => r.profile), ...extraSelected]);

    for (const r of rows) {
        const file = path.join(workspace, r.profile.filePath);
        fs.writeFileSync(file, r.local);
        fs.utimesSync(file, r.localMtime, r.localMtime);
    }

    // Fetches return the seeded rows; conditional writes echo what was sent.
    const sql = createMockSql();
    sql.transaction = async (queries: unknown[]) => {
        sql.transactionCalls.push(queries);
        const calls = sql.queryCalls.slice(-queries.length);
        return calls.map((c) => {
            if (/WITH w AS/.test(c.query)) {
                return [{ version: `v:${c.params[1]}`, stored: c.params[1] }];
            }
            const r = rows.find((row) => row.profile.id === c.params[0])!;
            return [{ data: r.remote, update_time: r.remoteTime.toISOString(), version: `v:${r.remote}` }];
        });
    };
    neon.nextSql = sql;

    await MultiSyncManager.start([...rows.map((r) => r.profile.name), ...extraSelected.map((p) => p.name)]);

    const internals = MultiSyncManager as unknown as Internals;
    const writes = () => sql.queryCalls.filter((c) => /WITH w AS/.test(c.query)).map((c) => c.params);
    const readLocal = (p: Profile) => fs.readFileSync(path.join(workspace, p.filePath), 'utf-8');
    return { internals, sql, writes, readLocal, vscode, workspace };
}

function profile(name: string, overrides: Partial<Profile> = {}): Profile {
    return { name, filePath: `${name}.json`, id: `${name}-id`, tableName: 'records', ...overrides };
}

test('confirmAll download with excludeKeys keeps local values for excluded keys and writes nothing remote', async () => {
    const p = profile('dl', { excludeKeys: ['theme'] });
    const { internals, writes, readLocal } = await setup([{
        profile: p,
        local: '{"a": 1, "theme": "dark"}',
        localMtime: OLD,
        remote: '{"a": 2, "theme": "light"}',
        remoteTime: NEW
    }]);
    assert.equal(internals.items[0].direction, 'download');

    await internals.handleMessage({ type: 'confirmAll' });

    assert.deepEqual(JSON.parse(readLocal(p)), { a: 2, theme: 'dark' });
    assert.deepEqual(writes(), []);
});

test('confirmAll upload with excludeKeys: each side keeps its own excluded values', async () => {
    const p = profile('ul', { excludeKeys: ['theme'] });
    const { internals, sql, writes, readLocal } = await setup([{
        profile: p,
        local: '{"a": 1, "theme": "dark"}',
        localMtime: NEW,
        remote: '{"a": 2, "theme": "light"}',
        remoteTime: OLD
    }]);
    assert.equal(internals.items[0].direction, 'upload');

    await internals.handleMessage({ type: 'confirmAll' });

    const written = writes();
    assert.equal(written.length, 1);
    assert.equal(written[0][0], 'ul-id');
    assert.deepEqual(JSON.parse(written[0][1] as string), { a: 1, theme: 'light' }, 'remote keeps its theme');
    assert.equal(written[0][2], 'v:{"a": 2, "theme": "light"}', 'conditional on the fetched version');
    assert.deepEqual(JSON.parse(readLocal(p)), { a: 1, theme: 'dark' }, 'local keeps its theme (v0.7 overwrote it)');
    assert.equal(sql.transactionCalls.length, 2, 'one fetch batch + one atomic write batch');
});

test('a failed local write keeps the row with its error, and a retry then succeeds', { skip: process.getuid?.() === 0 }, async () => {
    const p = profile('retry');
    const { internals, writes, readLocal, workspace, vscode } = await setup([{
        profile: p, local: 'old', localMtime: OLD, remote: 'new', remoteTime: NEW
    }]);
    const file = path.join(workspace, p.filePath);
    fs.chmodSync(file, 0o444);
    try {
        await internals.handleMessage({ type: 'confirmAll' });
    } finally {
        fs.chmodSync(file, 0o644);
    }
    assert.equal(internals.items.length, 1, 'row stays visible');
    assert.equal(internals.items[0].remoteCommitted, false, 'download never touches remote');
    assert.match(vscode.window.errorMessages.at(-1)!, /retry \(local write failed/);

    await internals.handleMessage({ type: 'confirmAll' });

    assert.equal(readLocal(p), 'new');
    assert.deepEqual(writes(), []);
    assert.equal(internals.items.length, 0);
});

test('conflict rows are left out of Confirm All until acted on individually', async () => {
    const p = profile('conflict');
    const calm = profile('calm');
    const { internals, workspace, writes, readLocal } = await setup([
        { profile: p, local: 'mine', localMtime: NEW, remote: 'theirs', remoteTime: OLD },
        { profile: calm, local: 'old', localMtime: OLD, remote: 'new', remoteTime: NEW }
    ]);
    // Give "conflict" a baseline neither side matches: both changed since last sync.
    const { SyncStateStore } = require('../src/core/syncState') as typeof import('../src/core/syncState');
    const { baselineAfterSync, planSync } = require('../src/core/plan') as typeof import('../src/core/plan');
    const { ConfigManager } = require('../src/config') as typeof import('../src/config');
    const state = new SyncStateStore(ConfigManager.getSyncStateDir()!);
    const key = { tableName: p.tableName, id: p.id, localPath: path.join(workspace, p.filePath) };
    const base = planSync(p, { exists: true, content: 'base', mtime: OLD }, { data: 'base', updateTime: OLD, version: null });
    state.put(baselineAfterSync(base, key, 'base', null, OLD));
    // Re-open the panel so the plan sees the baseline.
    (internals as unknown as { panel: unknown; items: unknown[] }).panel = null;
    const { MultiSyncManager } = require('../src/multiSync') as typeof import('../src/multiSync');
    await MultiSyncManager.start([p.name, calm.name]);
    assert.deepEqual(internals.items.map((i) => [i.plan.profile.name, i.conflict]), [['conflict', true], ['calm', false]]);

    await internals.handleMessage({ type: 'confirmAll' });

    assert.equal(readLocal(calm), 'new');
    assert.equal(readLocal(p), 'mine', 'conflict row untouched');
    assert.deepEqual(writes(), []);
    assert.deepEqual(internals.items.map((i) => i.plan.profile.name), ['conflict']);
});

test('confirm on a single download row writes the remote content verbatim when no keys are excluded', async () => {
    const p = profile('one');
    const other = profile('other');
    const { internals, writes, readLocal } = await setup([
        { profile: p, local: 'old\n', localMtime: OLD, remote: 'new\n', remoteTime: NEW },
        { profile: other, local: 'x', localMtime: NEW, remote: 'y', remoteTime: OLD }
    ]);

    await internals.handleMessage({ type: 'confirm', profile: 'one' });

    assert.equal(readLocal(p), 'new\n');
    assert.equal(readLocal(other), 'x', 'other rows untouched');
    assert.deepEqual(writes(), []);
    assert.deepEqual(internals.items.map((i) => i.plan.profile.name), ['other']);
});

test('confirm on a single upload row with excludeKeys merges remote values back before committing', async () => {
    const p = profile('one-ul', { excludeKeys: ['theme'] });
    const { internals, writes, readLocal } = await setup([{
        profile: p,
        local: '{"a": 1, "theme": "dark"}',
        localMtime: NEW,
        remote: '{"a": 2, "theme": "light"}',
        remoteTime: OLD
    }]);

    await internals.handleMessage({ type: 'confirm', profile: 'one-ul' });

    const written = writes();
    assert.equal(written.length, 1);
    assert.deepEqual(JSON.parse(written[0][1] as string), { a: 1, theme: 'light' });
    assert.deepEqual(JSON.parse(readLocal(p)), { a: 1, theme: 'dark' });
});

test('a local file edited after loading is not overwritten, and the remote is not written either', async () => {
    const p = profile('guard');
    const { internals, writes, readLocal, workspace, vscode } = await setup([{
        profile: p, local: 'mine', localMtime: NEW, remote: 'theirs', remoteTime: OLD
    }]);
    vscode.window.showErrorMessage = async (message: string) => {
        vscode.window.errorMessages.push(message);
        return undefined; // user dismisses the toast
    };
    fs.writeFileSync(path.join(workspace, p.filePath), 'edited meanwhile');

    await internals.handleMessage({ type: 'confirmAll' });

    assert.equal(readLocal(p), 'edited meanwhile');
    assert.deepEqual(writes(), []);
    assert.equal(internals.items.length, 1);
    assert.match(vscode.window.errorMessages.at(-1)!, /local file changed since loaded\)\. Reload to see the current state\./);
});

test('Reload after a stale row re-plans the panel from fresh data', async () => {
    const p = profile('reload');
    const { internals, workspace } = await setup([{
        profile: p, local: 'mine', localMtime: NEW, remote: 'theirs', remoteTime: OLD
    }]);
    fs.writeFileSync(path.join(workspace, p.filePath), 'edited meanwhile');

    await internals.handleMessage({ type: 'confirmAll' }); // mock toast picks its first button: Reload
    for (let i = 0; i < 20 && internals.items.length === 0; i++) {
        await new Promise((resolve) => setImmediate(resolve));
    }

    assert.equal(internals.items.length, 1);
    assert.equal((internals.items[0].plan as unknown as { localOriginal: string }).localOriginal, 'edited meanwhile');
});

// ── Diff button, remote-committed retry, labels, reload guard ─────────

type DiffResult = { outcome: 'confirmed' | 'cancelled'; candidateContent: string; direction: 'upload' | 'download' };

function stubExternalDiff(respond: (args: unknown[]) => DiffResult | Promise<DiffResult>) {
    const { SyncManager } = require('../src/sync') as typeof import('../src/sync');
    const calls: unknown[][] = [];
    (SyncManager as unknown as { openDiffForExternal: unknown }).openDiffForExternal =
        async (...args: unknown[]) => { calls.push(args); return respond(args); };
    return calls;
}

function panelHtml(): string {
    const { MultiSyncManager } = require('../src/multiSync') as typeof import('../src/multiSync');
    return (MultiSyncManager as unknown as { panel: { webview: { html: string } } }).panel.webview.html;
}

test('Diff button: the edited stripped candidate is applied with each side keeping its own excluded values', async () => {
    const p = profile('diffed', { excludeKeys: ['theme'] });
    const { internals, writes, readLocal } = await setup([{
        profile: p,
        local: '{"a": 1, "theme": "dark"}',
        localMtime: NEW,
        remote: '{"a": 2, "theme": "light"}',
        remoteTime: OLD
    }]);
    const calls = stubExternalDiff(() => ({ outcome: 'confirmed', candidateContent: '{"a": 99}', direction: 'upload' }));

    await internals.handleMessage({ type: 'diff', profile: 'diffed' });

    assert.equal(calls.length, 1);
    assert.equal(calls[0][2], '{"a": 1}', 'diff shows the stripped local');
    assert.deepEqual(JSON.parse(writes()[0][1] as string), { a: 99, theme: 'light' });
    assert.deepEqual(JSON.parse(readLocal(p)), { a: 99, theme: 'dark' });
    assert.equal(internals.items.length, 0);
});

test('an upload whose local write fails shows "remote committed"; retrying does not write the remote again', { skip: process.getuid?.() === 0 }, async () => {
    const p = profile('committed', { excludeKeys: ['theme'] });
    const { internals, writes, readLocal, workspace, vscode } = await setup([{
        profile: p,
        local: '{"a": 1, "theme": "dark"}',
        localMtime: NEW,
        remote: '{"a": 2, "theme": "light"}',
        remoteTime: OLD
    }]);
    stubExternalDiff(() => ({ outcome: 'confirmed', candidateContent: '{"a": 5}', direction: 'upload' }));
    const file = path.join(workspace, p.filePath);
    fs.chmodSync(file, 0o444);
    try {
        await internals.handleMessage({ type: 'diff', profile: 'committed' });
    } finally {
        fs.chmodSync(file, 0o644);
    }
    assert.equal(writes().length, 1);
    assert.equal(internals.items[0].remoteCommitted, true);
    assert.match(panelHtml(), /remote committed/);
    assert.match(vscode.window.errorMessages.at(-1)!, /already saved; retry only rewrites the local files/);

    // Retry the same edit: the remote already holds it.
    await internals.handleMessage({ type: 'diff', profile: 'committed' });

    assert.equal(writes().length, 1, 'no second DB commit');
    assert.deepEqual(JSON.parse(readLocal(p)), { a: 5, theme: 'dark' });
    assert.equal(internals.items.length, 0);
});

test('Confirm All label counts only rows it will apply', async () => {
    const { internals } = await setup([
        { profile: profile('p1'), local: 'l', localMtime: NEW, remote: 'r', remoteTime: OLD },
        { profile: profile('p2', { excludeKeys: ['x'] }), local: 'not json', localMtime: NEW, remote: '{}', remoteTime: OLD }
    ]);
    assert.equal(internals.items.length, 2);
    assert.match(panelHtml(), /Confirm All \(1\)/);
});

test('Reload is refused while a diff from the panel is open', async () => {
    const p = profile('busy');
    const { internals, vscode } = await setup([{ profile: p, local: 'l', localMtime: NEW, remote: 'r', remoteTime: OLD }]);
    let release!: (r: DiffResult) => void;
    stubExternalDiff(() => new Promise<DiffResult>((resolve) => { release = resolve; }));
    const diffDone = internals.handleMessage({ type: 'diff', profile: 'busy' });
    await new Promise((resolve) => setImmediate(resolve));

    await (internals as unknown as { reload(): Promise<void> }).reload();

    assert.match(vscode.window.warningMessages.at(-1)!, /Close the open diff before reloading/);
    assert.equal(internals.items.length, 1);
    release({ outcome: 'cancelled', candidateContent: '', direction: 'upload' });
    await diffDone;
});

test('a stale batch names the rows that were not applied because of it', async () => {
    const { internals, vscode, sql } = await setup([
        { profile: profile('s1'), local: 'l1', localMtime: NEW, remote: 'r1', remoteTime: OLD },
        { profile: profile('s2'), local: 'l2', localMtime: NEW, remote: 'r2', remoteTime: OLD }
    ]);
    vscode.window.showErrorMessage = async (m: string) => { vscode.window.errorMessages.push(m); return undefined; };
    const realTx = sql.transaction;
    sql.transaction = async (queries: unknown[]) => {
        const calls = sql.queryCalls.slice(-queries.length);
        if (calls.some((c) => /WITH w AS/.test(c.query))) {
            throw Object.assign(new Error('division by zero'), { code: '22012' });
        }
        // Re-read after the sentinel: s1 changed remotely.
        return (await realTx(queries) as unknown[]).map((rows, i) =>
            calls[i].params[0] === 's1-id' ? [{ data: 'changed', update_time: OLD.toISOString(), version: 'v:changed' }] : rows);
    };

    await internals.handleMessage({ type: 'confirmAll' });

    assert.match(vscode.window.errorMessages.at(-1)!, /failed: s1 \(remote changed since loaded\)\. Not applied \(the batch is all-or-nothing\): s2\./);
});

test('the panel refuses to open while a diff from a previous panel is still open', async () => {
    const p = profile('old-diff');
    const { internals, vscode } = await setup([{ profile: p, local: 'l', localMtime: NEW, remote: 'r', remoteTime: OLD }]);
    let release!: (r: DiffResult) => void;
    stubExternalDiff(() => new Promise<DiffResult>((resolve) => { release = resolve; }));
    const diffDone = internals.handleMessage({ type: 'diff', profile: 'old-diff' });
    await new Promise((resolve) => setImmediate(resolve));
    const { SyncManager } = require('../src/sync') as typeof import('../src/sync');
    (SyncManager as unknown as { currentSession: unknown }).currentSession = {}; // the stubbed diff stands in for a real session
    const { MultiSyncManager } = require('../src/multiSync') as typeof import('../src/multiSync');
    (MultiSyncManager as unknown as { panel: unknown }).panel = null; // user closed the panel

    await MultiSyncManager.start([p.name]);

    assert.match(vscode.window.warningMessages.at(-1)!, /Finish or cancel the open sync diff first/);
    (SyncManager as unknown as { currentSession: unknown }).currentSession = null;
    release({ outcome: 'cancelled', candidateContent: '', direction: 'upload' });
    await diffDone;
});

test('profiles sharing a local file are skipped; the others still load', async () => {
    const clean = profile('clean');
    const twinA = profile('twinA', { filePath: 'shared.json' });
    const twinB = profile('twinB', { filePath: 'shared.json' });
    const { vscode, internals } = await setup(
        [{ profile: clean, local: 'l', localMtime: NEW, remote: 'r', remoteTime: OLD }],
        [twinA, twinB]
    );

    assert.deepEqual(internals.items.map((i) => i.plan.profile.name), ['clean']);
    assert.match(vscode.window.warningMessages.join('\n'), /Skipped twinA, twinB: Profiles "twinA" \(shared\.json\) and "twinB" \(shared\.json\) use the same local file/);
});
