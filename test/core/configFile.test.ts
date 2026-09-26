import test = require('node:test');
import assert = require('node:assert/strict');
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConfigFileReadError, ConfigFileStore, ConfigLockedError } from '../../src/core/configFile';
import type { ConfigFile } from '../../src/core/types';

function tempConfigPath(): string {
    return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neon-sync-core-config-')), 'neon-sync.json');
}

test('read returns undefined when the file does not exist', () => {
    assert.equal(new ConfigFileStore(tempConfigPath()).read(), undefined);
});

test('read throws ConfigFileReadError on malformed JSON', () => {
    const filePath = tempConfigPath();
    fs.writeFileSync(filePath, '{ nope');

    assert.throws(() => new ConfigFileStore(filePath).read(), (e: unknown) => {
        assert.ok(e instanceof ConfigFileReadError);
        assert.match(e.message, /^Failed to parse neon-sync\.json: /);
        return true;
    });
});

test('read wraps IO failures (e.g. the path is a directory) in ConfigFileReadError', () => {
    const filePath = tempConfigPath();
    fs.mkdirSync(filePath);

    assert.throws(() => new ConfigFileStore(filePath).read(), ConfigFileReadError);
});

test('saveProfiles normalizes profiles and preserves other top-level fields', () => {
    const filePath = tempConfigPath();
    fs.writeFileSync(filePath, JSON.stringify({ connectionString: 'postgres://legacy', profiles: [] }));
    const store = new ConfigFileStore(filePath);

    store.saveProfiles([
        { name: 'A', filePath: 'a.json', id: 'a', tableName: 't', excludeKeys: [] },
        { name: 'B', filePath: 'b.json', id: 'b', tableName: 't', excludeKeys: ['x'], extra: 1 } as never
    ]);

    const written = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as ConfigFile;
    assert.equal(written.connectionString, 'postgres://legacy');
    assert.deepEqual(written.profiles, [
        { name: 'A', filePath: 'a.json', id: 'a', tableName: 't' },
        { name: 'B', filePath: 'b.json', id: 'b', tableName: 't', excludeKeys: ['x'] }
    ]);
});

test('removeConnectionString drops only the legacy field', () => {
    const filePath = tempConfigPath();
    const profiles = [{ name: 'A', filePath: 'a.json', id: 'a', tableName: 't' }];
    fs.writeFileSync(filePath, JSON.stringify({ connectionString: 'postgres://legacy', profiles }));

    new ConfigFileStore(filePath).removeConnectionString();

    assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf-8')), { profiles });
});

test('ensureExists creates the file and parent directory once', () => {
    const filePath = path.join(path.dirname(tempConfigPath()), 'nested', 'neon-sync.json');
    const store = new ConfigFileStore(filePath);

    assert.equal(store.ensureExists({ profiles: [] }), true);
    assert.equal(store.ensureExists({ profiles: [{ name: 'ignored' } as never] }), false);
    assert.deepEqual(store.read(), { profiles: [] });
});

// ── update under the lock ──────────────────────────────────────────────

test('update applies the change to a fresh read, so interleaved writers both land', () => {
    const filePath = tempConfigPath();
    const a = new ConfigFileStore(filePath);
    const b = new ConfigFileStore(filePath);
    a.saveProfiles([{ name: 'one', filePath: '~/1', id: '1', tableName: 't' }]);

    // b "loaded" before a's second write, but its update runs on a fresh read.
    a.update((c) => ({ ...c, profiles: [...c.profiles, { name: 'two', filePath: '~/2', id: '2', tableName: 't' }] }));
    b.update((c) => ({ ...c, profiles: [...c.profiles, { name: 'three', filePath: '~/3', id: '3', tableName: 't' }] }));

    assert.deepEqual(a.read()!.profiles.map((p) => p.name), ['one', 'two', 'three']);
});

test('update returning undefined writes nothing; missing file starts empty and is created 0700', () => {
    const filePath = path.join(path.dirname(tempConfigPath()), 'new', 'neon-sync.json');
    const store = new ConfigFileStore(filePath);

    assert.equal(store.update(() => undefined), undefined);
    assert.equal(fs.existsSync(filePath), false);
    store.update((c) => c);
    assert.deepEqual(store.read(), { profiles: [] });
    if (process.platform !== 'win32') {
        assert.equal(fs.statSync(path.dirname(filePath)).mode & 0o777, 0o700);
    }
});

test('update refuses a corrupt file (never treats it as empty) and leaves it untouched', () => {
    const filePath = tempConfigPath();
    fs.writeFileSync(filePath, '{ "profiles": [ oops');
    const store = new ConfigFileStore(filePath);

    assert.throws(() => store.saveProfiles([]), ConfigFileReadError);
    assert.equal(fs.readFileSync(filePath, 'utf-8'), '{ "profiles": [ oops');
    fs.writeFileSync(filePath, '{"profiles": {"not": "an array"}}');
    assert.throws(() => store.read(), ConfigFileReadError);
});

test('update waits for a held lock and fails with ConfigLockedError after the wait', () => {
    const filePath = tempConfigPath();
    const store = new ConfigFileStore(filePath, { lockWaitMs: 100 });
    fs.mkdirSync(`${filePath}.lock`);

    assert.throws(() => store.saveProfiles([]), ConfigLockedError);
    fs.rmdirSync(`${filePath}.lock`);
    store.saveProfiles([]);
    assert.equal(fs.existsSync(`${filePath}.lock`), false, 'lock released after a write');
});

test('a stale lock (crashed writer) is taken over', () => {
    const filePath = tempConfigPath();
    const lock = `${filePath}.lock`;
    fs.mkdirSync(lock);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);

    new ConfigFileStore(filePath, { lockWaitMs: 100 }).saveProfiles([]);

    assert.deepEqual(new ConfigFileStore(filePath).read(), { profiles: [] });
});

test('a symlinked config (dotfiles manager) stays a symlink after a write', { skip: process.platform === 'win32' }, () => {
    const dir = path.dirname(tempConfigPath());
    const real = path.join(dir, 'dotfiles', 'neon-sync.json');
    fs.mkdirSync(path.dirname(real));
    fs.writeFileSync(real, '{"profiles": []}');
    const link = path.join(dir, 'neon-sync.json');
    fs.symlinkSync(real, link);

    new ConfigFileStore(link).saveProfiles([{ name: 'a', filePath: '~/a', id: 'a', tableName: 't' }]);

    assert.ok(fs.lstatSync(link).isSymbolicLink());
    assert.equal(JSON.parse(fs.readFileSync(real, 'utf-8')).profiles[0].name, 'a');
});
