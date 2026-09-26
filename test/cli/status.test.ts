import test = require('node:test');
import assert = require('node:assert/strict');
import { cliFixture, NEW, OLD, profile } from './harness';

interface JsonRow { name: string; status: string; direction: string | null; autoApplicable: boolean; label: string; error: string | null }
const rows = (stdout: string) => (JSON.parse(stdout) as { profiles: JsonRow[] }).profiles;
const byName = (stdout: string) => Object.fromEntries(rows(stdout).map((r) => [r.name, r]));

test('status with no profiles says how to add one and exits 0', async () => {
    const f = await cliFixture({ profiles: [] });
    const r = await f.run([]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /No profiles yet/);
});

test('first-time rows with one side missing are auto-applicable; identical rows are in sync', async () => {
    const f = await cliFixture({ profiles: [profile('remote-only'), profile('local-only'), profile('same')] });
    await f.setRemote('remote-only-id', 'R');
    f.writeFile('~/local-only.json', 'L');
    f.writeFile('~/same.json', 'S');
    await f.setRemote('same-id', 'S');

    const r = await f.run(['status', '--json']);

    assert.equal(r.code, 1, 'pending');
    const s = byName(r.stdout);
    assert.deepEqual([s['remote-only'].status, s['remote-only'].direction, s['remote-only'].autoApplicable], ['auto', 'download', true]);
    assert.deepEqual([s['local-only'].status, s['local-only'].direction], ['auto', 'upload']);
    assert.equal(s['same'].status, 'in-sync');
});

test('without sync history, a clear timestamp gap is still only a guess: decide, never auto', async () => {
    const f = await cliFixture({ profiles: [profile('guess')] });
    f.writeFile('~/guess.json', 'fresh defaults', NEW);
    await f.setRemote('guess-id', 'real settings', OLD);

    const s = byName((await f.run(['status', '--json'])).stdout).guess;

    assert.deepEqual([s.status, s.autoApplicable, s.direction], ['decide', false, 'upload']);
    assert.match(s.label, /^no history · newer local/);
});

test('with history: one-sided changes are auto; both changed is a conflict to decide', async () => {
    const f = await cliFixture({ profiles: [profile('mine'), profile('theirs'), profile('both')] });
    for (const n of ['mine', 'theirs', 'both']) {
        f.writeFile(`~/${n}.json`, 'base');
        await f.setRemote(`${n}-id`, 'base');
    }
    await f.run(['status']); // identical → records baselines

    f.writeFile('~/mine.json', 'local edit');
    await f.setRemote('theirs-id', 'remote edit');
    f.writeFile('~/both.json', 'local edit');
    await f.setRemote('both-id', 'remote edit');
    const s = byName((await f.run(['status', '--json'])).stdout);

    assert.deepEqual([s.mine.status, s.mine.direction, s.mine.label], ['auto', 'upload', 'local changed']);
    assert.deepEqual([s.theirs.status, s.theirs.direction, s.theirs.label], ['auto', 'download', 'remote changed']);
    assert.deepEqual([s.both.status, s.both.label], ['decide', 'both changed']);
});

test('a side deleted since the last sync needs a decision (restoring may undo a deliberate deletion)', async () => {
    const f = await cliFixture({ profiles: [profile('env')] });
    f.writeFile('~/env.json', 'SECRET=1');
    await f.setRemote('env-id', 'SECRET=1');
    await f.run(['status']);
    require('node:fs').unlinkSync(require('node:path').join(f.home, 'env.json'));

    const s = byName((await f.run(['status', '--json'])).stdout).env;

    assert.deepEqual([s.status, s.label], ['decide', 'deleted locally']);
});

test('a known-direction change that deletes most of the destination is a large deletion to decide', async () => {
    const f = await cliFixture({ profiles: [profile('big')] });
    const full = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    f.writeFile('~/big.json', full);
    await f.setRemote('big-id', full);
    await f.run(['status']);
    f.writeFile('~/big.json', 'line 0\nline 1'); // truncated locally

    const s = byName((await f.run(['status', '--json'])).stdout).big;

    assert.deepEqual([s.status, s.label], ['decide', 'large deletion']);
});

