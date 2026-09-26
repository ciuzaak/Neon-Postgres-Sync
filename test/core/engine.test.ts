import test = require('node:test');
import assert = require('node:assert/strict');
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { installModuleMocks, purgeProjectModules, resetMocks } from '../helpers/moduleMocks';
import { createPgliteSql } from '../helpers/pgliteSql';
import type { Profile } from '../../src/core/types';

installModuleMocks();

const OLD = '2020-01-01 00:00:00';

function profile(id: string, overrides: Partial<Profile> = {}): Profile {
    return { name: id, filePath: `${id}.json`, id, tableName: 'records', ...overrides };
}

async function setup(opts: { remote?: Record<string, string>; local?: Record<string, string>; ddl?: string } = {}) {
    const { neon } = resetMocks();
    purgeProjectModules();
    const { RecordStore } = require('../../src/core/db') as typeof import('../../src/core/db');
    const { SyncEngine } = require('../../src/core/engine') as typeof import('../../src/core/engine');
    const { SyncStateStore } = require('../../src/core/syncState') as typeof import('../../src/core/syncState');
    const pg = await createPgliteSql(opts.ddl);
    for (const [id, data] of Object.entries(opts.remote ?? {})) {
        await pg.db.query('INSERT INTO records VALUES ($1, $2, $3, $3)', [id, data, OLD]);
    }
    neon.nextSql = pg.sql;

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neon-sync-engine-'));
    for (const [id, content] of Object.entries(opts.local ?? {})) {
        fs.writeFileSync(path.join(dir, `${id}.json`), content);
    }
    let clock = Date.parse('2026-09-25T00:00:00Z');
    const state = new SyncStateStore(path.join(dir, 'state'));
    const engine = new SyncEngine({
        store: new RecordStore('postgres://pglite'),
        state,
        resolvePath: (p) => path.join(dir, p),
        now: () => new Date((clock += 1000))
    });
    const remoteOf = async (id: string) =>
        (await pg.db.query<{ data: string }>('SELECT data FROM records WHERE id = $1', [id])).rows[0]?.data;
    const localOf = (id: string) => fs.readFileSync(path.join(dir, `${id}.json`), 'utf-8');
    const writes = () => pg.sql.queryCalls.filter((c) => /WITH w AS/.test(c.query)).length;
    return { engine, state, pg, dir, remoteOf, localOf, writes };
}

test('upload: conditional write, local untouched when its bytes do not change, baseline recorded', async () => {
    const { engine, remoteOf, localOf, dir, state } = await setup({ remote: { a: 'old' }, local: { a: 'new' } });
    const [plan] = await engine.plan([profile('a')]);
    const mtimeBefore = fs.statSync(path.join(dir, 'a.json')).mtimeMs;

    const [outcome] = await engine.apply([{ plan, direction: 'upload', candidate: plan.localContent }]);

    assert.equal(outcome.kind, 'ok');
    assert.equal(await remoteOf('a'), 'new');
    assert.equal(localOf('a'), 'new');
    assert.equal(fs.statSync(path.join(dir, 'a.json')).mtimeMs, mtimeBefore, 'no needless local rewrite');
    assert.ok(state.get(engine.keyFor(profile('a'))));
    const [next] = await engine.plan([profile('a')]);
    assert.equal(next.status, 'identical');
});

test('upload with excludeKeys: each side keeps its own excluded values', async () => {
    const p = profile('a', { excludeKeys: ['theme'] });
    const { engine, remoteOf, localOf } = await setup({
        remote: { a: '{\n    "font": 12,\n    "theme": "light"\n}\n' },
        local: { a: '{\n    "font": 14, // why\n    "theme": "dark"\n}\n' }
    });
    const [plan] = await engine.plan([p]);

    const [outcome] = await engine.apply([{ plan, direction: 'upload', candidate: plan.localContent }]);

    assert.equal(outcome.kind, 'ok');
    assert.equal(await remoteOf('a'), '{\n    "font": 14, // why\n    "theme": "light"\n}\n');
    assert.equal(localOf('a'), '{\n    "font": 14, // why\n    "theme": "dark"\n}\n');
    assert.equal((await engine.plan([p]))[0].status, 'identical');
});

