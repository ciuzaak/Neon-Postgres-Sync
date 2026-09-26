import test = require('node:test');
import assert = require('node:assert/strict');
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { cliFixture, profile } from './harness';
import { shellArg } from '../../cli/src/context';
import { asciiByDefault, colorEnabled } from '../../cli/src/ui/format';

// Regressions from the final whole-branch review.

const ASCII_ONLY = /^[\x00-\x7f]*$/;

test('a terminal that reports 0 columns gets the default layout, not a collapsed one', async () => {
    const f = await cliFixture({ profiles: [profile('alpha')] });
    f.writeFile('~/alpha.json', '{}');
    const r = await f.run(['status'], { columns: 0 });
    assert.match(r.stdout, /alpha {2}~\/alpha\.json {2}local only/);
});

test('an incomplete or duplicated hand-edited profile is a configuration error naming the file', async () => {
    const cases: Array<[unknown[], RegExp]> = [
        [[{ name: 'x' }], /Profile #1 "x" in .*neon-sync\.json can't be used \(no filePath, id, tableName\)/],
        [[profile('a'), { ...profile('b'), tableName: 3 }], /Profile #2 "b" .*\(no tableName\)/],
        [[{ ...profile('a'), excludeKeys: 'theme' }], /excludeKeys is not a list of strings/],
        [[profile('x', { filePath: 'rel' }), profile('x', { filePath: '~/d', id: 'other' })], /Two profiles are named "x"/]
    ];
    for (const [profiles, message] of cases) {
        const f = await cliFixture({ configRaw: JSON.stringify({ profiles }) });
        for (const argv of [['status'], ['profile', 'list'], ['profile', 'add', 'new', '--file', '~/n.json', '--id', 'n'], ['profile', 'rename', 'x', 'y']]) {
            const r = await f.run(argv);
            assert.equal(r.code, 2, `${argv.join(' ')}: ${r.stderr}`);
            assert.match(r.stderr, message, argv.join(' '));
        }
    }
});

test('a missing table name is refused by the core check too (RegExp.test would accept "undefined")', () => {
    const { assertValidTableName } = require('../../src/core/db') as typeof import('../../src/core/db');
    assert.throws(() => assertValidTableName(undefined as unknown as string), /Invalid table name/);
});

test('a corrupt config is exit 2 for every command, including ones that write it', async () => {
    const f = await cliFixture({ configRaw: '{ broken' });
    for (const argv of [['status'], ['profile', 'add', 'c', '--file', '~/c.json', '--id', 'c'], ['profile', 'rename', 'a', 'b'], ['profile', 'remove', 'a', '--yes']]) {
        const r = await f.run(argv);
        assert.equal(r.code, 2, argv.join(' '));
        assert.match(r.stderr, /Failed to parse/, argv.join(' '));
    }
});

test('profile show exits 4 for a blocked profile, with or without --json', async () => {
    const f = await cliFixture({ profiles: [profile('rel', { filePath: 'relative.json' })] });
    assert.equal((await f.run(['profile', 'show', 'rel'])).code, 4);
    const j = await f.run(['profile', 'show', 'rel', '--json']);
    assert.equal(j.code, 4);
    assert.match(JSON.parse(j.stdout).blocked, /relative path/);
});

test('--ascii output is ASCII: status errors, profile add/show, diffs and reports', async () => {
    const f = await cliFixture({ profiles: [profile('rel', { filePath: 'relative.json' }), profile('shared1', { filePath: '~/s.json' }), profile('shared2', { filePath: '~/s.json', id: 's2' })] });
    const runs = [
        await f.run(['status', '--ascii']),
        await f.run(['profile', 'add', 'n', '--file', '~/n.json', '--id', 'n', '--ascii']),
        await f.run(['profile', 'show', 'n', '--ascii']),
        await f.run(['sync', '--yes', '--ascii']),
        await f.run(['diff', 'rel', '--ascii'])
    ];
    for (const r of runs) {
        assert.match(r.stdout, ASCII_ONLY, r.stdout);
        assert.match(r.stderr, ASCII_ONLY, r.stderr);
    }
    assert.match(runs[1].stdout, /~\/n\.json <-> json_records\/n/);
    f.writeFile('~/n.json', '{"a": 1}');
    await f.setRemote('n', '{"a": 2}');
    for (const r of [await f.run(['diff', 'n', '--ascii', '--direction', 'upload']), await f.run(['push', 'n', '--yes', '--force', '--ascii'])]) {
        const ours = r.stdout.split('\n').filter((l) => !/^[-+ ]/.test(l)).join('\n'); // file content lines are the user's
        assert.match(ours, ASCII_ONLY, r.stdout);
    }
});

test('TERM=dumb: no colors and ASCII symbols; legacy Windows consoles default to ASCII', () => {
    assert.equal(colorEnabled(true, { TERM: 'dumb' }, false), false);
    assert.equal(colorEnabled(true, { TERM: 'xterm-256color' }, false), true);
    assert.equal(asciiByDefault('win32', {}), true);
    assert.equal(asciiByDefault('win32', { WT_SESSION: '1' }), false);
    assert.equal(asciiByDefault('darwin', {}), false);
});

test('`neon-sync help` prints the help; a flag on bare `neon-sync` names the real problem', async () => {
    const f = await cliFixture();
    const h = await f.run(['help']);
    assert.equal(h.code, 0);
    assert.match(h.stdout, /^neon-sync — sync local config files/);
    const r = await f.run(['--dry-run']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /`neon-sync` on its own shows status, which doesn't take --dry-run/);
});

test('config subcommands without arguments refuse extra ones', async () => {
    const f = await cliFixture();
    for (const sub of ['path', 'clear-url', 'test']) {
        const r = await f.run(['config', sub, 'extra']);
        assert.equal(r.code, 2, sub);
        assert.match(r.stderr, new RegExp(`\`config ${sub}\` takes no arguments`));
    }
    assert.equal(f.keychain.value, 'postgres://user:pw@db.example.test/neondb', 'clear-url extra did nothing');
});

test('a blank (whitespace) NEON_SYNC_DATABASE_URL is an error, not a silent fall-back to the keychain', async () => {
    const f = await cliFixture({ profiles: [profile('a')] });
    let keychainRead = false;
    const get = f.keychain.get.bind(f.keychain);
    f.keychain.get = async () => { keychainRead = true; return get(); };
    const r = await f.run(['status'], { env: { NEON_SYNC_DATABASE_URL: '   ' } });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /NEON_SYNC_DATABASE_URL is set but blank/);
    assert.equal(keychainRead, false);
    // Empty is the usual "unset for one command": the keychain is used.
    assert.notEqual((await f.run(['status'], { env: { NEON_SYNC_DATABASE_URL: '' } })).code, 2);
});

test('profile add resolves a relative --file against --base, and names the field that is wrong', async () => {
    const f = await cliFixture();
    const base = path.join(f.home, 'proj');
    const r = await f.run(['profile', 'add', 'b', '--file', 'sub/b.json', '--id', 'b', '--base', base]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(fs.readFileSync(f.configPath, 'utf-8')).profiles[0].filePath, '~/proj/sub/b.json');
    const bad = await f.run(['profile', 'add', 'c', '--file', '~/c.json', '--id', 'c', '--table', 'bad-table']);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /--table: Only letters/);
});

test('suggested commands quote profile names for the shell', async () => {
    assert.equal(shellArg('plain-name_1.x', 'linux'), 'plain-name_1.x');
    assert.equal(shellArg("it's mine", 'linux'), `'it'\\''s mine'`);
    assert.equal(shellArg('two words', 'win32'), '"two words"');
    const f = await cliFixture();
    const r = await f.run(['profile', 'add', 'my app', '--file', '~/app.json', '--id', 'app']);
    assert.match(r.stdout, process.platform === 'win32' ? /Next: `neon-sync status "my app"`/ : /Next: `neon-sync status 'my app'`/);
});

test('names that match nothing say when prefixes apply', async () => {
    const f = await cliFixture({ profiles: [profile('antigravity')] });
    assert.match((await f.run(['status', 'anti'])).stderr, /No profile named "anti" \(prefixes only work in a terminal, without --yes or --json\)/);
    assert.match((await f.run(['profile', 'remove', 'anti'], { tty: true })).stderr, /\(`profile remove` needs the exact name\)/);
    const shown = await f.run(['profile', 'show', 'anti'], { tty: true });
    assert.equal(shown.code, 0, 'profile show takes a prefix in a terminal, like status');
});

test('reports line up: names are padded', async () => {
    const f = await cliFixture({ profiles: [profile('a'), profile('longer-name')] });
    f.writeFile('~/a.json', '{}');
    f.writeFile('~/longer-name.json', '{}');
    const r = await f.run(['push', '--all', '--dry-run']);
    const lines = r.stdout.split('\n').filter((l) => /would upload/.test(l));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].indexOf('would'), lines[1].indexOf('would'));
});

