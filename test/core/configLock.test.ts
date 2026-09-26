import test = require('node:test');
import assert = require('node:assert/strict');
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConfigFileStore, ConfigLockedError } from '../../src/core/configFile';

const tmpConfig = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neon-sync-lock-')), 'neon-sync.json');
const makeStale = (p: string) => { const old = new Date(Date.now() - 60_000); fs.utimesSync(p, old, old); };
const MODULE = path.resolve(__dirname, '..', '..', 'src', 'core', 'configFile.js');

/** N processes each add one profile at the same moment; returns the profile names that made it. */
async function raceAsync(configPath: string, writers: number): Promise<string[]> {
    const start = Date.now() + 400;
    const script = `
        const { ConfigFileStore } = require(${JSON.stringify(MODULE)});
        const store = new ConfigFileStore(process.argv[1], { lockWaitMs: 10000 });
        while (Date.now() < ${start}) {}
        store.update((c) => ({ ...c, profiles: [...c.profiles, { name: 'w' + process.argv[2], filePath: '~/f' + process.argv[2], id: 'i', tableName: 't' }] }));`;
    const codes = await Promise.all(Array.from({ length: writers }, (_, i) => new Promise<number>((resolve) => {
        childProcess
            .spawn(process.execPath, ['-e', script, configPath, String(i)], { stdio: 'inherit' })
            .on('exit', (code) => resolve(code ?? 1));
    })));
    assert.deepEqual(codes, codes.map(() => 0), 'every writer succeeded');
    return new ConfigFileStore(configPath).read()!.profiles.map((p) => p.name);
}

test('concurrent writers taking over a stale lock never lose an update (multi-process)', async () => {
    for (let trial = 0; trial < 3; trial++) {
        const configPath = tmpConfig();
        fs.mkdirSync(`${configPath}.lock`);
        makeStale(`${configPath}.lock`);

        const names = await raceAsync(configPath, 8);

        assert.equal(names.length, 8, `trial ${trial}: ${names.join(',')}`);
        assert.equal(fs.existsSync(`${configPath}.lock`), false);
    }
});

test('concurrent writers without a stale lock never lose an update (multi-process)', async () => {
    const configPath = tmpConfig();
    assert.equal((await raceAsync(configPath, 8)).length, 8);
});

test('a stale lock with files inside (e.g. .DS_Store) is taken over, not spun on', () => {
    const configPath = tmpConfig();
    fs.mkdirSync(`${configPath}.lock`);
    fs.writeFileSync(`${configPath}.lock/.DS_Store`, 'x');
    makeStale(`${configPath}.lock`);

    new ConfigFileStore(configPath, { lockWaitMs: 500 }).saveProfiles([]);

    assert.deepEqual(new ConfigFileStore(configPath).read(), { profiles: [] });
});

test('a stale plain file where the lock should be is taken over too', () => {
    const configPath = tmpConfig();
    fs.writeFileSync(`${configPath}.lock`, '');
    makeStale(`${configPath}.lock`);

    new ConfigFileStore(configPath, { lockWaitMs: 500 }).saveProfiles([]);

    assert.ok(new ConfigFileStore(configPath).exists());
});

test('a fresh non-directory lock is waited on and then reported, never spun on forever', () => {
    const configPath = tmpConfig();
    fs.writeFileSync(`${configPath}.lock`, '');
    const started = Date.now();

    assert.throws(() => new ConfigFileStore(configPath, { lockWaitMs: 200 }).saveProfiles([]), ConfigLockedError);
    assert.ok(Date.now() - started < 2000);
});

test('release only removes our own lock (a lock taken over from us survives our release)', () => {
    const configPath = tmpConfig();
    const store = new ConfigFileStore(configPath);
    store.update((c) => {
        if (!fs.existsSync(`${configPath}.lock`)) return c; // the unlocked dry run
        // Simulate: while we hold it, someone else's lock replaces ours.
        fs.rmSync(`${configPath}.lock`, { recursive: true });
        fs.mkdirSync(`${configPath}.lock`);
        fs.writeFileSync(`${configPath}.lock/owner`, 'someone-else');
        return c;
    });
    assert.equal(fs.readFileSync(`${configPath}.lock/owner`, 'utf-8'), 'someone-else');
});

test('a no-op update takes no lock and creates nothing — works with a read-only config directory', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
    const configPath = tmpConfig();
    fs.writeFileSync(configPath, '{"profiles": []}');
    fs.chmodSync(path.dirname(configPath), 0o555);
    try {
        const store = new ConfigFileStore(configPath);
        assert.equal(store.update(() => undefined), undefined);
        store.removeConnectionString(); // nothing to remove → no write
        assert.equal(store.ensureExists({ profiles: [] }), false);
    } finally {
        fs.chmodSync(path.dirname(configPath), 0o755);
    }
});

test('ensureExists never reads an existing (possibly corrupt) file', () => {
    const configPath = tmpConfig();
    fs.writeFileSync(configPath, '{ corrupt');
    assert.equal(new ConfigFileStore(configPath).ensureExists({ profiles: [] }), false);
    assert.equal(fs.readFileSync(configPath, 'utf-8'), '{ corrupt');
});
