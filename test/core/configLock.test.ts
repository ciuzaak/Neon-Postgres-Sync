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

test('release only removes our own lock (a lock taken over from us survives, and we do not write)', () => {
    const configPath = tmpConfig();
    const store = new ConfigFileStore(configPath);
    assert.throws(() => store.update((c) => {
        if (!fs.existsSync(`${configPath}.lock`)) return c; // the unlocked dry run
        // Simulate: while we hold it, someone else's lock replaces ours.
        fs.rmSync(`${configPath}.lock`, { recursive: true });
        fs.mkdirSync(`${configPath}.lock`);
        fs.writeFileSync(`${configPath}.lock/owner`, 'someone-else');
        return c;
    }), ConfigLockedError);
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

test('a writer whose lock was taken over while it stalled does not write its stale read', () => {
    const configPath = tmpConfig();
    const store = new ConfigFileStore(configPath);
    store.saveProfiles([{ name: 'before', filePath: '~/b', id: 'b', tableName: 't' }]);

    assert.throws(() => store.update((c) => {
        if (fs.existsSync(`${configPath}.lock`)) {
            // Stalled past the stale timeout: another writer took over and wrote.
            fs.writeFileSync(`${configPath}.lock/owner`, 'someone-else');
            fs.writeFileSync(configPath, JSON.stringify({ profiles: [{ name: 'theirs', filePath: '~/t', id: 't', tableName: 't' }] }));
        }
        return { ...c, profiles: [...c.profiles, { name: 'mine', filePath: '~/m', id: 'm', tableName: 't' }] };
    }), ConfigLockedError);

    assert.deepEqual(store.read()!.profiles.map((p) => p.name), ['theirs']);
});

// ── Windows: transient EPERM/EACCES/EBUSY while another process holds or deletes a path ──

/** Pretend to be Windows and make `fs[method]` fail with `code` for the first `times` calls matching `match`. */
function withWindowsFaults<T>(method: 'mkdirSync' | 'renameSync' | 'readFileSync', code: string | ((n: number) => string), times: number, match: (p: string) => boolean, fn: () => T): { result?: T; error?: unknown; faults: number } {
    const real = fs[method] as (...args: unknown[]) => unknown;
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    let faults = 0;
    try {
        (fs as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
            const target = String(method === 'renameSync' ? args[1] : args[0]);
            if (match(target) && faults < times) {
                const c = typeof code === 'function' ? code(faults) : code;
                faults++;
                throw Object.assign(new Error(`${c}: injected, ${method} '${target}'`), { code: c });
            }
            return real.apply(fs, args);
        };
        Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
        return { result: fn(), faults };
    } catch (error) {
        return { error, faults };
    } finally {
        (fs as unknown as Record<string, unknown>)[method] = real;
        Object.defineProperty(process, 'platform', platform);
    }
}

const addProfile = (store: ConfigFileStore, name: string) =>
    store.update((c) => ({ ...c, profiles: [...c.profiles, { name, filePath: `~/${name}`, id: name, tableName: 't' }] }));

test('Windows: a lock being deleted by another process (EPERM on mkdir) is waited for, not an error', () => {
    const configPath = tmpConfig();
    const store = new ConfigFileStore(configPath, { lockWaitMs: 2000 });
    const r = withWindowsFaults('mkdirSync', 'EPERM', 3, (p) => p.endsWith('.lock'), () => addProfile(store, 'a'));
    assert.equal(r.error, undefined, String(r.error));
    assert.equal(r.faults, 3);
    assert.deepEqual(store.read()!.profiles.map((p) => p.name), ['a']);
    assert.equal(fs.existsSync(`${configPath}.lock`), false);
});

test('Windows: an EPERM that persists past the lock deadline is rethrown as itself (a real permission problem)', () => {
    const store = new ConfigFileStore(tmpConfig(), { lockWaitMs: 150 });
    const r = withWindowsFaults('mkdirSync', 'EPERM', Infinity, (p) => p.endsWith('.lock'), () => addProfile(store, 'a'));
    assert.equal((r.error as NodeJS.ErrnoException)?.code, 'EPERM');
    assert.ok(!(r.error instanceof ConfigLockedError));
});

test('Windows: replacing the config while a reader has it open (EPERM/EBUSY on rename) is retried', () => {
    for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
        const configPath = tmpConfig();
        const store = new ConfigFileStore(configPath, { lockWaitMs: 2000 });
        addProfile(store, 'first');
        const r = withWindowsFaults('renameSync', code, 2, (p) => path.basename(p) === 'neon-sync.json', () => addProfile(store, 'second'));
        assert.equal(r.error, undefined, `${code}: ${String(r.error)}`);
        assert.equal(r.faults, 2, code);
        assert.deepEqual(store.read()!.profiles.map((p) => p.name), ['first', 'second'], code);
        assert.deepEqual(fs.readdirSync(path.dirname(configPath)).filter((f) => f.endsWith('.tmp')), [], `${code}: no temp file left`);
    }
});

test('the same errors are not retried on other platforms, nor other codes on Windows', () => {
    const { retryWindowsTransient } = require('../../src/core/localFile') as typeof import('../../src/core/localFile');
    const failing = (code: string) => { let n = 0; return { fn: () => { n++; throw Object.assign(new Error(code), { code }); }, calls: () => n }; };
    for (const [platform, code] of [['linux', 'EPERM'], ['darwin', 'EBUSY'], ['win32', 'ENOENT'], ['win32', 'ENOSPC']] as const) {
        const f = failing(code);
        assert.throws(() => retryWindowsTransient(f.fn, platform, 500), { code });
        assert.equal(f.calls(), 1, `${platform} ${code}`);
    }
    const f = failing('EBUSY');
    const started = Date.now();
    assert.throws(() => retryWindowsTransient(f.fn, 'win32', 120), { code: 'EBUSY' });
    assert.ok(f.calls() > 1 && Date.now() - started < 1000, 'retried, but bounded');
});

test('Windows: a lock that was held and then hits "delete pending" at the deadline is ConfigLockedError, not EPERM', () => {
    // EEXIST (held by someone) first, then only EPERM: the holder is still around, so this is "busy".
    const store = new ConfigFileStore(tmpConfig(), { lockWaitMs: 150 });
    const r = withWindowsFaults('mkdirSync', (n) => (n < 3 ? 'EEXIST' : 'EPERM'), Infinity, (p) => p.endsWith('.lock'), () => addProfile(store, 'a'));
    assert.ok(r.error instanceof ConfigLockedError, String(r.error));
});

test('Windows: a config briefly unreadable (EPERM while renamed over) is retried; a lasting error is never read as "missing"', () => {
    const configPath = tmpConfig();
    const store = new ConfigFileStore(configPath, { lockWaitMs: 2000, transientRetryMs: 150 });
    addProfile(store, 'keep');
    const isConfig = (p: string) => path.basename(p) === 'neon-sync.json';

    const brief = withWindowsFaults('readFileSync', 'EPERM', 2, isConfig, () => store.read());
    assert.deepEqual(brief.result?.profiles.map((p) => p.name), ['keep']);

    // Lasting: update must fail, and must not rebuild the file from an empty list.
    const before = fs.readFileSync(configPath, 'utf-8');
    // existsSync reports false on any error (as for a delete-pending file): it must not be what decides "missing".
    const realExists = fs.existsSync;
    (fs as unknown as Record<string, unknown>).existsSync = (p: fs.PathLike) => (isConfig(String(p)) ? false : realExists(p));
    let lasting;
    try {
        lasting = withWindowsFaults('readFileSync', 'EPERM', Infinity, isConfig, () => addProfile(store, 'new'));
    } finally {
        (fs as unknown as Record<string, unknown>).existsSync = realExists;
    }
    assert.ok(lasting.error instanceof Error && lasting.error.name === 'ConfigFileReadError', String(lasting.error));
    assert.equal(fs.readFileSync(configPath, 'utf-8'), before);
});

test('sync-state writes (atomicWriteJson) retry a transient rename too', () => {
    const { atomicWriteJson } = require('../../src/core/configFile') as typeof import('../../src/core/configFile');
    const target = path.join(path.dirname(tmpConfig()), 'state.json');
    const r = withWindowsFaults('renameSync', 'EBUSY', 2, (p) => p === target, () => atomicWriteJson(target, { ok: true }));
    assert.equal(r.error, undefined, String(r.error));
    assert.equal(r.faults, 2);
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf-8')), { ok: true });
});