test('an unreachable database says so plainly (not "error: Error connecting…")', async () => {
    const f = await cliFixture({ profiles: [profile('a')] });
    // (The driver's queries are lazy: only the transaction runs, so only it fails.)
    f.pg.sql.transaction = async () => { throw new Error('Error connecting to database: TypeError: fetch failed'); };
    const r = await f.run(['status']);
    assert.equal(r.code, 3);
    assert.equal(r.stderr, "neon-sync: couldn't reach the database (TypeError: fetch failed). Check your network and the URL (`neon-sync config test`).\n");
});

test('a file on a Windows drive seen from WSL is a row error (exit 4), not a sync', { skip: process.platform === 'win32' }, async () => {
    const f = await cliFixture({ profiles: [profile('win', { filePath: '/mnt/c/Users/me/settings.json' })] });
    const r = await f.run(['status'], { platform: 'linux', platformEnv: { WSL_DISTRO_NAME: 'Ubuntu' } });
    assert.equal(r.code, 4);
    assert.match(r.stdout, /across WSL/);
});

test('piping into a reader that stops early (| head) ends quietly', { skip: process.platform === 'win32' }, async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'neon-sync-epipe-'));
    const config = path.join(home, 'profiles.json');
    const profiles = Array.from({ length: 3000 }, (_, i) => profile(`profile-${i}`));
    fs.writeFileSync(config, JSON.stringify({ profiles }));
    const bin = path.join(__dirname, '..', '..', 'cli', 'src', 'bin.js');
    const env = { PATH: process.env.PATH ?? '', HOME: home, USERPROFILE: home, NEON_SYNC_DATABASE_URL: 'postgres://u:p@db.example.invalid/db' };
    const child = childProcess.spawn(process.execPath, [bin, 'profile', 'list', '--config', config], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdout.once('data', () => child.stdout.destroy());
    const code = await new Promise<number | null>((resolve) => child.on('close', (c) => resolve(c)));
    assert.equal(stderr, '');
    assert.equal(code, 141);
});