test('blocked rows (relative path, shared file) are errors with exit 4; --base unblocks relative paths', async () => {
    const f = await cliFixture({ profiles: [
        profile('rel', { filePath: 'notes.md' }),
        profile('a', { filePath: '~/shared.json' }),
        profile('b', { filePath: '~/shared.json' })
    ] });

    const r = await f.run(['status', '--json']);
    assert.equal(r.code, 4);
    const s = byName(r.stdout);
    assert.match(s.rel.error!, /^relative path: use ~\/… or an absolute path, or pass --base/);
    assert.match(s.a.error!, /^shared file: same local file as profile "b"/);

    f.writeFile('~/proj/notes.md', 'n');
    const withBase = byName((await f.run(['status', 'rel', '--json', '--base', `${f.home}/proj`])).stdout);
    assert.equal(withBase.rel.status, 'auto');
});

test('exit precedence: a stuck row (4) outranks pending rows (1)', async () => {
    const f = await cliFixture({ profiles: [profile('rel', { filePath: 'x.md' }), profile('new')] });
    f.writeFile('~/new.json', 'n');
    assert.equal((await f.run(['status'])).code, 4);
    assert.equal((await f.run(['status', 'new'])).code, 1);
});

test('names: exact in scripts, unique prefixes only interactively, clear errors otherwise', async () => {
    const f = await cliFixture({ profiles: [profile('env-prod'), profile('env-dev'), profile('zsh')] });
    f.writeFile('~/zsh.json', 'alias x=y');

    const script = await f.run(['status', 'zs', '--json']);
    assert.equal(script.code, 2);
    assert.match(script.stderr, /No profile named "zs" \(scripts need exact names\)/);

    const tty = await f.run(['status', 'zs'], { tty: true });
    assert.equal(tty.code, 1);
    assert.match(tty.stdout, /zsh/);

    const ambiguous = await f.run(['status', 'env'], { tty: true });
    assert.equal(ambiguous.code, 2);
    assert.match(ambiguous.stderr, /"env" matches several profiles: env-prod, env-dev/);
});

test('no database URL is a configuration error (exit 2) that says how to fix it', async () => {
    const f = await cliFixture({ profiles: [profile('a')], url: null });
    const r = await f.run(['status']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /No database URL\. Run `neon-sync config set-url`, or set NEON_SYNC_DATABASE_URL/);
});

test('NEON_SYNC_DATABASE_URL wins over the keychain, which is then never read', async () => {
    const f = await cliFixture({ profiles: [profile('a')], url: 'postgres://u:p@keychain.example/kdb' });
    f.writeFile('~/a.json', 'x');
    let reads = 0;
    const get = f.keychain.get.bind(f.keychain);
    f.keychain.get = async () => { reads += 1; return get(); };

    const r = await f.run(['status'], { env: { NEON_SYNC_DATABASE_URL: 'postgres://u:p@env.example/edb' } });

    assert.equal(r.code, 1);
    assert.match(r.stdout, /env\.example\/edb/);
    assert.equal(r.stdout.includes('keychain.example'), false);
    assert.equal(reads, 0);
});

test('status reads the keychain once per run (a read can prompt on macOS)', async () => {
    const f = await cliFixture({ profiles: [profile('a')] });
    f.writeFile('~/a.json', 'x');
    let reads = 0;
    const get = f.keychain.get.bind(f.keychain);
    f.keychain.get = async () => { reads += 1; return get(); };

    await f.run(['status']);

    assert.equal(reads, 1);
});

test('with the env var set, the native keychain module is never loaded', async () => {
    const f = await cliFixture({ profiles: [], url: null });
    const { OsKeychain } = require('../../cli/src/secrets') as typeof import('../../cli/src/secrets');
    for (const key of Object.keys(require.cache)) if (key.includes('@napi-rs')) delete require.cache[key];
    const osKeychain = new OsKeychain();
    f.keychain.get = () => osKeychain.get(); // would load the module if called

    const r = await f.run(['config', 'test'], { env: { NEON_SYNC_DATABASE_URL: 'postgres://u:p@env.example/db' } });

    assert.equal(r.code, 0);
    assert.equal(Object.keys(require.cache).some((k) => k.includes('@napi-rs')), false);
});