test('download: local merged with its own excluded values; no remote write', async () => {
    const p = profile('a', { excludeKeys: ['theme'] });
    const { engine, localOf, writes } = await setup({
        remote: { a: '{"font": 16, "theme": "light"}' },
        local: { a: '{"font": 14, "theme": "dark"}' }
    });
    const [plan] = await engine.plan([p]);

    const [outcome] = await engine.apply([{ plan, direction: 'download', candidate: plan.remoteContent }]);

    assert.equal(outcome.kind, 'ok');
    assert.deepEqual(JSON.parse(localOf('a')), { font: 16, theme: 'dark' });
    assert.equal(writes(), 0);
});

test('after a sync, the baseline attributes the next change to the right side', async () => {
    const { engine, pg } = await setup({ remote: { a: 'v1' }, local: { a: 'v0' } });
    const [first] = await engine.plan([profile('a')]);
    await engine.apply([{ plan: first, direction: 'download', candidate: first.remoteContent }]);

    await pg.db.query(`UPDATE records SET data = 'v2' WHERE id = 'a'`); // another machine; update_time untouched
    const [next] = await engine.plan([profile('a')]);

    assert.equal(next.change, 'remote');
    assert.deepEqual([next.suggestion.direction, next.suggestion.ambiguous], ['download', false]);
});

test('stale remote: nothing written anywhere; the stale row is reported and the rest are not-applied', async () => {
    const { engine, pg, remoteOf, localOf } = await setup({
        remote: { a: 'ra', b: 'rb', c: 'rc' },
        local: { a: 'la', b: 'lb', c: 'lc' }
    });
    const plans = await engine.plan([profile('a'), profile('b'), profile('c')]);
    await pg.db.query(`UPDATE records SET data = 'someone-else' WHERE id = 'b'`);

    const outcomes = await engine.apply([
        { plan: plans[0], direction: 'upload', candidate: plans[0].localContent },
        { plan: plans[1], direction: 'upload', candidate: plans[1].localContent },
        { plan: plans[2], direction: 'download', candidate: plans[2].remoteContent }
    ]);

    assert.deepEqual(outcomes.map((o) => o.kind), ['not-applied', 'stale-remote', 'not-applied']);
    assert.deepEqual([await remoteOf('a'), await remoteOf('b')], ['ra', 'someone-else']);
    assert.equal(localOf('c'), 'lc');
});

test('stale local: the request fails before any remote write', async () => {
    const { engine, dir, remoteOf, writes } = await setup({ remote: { a: 'r' }, local: { a: 'l' } });
    const [plan] = await engine.plan([profile('a')]);
    fs.writeFileSync(path.join(dir, 'a.json'), 'edited in another editor');

    const [outcome] = await engine.apply([{ plan, direction: 'upload', candidate: plan.localContent }]);

    assert.equal(outcome.kind, 'stale-local');
    assert.equal(await remoteOf('a'), 'r');
    assert.equal(writes(), 0);
});

test('a local file created after planning (plan said absent) is stale-local', async () => {
    const { engine, dir } = await setup({ remote: { a: 'r' } });
    const [plan] = await engine.plan([profile('a')]);
    fs.writeFileSync(path.join(dir, 'a.json'), 'appeared');

    const [outcome] = await engine.apply([{ plan, direction: 'download', candidate: plan.remoteContent }]);

    assert.equal(outcome.kind, 'stale-local');
});

