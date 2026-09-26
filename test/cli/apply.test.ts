import test = require('node:test');
import assert = require('node:assert/strict');
import * as fs from 'node:fs';
import * as path from 'node:path';
import { cliFixture, NEW, OLD, profile, type CliFixture } from './harness';

/** Local and remote both hold `content`, and a baseline records that. */
async function synced(f: CliFixture, name: string, content = 'base') {
    f.writeFile(`~/${name}.json`, content);
    await f.setRemote(`${name}-id`, content);
}

async function withBaselines(f: CliFixture) {
    const r = await f.run(['status']);
    assert.ok(r.code === 0 || r.code === 1 || r.code === 4, r.stderr);
}

type Json = { outcomes: Array<{ name: string; kind: string; direction?: string; reason?: string }> };
const outcomes = (stdout: string) => Object.fromEntries((JSON.parse(stdout) as Json).outcomes.map((o) => [o.name, o]));

test('sync --yes applies only safe rows; conflicts and guesses are skipped with how to decide', async () => {
    const f = await cliFixture({ profiles: [profile('up'), profile('down'), profile('both'), profile('guess')] });
    for (const n of ['up', 'down', 'both']) await synced(f, n);
    await withBaselines(f);
    f.writeFile('~/up.json', 'local edit');
    await f.setRemote('down-id', 'remote edit');
    f.writeFile('~/both.json', 'local edit');
    await f.setRemote('both-id', 'remote edit');
    f.writeFile('~/guess.json', 'fresh defaults', NEW);
    await f.setRemote('guess-id', 'real settings', OLD);

    const r = await f.run(['sync', '--yes', '--json']);

    assert.equal(r.code, 1, 'skipped rows still need a decision');
    const o = outcomes(r.stdout);
    assert.deepEqual([o.up.kind, o.up.direction], ['applied', 'upload']);
    assert.deepEqual([o.down.kind, o.down.direction], ['applied', 'download']);
    assert.equal(o.both.kind, 'skipped');
    assert.match(o.both.reason!, /needs a decision: both changed.*--prefer local\|remote/);
    assert.equal(o.guess.kind, 'skipped');
    assert.equal(await f.remote('up-id'), 'local edit');
    assert.equal(f.file('~/down.json'), 'remote edit');
    assert.equal(await f.remote('guess-id'), 'real settings', 'the timestamp guess was not applied');
    assert.equal(f.file('~/both.json'), 'local edit');
});

test('without a terminal and without --yes nothing is written (exit 1); --dry-run previews', async () => {
    const f = await cliFixture({ profiles: [profile('a')] });
    f.writeFile('~/a.json', 'new');

    const plain = await f.run(['sync']);
    assert.equal(plain.code, 1);
    assert.match(plain.stdout, /a {2}would upload/);
    assert.match(plain.stdout, /Nothing was written: add --yes/);
    assert.equal(await f.remote('a-id'), undefined);

    const dry = await f.run(['sync', '--dry-run', '--json']);
    assert.equal(JSON.parse(dry.stdout).dryRun, true);
    assert.equal(outcomes(dry.stdout).a.kind, 'would-apply');
    assert.equal(await f.remote('a-id'), undefined);
});