test('an unusable URL is rejected before the driver sees it (its error would quote the password)', async () => {
    const f = await cliFixture({ profiles: [profile('a')], url: null });
    for (const bad of ['postgres://alice:S3CRETPW@host:99999/mydb', 'postgres://alice:S3CRETPW@/mydb', 'mysql://alice:S3CRETPW@h/db']) {
        const r = await f.run(['status'], { env: { NEON_SYNC_DATABASE_URL: bad } });
        assert.equal(r.code, 2, bad);
        assert.match(r.stderr, /NEON_SYNC_DATABASE_URL can't be used/);
        assert.equal((r.stdout + r.stderr).includes('S3CRETPW'), false, bad);
    }
});

test('connection strings in driver errors are redacted', async () => {
    const f = await cliFixture({ profiles: [profile('a')], url: 'postgres://alice:S3CRETPW@db.example.test/neondb' });
    f.writeFile('~/a.json', 'x');
    f.pg.sql.transaction = (async () => {
        throw new Error('Error connecting to database: postgres://alice:S3CRETPW@db.example.test/neondb (password S3CRETPW)');
    }) as never;

    const r = await f.run(['status']);

    assert.equal(r.code, 3);
    assert.equal(r.stderr.includes('S3CRETPW'), false, r.stderr);
    assert.match(r.stderr, /postgres:\/\/\[redacted\]/);
});

test('narrow terminals: rows fit the width; the path column is dropped before names are unreadable', async () => {
    const f = await cliFixture({ profiles: [profile('a-rather-long-profile-name'), profile('b', { filePath: 'rel.md' })] });
    f.writeFile('~/a-rather-long-profile-name.json', 'x');
    const r = await f.run([], { columns: 40 });
    for (const line of r.stdout.split('\n')) {
        if (/^ {2}\S {2}/.test(line)) assert.ok(line.length <= 40, `${line.length}: ${line}`);
    }
});

test('a database failure is a runtime error (exit 3)', async () => {
    const f = await cliFixture({ profiles: [profile('a')] });
    await f.pg.db.exec('DROP TABLE records');
    const r = await f.run(['status']);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /^neon-sync: error: /);
});

test('a corrupt config is a configuration error naming the file', async () => {
    const f = await cliFixture({ configRaw: '{ nope' });
    const r = await f.run(['status']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /Failed to parse neon-sync\.json/);
});

test('human output: header, rows, summary; no color codes when not a TTY', async () => {
    const f = await cliFixture({ profiles: [profile('a'), profile('b')] });
    f.writeFile('~/a.json', 'x');
    await f.setRemote('b-id', 'y');
    f.writeFile('~/b.json', 'y');

    const r = await f.run([]);

    assert.match(r.stdout, /neon-sync · 2 profiles · db\.example\.test\/neondb · ~\/\.config\/neon-sync\/neon-sync\.json/);
    assert.match(r.stdout, /↑ {2}a {2}~\/a\.json +local only +\+1 −0/);
    assert.match(r.stdout, /✓ {2}b {2}~\/b\.json +in sync/);
    assert.match(r.stdout, /1 ready to apply/);
    assert.equal(/\x1b\[/.test(r.stdout), false);
    assert.equal(r.stdout.includes('user:pw'), false, 'credentials never printed');
});

test('--ascii swaps the symbols', async () => {
    const f = await cliFixture({ profiles: [profile('a')] });
    f.writeFile('~/a.json', 'x');
    const r = await f.run(['--ascii']);
    assert.match(r.stdout, /\^ {2}a /);
});

test('usage errors: unknown command, unknown flag, flags a command does not take', async () => {
    const f = await cliFixture({ profiles: [] });
    assert.match((await f.run(['frobnicate'])).stderr, /Unknown command "frobnicate"/);
    assert.match((await f.run(['--frob'])).stderr, /Unknown option --frob\. See `neon-sync --help`/);
    const r = await f.run(['config', 'path', '--json']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /`config` doesn't take --json/);
});