test('upload whose local write fails: remote committed, retryPlan skips the DB on retry', { skip: process.getuid?.() === 0 }, async () => {
    const { engine, dir, remoteOf, localOf, writes, state } = await setup({ remote: { a: 'r' }, local: { a: 'l' } });
    const [plan] = await engine.plan([profile('a')]);
    const file = path.join(dir, 'a.json');
    fs.chmodSync(file, 0o444);
    let outcome;
    try {
        // An edited candidate forces a local rewrite.
        [outcome] = await engine.apply([{ plan, direction: 'upload', candidate: 'edited' }]);
    } finally {
        fs.chmodSync(file, 0o644);
    }
    assert.equal(outcome.kind, 'local-write-failed');
    assert.ok(outcome.kind === 'local-write-failed' && outcome.remoteCommitted);
    assert.equal(await remoteOf('a'), 'edited');
    assert.equal(state.get(engine.keyFor(profile('a'))), undefined, 'no baseline until both sides are written');
    assert.equal(writes(), 1);

    const retry = outcome.kind === 'local-write-failed' ? outcome.retryPlan : plan;
    const [again] = await engine.apply([{ plan: retry, direction: 'upload', candidate: 'edited' }]);

    assert.equal(again.kind, 'ok');
    assert.equal(writes(), 1, 'retry did not write the remote again');
    assert.equal(localOf('a'), 'edited');
    assert.ok(state.get(engine.keyFor(profile('a'))));
});

test('re-editing a remote-committed row writes the remote again, conditional on the committed version', async () => {
    const { engine, dir, remoteOf, writes } = await setup({ remote: { a: 'r' }, local: { a: 'l' } });
    const [plan] = await engine.plan([profile('a')]);
    fs.chmodSync(path.join(dir, 'a.json'), 0o444);
    let first;
    try {
        [first] = await engine.apply([{ plan, direction: 'upload', candidate: 'edit-1' }]);
    } finally {
        fs.chmodSync(path.join(dir, 'a.json'), 0o644);
    }
    if (first.kind !== 'local-write-failed') assert.fail(`expected local-write-failed, got ${first.kind}`);

    const [second] = await engine.apply([{ plan: first.retryPlan, direction: 'upload', candidate: 'edit-2' }]);

    assert.equal(second.kind, 'ok');
    assert.equal(writes(), 2);
    assert.equal(await remoteOf('a'), 'edit-2');
});

test('merge-error fails only that request', async () => {
    const p = profile('a', { excludeKeys: ['x.y'] });
    const { engine, remoteOf } = await setup({
        remote: { a: '{"x": {"y": 1}}', b: 'rb' },
        local: { a: '{"x": {"y": 2}, "z": 0}', b: 'lb' }
    });
    const plans = await engine.plan([p, profile('b')]);

    const outcomes = await engine.apply([
        { plan: plans[0], direction: 'upload', candidate: '{"x": "scalar"}' }, // blocks x.y
        { plan: plans[1], direction: 'upload', candidate: plans[1].localContent }
    ]);

    assert.deepEqual(outcomes.map((o) => o.kind), ['merge-error', 'ok']);
    assert.equal(await remoteOf('b'), 'lb');
});

test('identical plans record a baseline, but never over a newer one written meanwhile', async () => {
    const { engine, state } = await setup({ remote: { a: 'same' }, local: { a: 'same' } });
    const key = engine.keyFor(profile('a'));

    await engine.plan([profile('a')]);
    const first = state.get(key)!;
    assert.ok(first);

    // Another writer records a baseline stamped in the future relative to the next plan's start.
    state.put({ ...first, baseHash: 'newer', syncedAt: '2099-01-01T00:00:00.000Z' });
    await engine.plan([profile('a')]);

    assert.equal(state.get(key)!.baseHash, 'newer');
});

test('a baseline write failure does not fail the sync', async () => {
    const { engine, dir, remoteOf } = await setup({ remote: { a: 'r' }, local: { a: 'l' } });
    fs.writeFileSync(path.join(dir, 'state'), 'not a directory');
    const [plan] = await engine.plan([profile('a')]);

    const [outcome] = await engine.apply([{ plan, direction: 'upload', candidate: plan.localContent }]);

    assert.equal(outcome.kind, 'ok');
    assert.ok(outcome.kind === 'ok' && outcome.baselineError);
    assert.equal(await remoteOf('a'), 'l');
});

