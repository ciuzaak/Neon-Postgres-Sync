import test = require('node:test');
import assert = require('node:assert/strict');
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { filterFingerprint, hashProjection, SyncBaseline, SyncStateStore } from '../../src/core/syncState';

function tempStateDir(): string {
    return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neon-sync-state-')), 'nested', 'sync-state');
}

function entry(overrides: Partial<SyncBaseline> = {}): SyncBaseline {
    return {
        tableName: 'json_records',
        id: 'rec',
        localPath: '/abs/file.json',
        baseHash: hashProjection('base'),
        filterFingerprint: filterFingerprint([]),
        remoteVersion: 'v1',
        syncedAt: '2026-09-25T00:00:00.000Z',
        ...overrides
    };
}

/** The single file a store holds after exactly one put. */
function onlyFile(store: SyncStateStore): string {
    const files = fs.readdirSync(store.dir);
    assert.equal(files.length, 1);
    return path.join(store.dir, files[0]);
}

test('get returns undefined when nothing is stored, and put creates the directory', () => {
    const store = new SyncStateStore(tempStateDir());

    assert.equal(store.get(entry()), undefined);
    store.put(entry());

    assert.deepEqual(store.get(entry()), entry());
    assert.deepEqual(JSON.parse(fs.readFileSync(onlyFile(store), 'utf-8')), { version: 1, entry: entry() });
});

test('each key lives in its own file; put replaces only that key', () => {
    const store = new SyncStateStore(tempStateDir());
    store.put(entry());
    store.put(entry({ id: 'other' }));

    store.put(entry({ baseHash: 'new' }));

    assert.equal(fs.readdirSync(store.dir).length, 2);
    assert.equal(store.get(entry())?.baseHash, 'new');
    assert.equal(store.get(entry({ id: 'other' }))?.baseHash, hashProjection('base'));
});

test('keys: table is case-insensitive but schema-qualified as written; id and path are exact; name is irrelevant', () => {
    const store = new SyncStateStore(tempStateDir());
    store.put(entry());
    store.put(entry({ tableName: 'prod.records', baseHash: 'prod' }));

    assert.ok(store.get({ tableName: 'JSON_RECORDS', id: 'rec', localPath: '/abs/file.json' }));
    assert.equal(store.get({ tableName: 'public.json_records', id: 'rec', localPath: '/abs/file.json' }), undefined);
    assert.equal(
        store.get({ tableName: 'staging.records', id: 'rec', localPath: '/abs/file.json' }),
        undefined,
        'mirrored tables in different schemas must not share a baseline'
    );
    assert.equal(store.get({ tableName: 'json_records', id: 'REC', localPath: '/abs/file.json' }), undefined);
    assert.equal(store.get({ tableName: 'json_records', id: 'rec', localPath: '/abs/other.json' }), undefined);
});

test('delete removes one key and tolerates a missing entry', () => {
    const store = new SyncStateStore(tempStateDir());
    store.put(entry({ id: 'keep' }));
    store.put(entry({ id: 'drop' }));

    store.delete(entry({ id: 'drop' }));
    store.delete(entry({ id: 'never-stored' }));

    assert.ok(store.get(entry({ id: 'keep' })));
    assert.equal(store.get(entry({ id: 'drop' })), undefined);
});

test('a corrupt entry reads as empty, is replaced on the next write, and never affects other keys', () => {
    const store = new SyncStateStore(tempStateDir());
    store.put(entry());
    const file = onlyFile(store);
    store.put(entry({ id: 'other' }));
    fs.writeFileSync(file, '{ nope');

    assert.equal(store.get(entry()), undefined);
    assert.ok(store.get(entry({ id: 'other' })));
    store.put(entry());
    assert.deepEqual(store.get(entry()), entry());
});

test('an entry whose stored key does not match (hash collision / tampering) reads as empty', () => {
    const store = new SyncStateStore(tempStateDir());
    store.put(entry());
    fs.writeFileSync(onlyFile(store), JSON.stringify({ version: 1, entry: entry({ id: 'someone-else' }) }));

    assert.equal(store.get(entry()), undefined);
});

// chmod can't revoke read access on Windows (it only toggles read-only), and root ignores it.
test('an unreadable entry reads as empty but a write to it throws instead of guessing', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
    const store = new SyncStateStore(tempStateDir());
    store.put(entry());
    store.put(entry({ id: 'other' }));
    const file = path.join(store.dir, fs.readdirSync(store.dir).find((f) => {
        return JSON.parse(fs.readFileSync(path.join(store.dir, f), 'utf-8')).entry.id === 'rec';
    })!);
    fs.chmodSync(file, 0o000);

    try {
        assert.equal(store.get(entry()), undefined);
        assert.throws(() => store.put(entry({ baseHash: 'x' })), /unreadable/);
        assert.ok(store.get(entry({ id: 'other' })), 'other keys unaffected');
    } finally {
        fs.chmodSync(file, 0o644);
    }
    assert.equal(store.get(entry())?.baseHash, hashProjection('base'), 'original entry intact');
});

test('an entry written by another format version (number or string) is neither read nor overwritten', () => {
    for (const version of [2, '2']) {
        const store = new SyncStateStore(tempStateDir());
        store.put(entry());
        const file = onlyFile(store);
        const foreign = JSON.stringify({ version, entry: entry(), extra: true });
        fs.writeFileSync(file, foreign);

        assert.equal(store.get(entry()), undefined);
        store.put(entry({ baseHash: 'x' }));
        assert.equal(fs.readFileSync(file, 'utf-8'), foreign, `version ${JSON.stringify(version)}`);
    }
});

test('filterFingerprint is order-insensitive and distinguishes different sets', () => {
    assert.equal(filterFingerprint([['a'], ['b', 'c']]), filterFingerprint([['b', 'c'], ['a']]));
    assert.notEqual(filterFingerprint([['a']]), filterFingerprint([['a', 'b']]));
    assert.notEqual(filterFingerprint([['a.b']]), filterFingerprint([['a', 'b']]));
    assert.notEqual(filterFingerprint([]), filterFingerprint([['a']]));
});