test('round 2: help takes any trailing words; config test does not suggest itself; profile list caps the path column', async () => {
    const f = await cliFixture({ profiles: [profile('a', { filePath: '/' + 'very-long-directory-name/'.repeat(6) + 'x.json' }), profile('b')] });
    assert.match((await f.run(['help', 'status'])).stdout, /^neon-sync — sync/);
    f.pg.sql.transaction = async () => { throw new Error('Error connecting to database: TypeError: fetch failed'); };
    f.pg.sql.query = f.pg.sql.transaction as never;
    const t = await f.run(['config', 'test']);
    assert.equal(t.code, 3);
    assert.doesNotMatch(t.stderr, /config test/);
    const lines = (await f.run(['profile', 'list'])).stdout.trimEnd().split('\n');
    assert.ok(lines.every((l) => l.length < 90), lines.join('\n'));
    assert.equal(lines[0].indexOf('records/'), lines[1].indexOf('records/'));
});

test('round 2: a missing keychain module is reported on one line', () => {
    const { KeychainUnavailableError } = require('../../cli/src/secrets') as typeof import('../../cli/src/secrets');
    const e = new KeychainUnavailableError(new Error("Cannot find module '@napi-rs/keyring'\nRequire stack:\n- /x/neon-sync.cjs"));
    assert.equal(e.message, "the OS keychain is unavailable (Cannot find module '@napi-rs/keyring'); set NEON_SYNC_DATABASE_URL instead");
});