test('usage rules: --json needs --yes/--dry-run; --prefer needs names; sync has no --force; pull/push need names or --all', async () => {
    const f = await cliFixture({ profiles: [profile('a')] });
    const cases: Array<[string[], RegExp]> = [
        [['sync', '--json'], /--json never prompts/],
        [['sync', '--prefer', 'local', '--yes'], /--prefer needs explicit profile names/],
        [['sync', 'a', '--prefer', 'mine', '--yes'], /--prefer must be "local" or "remote"/],
        [['sync', '--force'], /`sync` doesn't take --force/],
        [['pull', '--yes'], /`pull` needs profile names, or --all/],
        [['push', 'a', '--all'], /not both/],
        [['diff', 'a', '--direction', 'sideways'], /--direction must be "upload" or "download"/]
    ];
    for (const [argv, message] of cases) {
        const r = await f.run(argv);
        assert.equal(r.code, 2, argv.join(' '));
        assert.match(r.stderr, message, argv.join(' '));
    }
});

test('--prefer with a name decides that conflict', async () => {
    const f = await cliFixture({ profiles: [profile('env')] });
    await synced(f, 'env');
    await withBaselines(f);
    f.writeFile('~/env.json', 'mine');
    await f.setRemote('env-id', 'theirs');

    const r = await f.run(['sync', 'env', '--prefer', 'local', '--yes']);

    assert.equal(r.code, 0);
    assert.equal(await f.remote('env-id'), 'mine');
});

test('a side deleted since the last sync can be restored but never "propagated" (no empty writes)', async () => {
    const f = await cliFixture({ profiles: [profile('env')] });
    await synced(f, 'env', 'SECRET=1');
    await withBaselines(f);
    fs.unlinkSync(path.join(f.home, 'env.json'));

    const keepDeleted = await f.run(['sync', 'env', '--prefer', 'local', '--yes']);
    assert.equal(keepDeleted.code, 4);
    assert.match(keepDeleted.stdout, /can't upload: there is no local file to upload \(deletions aren't synced\)/);
    assert.equal(await f.remote('env-id'), 'SECRET=1');

    const restore = await f.run(['sync', 'env', '--prefer', 'remote', '--yes']);
    assert.equal(restore.code, 0);
    assert.equal(f.file('~/env.json'), 'SECRET=1');
});

test('sync --yes skips a large deletion even when the direction is known', async () => {
    const f = await cliFixture({ profiles: [profile('big')] });
    const full = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    await synced(f, 'big', full);
    await withBaselines(f);
    f.writeFile('~/big.json', 'line 0');

    const r = await f.run(['sync', '--yes', '--json']);

    assert.equal(outcomes(r.stdout).big.kind, 'skipped');
    assert.equal(await f.remote('big-id'), full);
});