test('non-stale database errors are thrown with nothing written', async () => {
    const { engine, pg, localOf } = await setup({ remote: { a: 'r' }, local: { a: 'l' } });
    const [plan] = await engine.plan([profile('a')]);
    await pg.db.exec('ALTER TABLE records RENAME TO gone');

    await assert.rejects(engine.apply([{ plan, direction: 'upload', candidate: 'x' }]), /gone|records/);
    assert.equal(localOf('a'), 'l');
});

// ── review round 1 regressions ─────────────────────────────────────────

test('a local file saved while the remote write is in flight is not overwritten (download and upload rows)', async () => {
    const { engine, pg, dir, localOf, remoteOf } = await setup({
        remote: { a: 'ra', b: 'rb' },
        local: { a: 'la', b: 'lb' }
    });
    const plans = await engine.plan([profile('a'), profile('b')]);
    const realTx = pg.sql.transaction;
    pg.sql.transaction = async (queries: unknown[]) => {
        const result = await realTx(queries);
        // The user saves both files while the batch is on the wire.
        fs.writeFileSync(path.join(dir, 'a.json'), 'saved-a');
        fs.writeFileSync(path.join(dir, 'b.json'), 'saved-b');
        return result;
    };

    const outcomes = await engine.apply([
        { plan: plans[0], direction: 'upload', candidate: 'edited-a' },          // local rewrite needed
        { plan: plans[1], direction: 'download', candidate: plans[1].remoteContent }
    ]);

    assert.deepEqual(outcomes.map((o) => [o.kind, o.kind === 'stale-local' && o.remoteCommitted]), [
        ['stale-local', true],
        ['stale-local', false]
    ]);
    assert.equal(localOf('a'), 'saved-a');
    assert.equal(localOf('b'), 'saved-b');
    assert.equal(await remoteOf('a'), 'edited-a');
});

test('two requests for the same local file are refused before anything is written', async () => {
    const { engine, remoteOf } = await setup({ remote: { a: 'ra', b: 'rb' }, local: { shared: 'l' } });
    const a = profile('a', { filePath: 'shared.json' });
    const b = profile('b', { filePath: 'shared.json' });
    const plans = await engine.plan([a, b]);

    await assert.rejects(
        engine.apply(plans.map((plan) => ({ plan, direction: 'upload' as const, candidate: 'x' }))),
        /Profiles "a" and "b" use the same local file/
    );
    assert.deepEqual([await remoteOf('a'), await remoteOf('b')], ['ra', 'rb']);
});

test('uploading an empty file to a missing row creates the row', async () => {
    const { engine, remoteOf } = await setup({ local: { a: '' } });
    const [plan] = await engine.plan([profile('a')]);

    const [outcome] = await engine.apply([{ plan, direction: 'upload', candidate: plan.localContent }]);

    assert.equal(outcome.kind, 'ok');
    assert.equal(await remoteOf('a'), '');
});

// chmod can't revoke read access on Windows (it only toggles read-only), and root ignores it.
test('a local file that becomes unreadable after the remote commit fails only its own row', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
    const { engine, pg, dir, localOf, remoteOf, state } = await setup({ remote: { a: 'ra', b: 'rb' }, local: { a: 'la', b: 'lb' } });
    const plans = await engine.plan([profile('a'), profile('b')]);
    const realTx = pg.sql.transaction;
    pg.sql.transaction = async (queries: unknown[]) => {
        const result = await realTx(queries);
        fs.chmodSync(path.join(dir, 'a.json'), 0o000);
        return result;
    };

    let outcomes;
    try {
        outcomes = await engine.apply(plans.map((plan, i) => ({ plan, direction: 'upload' as const, candidate: `edited-${'ab'[i]}` })));
    } finally {
        fs.chmodSync(path.join(dir, 'a.json'), 0o644);
    }

    assert.deepEqual(outcomes.map((o) => o.kind), ['local-write-failed', 'ok']);
    assert.ok(outcomes[0].kind === 'local-write-failed' && outcomes[0].remoteCommitted);
    assert.deepEqual([await remoteOf('a'), await remoteOf('b')], ['edited-a', 'edited-b']);
    assert.equal(localOf('b'), 'edited-b');
    assert.ok(state.get(engine.keyFor(profile('b'))));
});
