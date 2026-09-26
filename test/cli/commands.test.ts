import test = require('node:test');
import assert = require('node:assert/strict');
import * as fs from 'node:fs';
import * as path from 'node:path';
import { cliFixture, profile } from './harness';

// ── config ────────────────────────────────────────────────────────────

test('config path prints the shared config file and the machine-local state dir', async () => {
    const f = await cliFixture();
    const r = await f.run(['config', 'path']);
    assert.equal(r.code, 0);
    assert.ok(r.stdout.includes(`config  ${f.configPath}\n`), r.stdout);
    assert.match(r.stdout, /state {3}.*\.local[\\/]state[\\/]neon-sync[\\/]sync-state/);
});

test('config set-url refuses the URL as an argument (shell history)', async () => {
    const f = await cliFixture({ url: null });
    const r = await f.run(['config', 'set-url', 'postgres://u:secret@h/db']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /Don't pass the URL as an argument/);
    assert.equal(f.keychain.value, undefined);
    assert.equal(r.stderr.includes('secret'), false);
});

test('config set-url reads a piped URL, validates it, stores it in the keychain and never echoes it', async () => {
    const f = await cliFixture({ url: null });

    const bad = await f.run(['config', 'set-url'], { stdin: 'mysql://nope\n' });
    assert.equal(bad.code, 2);

    const ok = await f.run(['config', 'set-url'], { stdin: 'postgres://u:hunter2@ep-x.neon.tech/app\n' });
    assert.equal(ok.code, 0);
    assert.equal(f.keychain.value, 'postgres://u:hunter2@ep-x.neon.tech/app');
    assert.match(ok.stdout, /Saved the URL for ep-x\.neon\.tech\/app in the OS keychain/);
    assert.equal(ok.stdout.includes('hunter2'), false);
});

test('config set-url prompts (hidden) on a terminal; cancelling stores nothing', async () => {
    const f = await cliFixture({ url: null });
    const cancelled = await f.run(['config', 'set-url'], { tty: true, prompts: { password: async () => undefined } });
    assert.equal(cancelled.code, 1);
    assert.equal(f.keychain.value, undefined);

    const r = await f.run(['config', 'set-url'], { tty: true, prompts: { password: async () => 'postgresql://u:p@h/db' } });
    assert.equal(r.code, 0);
    assert.equal(f.keychain.value, 'postgresql://u:p@h/db');
});

test('config set-url notes that the env var takes precedence', async () => {
    const f = await cliFixture({ url: null });
    const r = await f.run(['config', 'set-url'], { stdin: 'postgres://u:p@h/db', env: { NEON_SYNC_DATABASE_URL: 'postgres://e' } });
    assert.match(r.stdout, /NEON_SYNC_DATABASE_URL is set and takes precedence/);
});

test('config clear-url removes the stored URL', async () => {
    const f = await cliFixture();
    assert.match((await f.run(['config', 'clear-url'])).stdout, /Removed the URL/);
    assert.equal(f.keychain.value, undefined);
    assert.match((await f.run(['config', 'clear-url'])).stdout, /No URL was stored/);
});

test('config test connects and reports host/db and the URL source, never credentials', async () => {
    const f = await cliFixture();
    const r = await f.run(['config', 'test']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Connected to db\.example\.test\/neondb \(URL from the OS keychain\)/);
    assert.equal(r.stdout.includes('pw'), false);
});

test('config test reports a connection failure as a runtime error (exit 3)', async () => {
    const f = await cliFixture();
    f.pg.sql.query = (() => Promise.reject(new Error('connect ECONNREFUSED'))) as never;
    const r = await f.run(['config', 'test']);
    assert.equal(r.code, 3);
    assert.match(r.stderr, /ECONNREFUSED/);
});

test('an unavailable keychain is a configuration error pointing at the env var', async () => {
    const f = await cliFixture({ profiles: [profile('a')] });
    const { KeychainUnavailableError } = require('../../cli/src/secrets') as typeof import('../../cli/src/secrets');
    f.keychain.get = async () => { throw new KeychainUnavailableError(new Error('no Secret Service')); };
    const r = await f.run(['status']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /OS keychain is unavailable \(no Secret Service\); set NEON_SYNC_DATABASE_URL instead/);
});

// ── profile ───────────────────────────────────────────────────────────

test('profile list shows names, paths, records and excluded keys; --json gives the raw list', async () => {
    const f = await cliFixture({ profiles: [profile('vscode', { excludeKeys: ['editor.fontSize'] }), profile('zsh')] });
    const r = await f.run(['profile', 'list']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /vscode {2}~\/vscode\.json {2}records\/vscode-id {2}excludes editor\.fontSize/);
    const json = JSON.parse((await f.run(['profile', 'list', '--json'])).stdout);
    assert.deepEqual(json.profiles.map((p: { name: string }) => p.name), ['vscode', 'zsh']);
});

test('profile show resolves the path and explains a blocked profile (exit 4)', async () => {
    const f = await cliFixture({ profiles: [profile('ok'), profile('rel', { filePath: 'x.md' })] });
    const ok = await f.run(['profile', 'show', 'ok']);
    assert.equal(ok.code, 0);
    assert.ok(ok.stdout.includes(`~/ok.json  → ${path.join(f.home, 'ok.json')}`), ok.stdout);

    const rel = await f.run(['profile', 'show', 'rel']);
    assert.equal(rel.code, 4);
    assert.match(rel.stdout, /can't sync \(relative path\)/);
});

test('--config points a run at another profiles file', async () => {
    const f = await cliFixture({ profiles: [profile('default')] });
    const other = path.join(f.home, 'other.json');
    fs.writeFileSync(other, JSON.stringify({ profiles: [profile('other')] }));
    const r = await f.run(['profile', 'list', '--config', other]);
    assert.match(r.stdout, /other/);
    assert.equal(r.stdout.includes('default'), false);
});

test('--help and --version', async () => {
    const f = await cliFixture();
    assert.match((await f.run(['--help'])).stdout, /Exit codes: 0 in sync/);
    assert.match((await f.run(['-v'])).stdout, /^\d+\.\d+\.\d+/);
});