test('pull/push overwrite a changed side only with --force; a missing source side is never "pulled" as empty', async () => {
    const f = await cliFixture({ profiles: [profile('a'), profile('gone')] });
    await synced(f, 'a');
    await withBaselines(f);
    f.writeFile('~/a.json', 'local edit');
    f.writeFile('~/gone.json', 'only local');

    const noForce = await f.run(['pull', 'a', '--yes']);
    assert.equal(noForce.code, 1);
    assert.match(noForce.stdout, /needs a decision: add --force to overwrite \(overwrites local changes made since the last sync\)/);
    assert.equal(f.file('~/a.json'), 'local edit');

    const forced = await f.run(['pull', 'a', '--yes', '--force']);
    assert.equal(forced.code, 0);
    assert.equal(f.file('~/a.json'), 'base');

    const nothingToPull = await f.run(['pull', 'gone', '--yes', '--force']);
    assert.equal(nothingToPull.code, 4);
    assert.match(nothingToPull.stdout, /can't pull: there is no remote record to download/);
    assert.equal(f.file('~/gone.json'), 'only local');
});

test('push --all uploads rows where the remote is unchanged, and not over remote edits without --force', async () => {
    const f = await cliFixture({ profiles: [profile('mine'), profile('theirs')] });
    await synced(f, 'mine');
    await synced(f, 'theirs');
    await withBaselines(f);
    f.writeFile('~/mine.json', 'local edit');
    await f.setRemote('theirs-id', 'remote edit');

    const r = await f.run(['push', '--all', '--yes', '--json']);

    const o = outcomes(r.stdout);
    assert.equal(o.mine.kind, 'applied');
    assert.equal(o.theirs.kind, 'skipped');
    assert.equal(await f.remote('theirs-id'), 'remote edit');
});

test('a remote change between planning and applying is caught: nothing written, exit 3', async () => {
    const f = await cliFixture({ profiles: [profile('a'), profile('b')] });
    f.writeFile('~/a.json', 'A');
    f.writeFile('~/b.json', 'B');
    const realTx = f.pg.sql.transaction;
    f.pg.sql.transaction = async (queries: unknown[]) => {
        if (f.pg.sql.queryCalls.slice(-queries.length).some((c) => /WITH w AS/.test(c.query))) {
            await f.setRemote('b-id', 'another machine');
        }
        return realTx(queries);
    };

    const r = await f.run(['sync', '--yes', '--json']);

    assert.equal(r.code, 3, r.stderr);
    assert.ok(r.stdout, `stderr: ${r.stderr}`);
    const o = outcomes(r.stdout);
    assert.deepEqual([o.a.kind, o.b.kind], ['not-applied', 'stale-remote']);
    assert.equal(await f.remote('a-id'), undefined);
    assert.equal(await f.remote('b-id'), 'another machine');
});

test('interactive sync: pick rows, decide a conflict after viewing its diff; cancelling writes nothing', async () => {
    const f = await cliFixture({ profiles: [profile('up'), profile('both')] });
    await synced(f, 'up');
    await synced(f, 'both');
    await withBaselines(f);
    f.writeFile('~/up.json', 'local edit');
    f.writeFile('~/both.json', 'mine');
    await f.setRemote('both-id', 'theirs');

    const cancelled = await f.run(['sync'], { tty: true, prompts: { multiselect: async () => undefined } });
    assert.equal(cancelled.code, 1);
    assert.match(cancelled.stdout, /Cancelled; nothing was written/);
    assert.equal(await f.remote('up-id'), 'base');

    let initial: string[] = [];
    const answers = ['diff', 'download'];
    const r = await f.run(['sync'], {
        tty: true,
        env: { NO_COLOR: '1' },
        prompts: {
            multiselect: (async (_m: string, choices: Array<{ value: string }>, init: string[]) => {
                initial = init;
                return choices.map((c) => c.value);
            }) as never,
            select: (async () => answers.shift()) as never
        }
    });

    assert.deepEqual(initial, ['0'], 'only the safe row starts selected');
    assert.equal(r.code, 0);
    assert.match(r.stdout, /^-theirs$/m, 'the diff was shown (suggested direction)');
    assert.match(r.stdout, /^\+mine$/m);
    assert.equal(await f.remote('up-id'), 'local edit');
    assert.equal(f.file('~/both.json'), 'theirs');
});

test('bare `neon-sync` in a terminal offers to apply after the status', async () => {
    const f = await cliFixture({ profiles: [profile('a')] });
    f.writeFile('~/a.json', 'new');
    const r = await f.run([], {
        tty: true,
        prompts: {
            confirm: async () => true,
            multiselect: (async (_m: string, _c: unknown, init: string[]) => init) as never
        }
    });
    assert.equal(r.code, 0);
    assert.equal(await f.remote('a-id'), 'new');
});

test('diff shows what would change in the planned direction; errors exit 4, in-sync exits 0', async () => {
    const f = await cliFixture({ profiles: [profile('a'), profile('rel', { filePath: 'x.md' }), profile('same')] });
    await synced(f, 'a', 'one\ntwo\n');
    await synced(f, 'same', 's');
    await withBaselines(f);
    f.writeFile('~/a.json', 'one\nTWO\n');

    const r = await f.run(['diff', 'a']);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /a {2}↑ upload \(Remote ← Local\)/);
    assert.match(r.stdout, /^-two$/m);
    assert.match(r.stdout, /^\+TWO$/m);
    assert.match(r.stdout, /--- remote records\/a-id \(now\)/);

    const other = await f.run(['diff', 'a', '--direction', 'download']);
    assert.match(other.stdout, /^-TWO$/m);

    assert.equal((await f.run(['diff', 'rel'])).code, 4);
    assert.equal((await f.run(['diff', 'same'])).code, 0);
});

test('excludeKeys through the CLI: an upload keeps each side\'s own excluded values', async () => {
    const f = await cliFixture({ profiles: [profile('vs', { excludeKeys: ['theme'] })] });
    f.writeFile('~/vs.json', '{\n    "font": 14,\n    "theme": "dark"\n}\n');
    await f.setRemote('vs-id', '{\n    "font": 14,\n    "theme": "light"\n}\n');
    await withBaselines(f);
    f.writeFile('~/vs.json', '{\n    "font": 16,\n    "theme": "dark"\n}\n');

    const r = await f.run(['sync', '--yes']);

    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(await f.remote('vs-id'), '{\n    "font": 16,\n    "theme": "light"\n}\n');
    assert.equal(f.file('~/vs.json'), '{\n    "font": 16,\n    "theme": "dark"\n}\n');
});
