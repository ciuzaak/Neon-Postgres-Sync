import test = require('node:test');
import assert = require('node:assert/strict');
import * as fs from 'node:fs';
import * as path from 'node:path';
import { cliFixture, profile, type CliFixture } from './harness';
import { splitCommand } from '../../cli/src/commands/edit';

async function synced(f: CliFixture, name: string, content = 'base') {
    f.writeFile(`~/${name}.json`, content);
    await f.setRemote(`${name}-id`, content);
}

/** A fake editor: rewrites the file it's given (the last argument). */
function editorWriting(content: string | ((old: string) => string), seen?: { command?: string; args?: string[] }) {
    return async (command: string, args: string[]) => {
        if (seen) { seen.command = command; seen.args = args; }
        const file = args[args.length - 1];
        const old = fs.readFileSync(file, 'utf-8');
        fs.writeFileSync(file, typeof content === 'function' ? content(old) : content);
        return 0;
    };
}

/** A clock where the editor "took" `ms` milliseconds. */
function clockTaking(ms: number) {
    let t = 1_000_000;
    return () => (t += ms);
}

const TTY = { tty: true, env: { NO_COLOR: '1', EDITOR: 'fake-editor' } };

// ── edit ──────────────────────────────────────────────────────────────

test('splitCommand handles arguments and quotes like a shell', () => {
    assert.deepEqual(splitCommand('code --wait'), ['code', '--wait']);
    assert.deepEqual(splitCommand(`'/Applications/My Editor.app/bin/ed' -w`), ['/Applications/My Editor.app/bin/ed', '-w']);
    assert.deepEqual(splitCommand('"C:\\\\Program Files\\\\ed.exe" --x "a \\"b\\""'), ['C:\\Program Files\\ed.exe', '--x', 'a "b"']);
    assert.deepEqual(splitCommand('vim\\ x  -f'), ['vim x', '-f']);
    assert.throws(() => splitCommand('code "--wait'), /Unbalanced quote/);
});

test('edit needs a terminal', async () => {
    const f = await cliFixture({ profiles: [profile('a')] });
    const r = await f.run(['edit', 'a']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /needs a terminal/);
});

test('edit: the edited version is shown against the destination, confirmed, then applied', async () => {
    const f = await cliFixture({ profiles: [profile('a')] });
    f.writeFile('~/a.json', 'one\ntwo\n');
    const seen: { command?: string; args?: string[] } = {};

    const r = await f.run(['edit', 'a'], {
        ...TTY,
        env: { NO_COLOR: '1', EDITOR: 'code --wait' },
        editor: editorWriting((old) => old.replace('two', 'TWO'), seen),
        now: clockTaking(5000),
        prompts: { confirm: async () => true }
    });

    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(seen.command, 'code');
    assert.equal(seen.args![0], '--wait');
    assert.match(seen.args![1], /a\.local\.json$/, 'keeps the file extension');
    assert.match(r.stdout, /^\+TWO$/m);
    assert.equal(await f.remote('a-id'), 'one\nTWO\n');
    assert.equal(fs.existsSync(path.dirname(seen.args![1])), false, 'temp dir removed');
});

test('edit: declining, a non-zero editor exit, or an emptied file writes nothing', async () => {
    const f = await cliFixture({ profiles: [profile('a')] });
    f.writeFile('~/a.json', 'x');
    const base = { ...TTY, now: clockTaking(5000) };

    const declined = await f.run(['edit', 'a'], { ...base, editor: editorWriting('y'), prompts: { confirm: async () => false } });
    const failed = await f.run(['edit', 'a'], { ...base, editor: async () => 1 });
    const emptied = await f.run(['edit', 'a'], { ...base, editor: editorWriting('  \n') });

    for (const r of [declined, failed, emptied]) assert.equal(r.code, 1);
    assert.match(failed.stdout, /exited with status 1/);
    assert.match(emptied.stdout, /empty; nothing was written/);
    assert.equal(await f.remote('a-id'), undefined);
});

test('edit: an editor that returns instantly without changes is caught (it did not wait)', async () => {
    const f = await cliFixture({ profiles: [profile('a')] });
    f.writeFile('~/a.json', 'x');
    let asked = false;
    const r = await f.run(['edit', 'a'], {
        ...TTY,
        editor: async () => 0,
        now: clockTaking(10),
        prompts: { confirm: async () => { asked = true; return true; } }
    });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /returned immediately without changes .*code --wait/);
    assert.equal(asked, false);
    assert.equal(await f.remote('a-id'), undefined);
});

test('edit: unchanged after a real edit session asks whether to apply as is', async () => {
    const f = await cliFixture({ profiles: [profile('a')] });
    f.writeFile('~/a.json', 'x');
    let question = '';
    const r = await f.run(['edit', 'a'], {
        ...TTY,
        editor: async () => 0,
        now: clockTaking(5000),
        prompts: { confirm: async (m: string) => { question = m; return true; } }
    });
    assert.equal(r.code, 0);
    assert.match(question, /Apply a as is \(upload\)\?/);
    assert.equal(await f.remote('a-id'), 'x');
});

test('edit on a conflict asks which way first; editing the remote version then downloads it', async () => {
    const f = await cliFixture({ profiles: [profile('env')] });
    await synced(f, 'env');
    await f.run(['status']);
    f.writeFile('~/env.json', 'mine');
    await f.setRemote('env-id', 'theirs');
    let offered: string[] = [];

    const r = await f.run(['edit', 'env'], {
        ...TTY,
        editor: editorWriting((old) => `${old}+merged`),
        now: clockTaking(5000),
        prompts: {
            select: (async (_m: string, choices: Array<{ value: string }>) => { offered = choices.map((c) => c.value); return 'download'; }) as never,
            confirm: async () => true
        }
    });

    assert.deepEqual(offered, ['upload', 'download']);
    assert.equal(r.code, 0);
    assert.equal(f.file('~/env.json'), 'theirs+merged');
    assert.equal(await f.remote('env-id'), 'theirs');
});

test('edit never edits from a missing side', async () => {
    const f = await cliFixture({ profiles: [profile('a')] });
    await f.setRemote('a-id', 'remote only');
    const r = await f.run(['edit', 'a', '--direction', 'upload'], { ...TTY, editor: editorWriting('x') });
    assert.equal(r.code, 4);
    assert.match(r.stdout, /can't upload: there is no local file to upload/);
    assert.equal(await f.remote('a-id'), 'remote only');
});

test('edit --tool code opens a diff of the destination and the (0600) candidate', async () => {
    const f = await cliFixture({ profiles: [profile('a')] });
    await synced(f, 'a', 'old');
    await f.run(['status']);
    f.writeFile('~/a.json', 'new');
    const seen: { command?: string; args?: string[] } = {};
    let modes: number[] = [];

    const r = await f.run(['edit', 'a', '--tool', 'code'], {
        ...TTY,
        editor: async (command, args) => {
            seen.command = command; seen.args = args;
            modes = args.slice(2).map((p) => fs.statSync(p).mode & 0o777);
            fs.writeFileSync(args[3], 'new!');
            return 0;
        },
        now: clockTaking(5000),
        prompts: { confirm: async () => true }
    });

    assert.equal(r.code, 0);
    assert.deepEqual([seen.command, seen.args![0], seen.args![1]], ['code', '--wait', '--diff']);
    assert.equal(fs.readFileSync.length > 0, true);
    if (process.platform !== 'win32') assert.deepEqual(modes, [0o600, 0o600]);
    assert.equal(await f.remote('a-id'), 'new!');
});

test('edit with excludeKeys: excluded keys are hidden while editing and each side keeps its own', async () => {
    const f = await cliFixture({ profiles: [profile('vs', { excludeKeys: ['theme'] })] });
    f.writeFile('~/vs.json', '{\n    "font": 14,\n    "theme": "dark"\n}\n');
    await f.setRemote('vs-id', '{\n    "font": 14,\n    "theme": "light"\n}\n');
    await f.run(['status']);
    let shown = '';

    const r = await f.run(['edit', 'vs', '--direction', 'upload'], {
        ...TTY,
        editor: editorWriting((old) => { shown = old; return old.replace('14', '18'); }),
        now: clockTaking(5000),
        prompts: { confirm: async () => true }
    });

    assert.equal(r.code, 0);
    assert.equal(shown.includes('theme'), false);
    assert.equal(await f.remote('vs-id'), '{\n    "font": 18,\n    "theme": "light"\n}\n');
    assert.equal(f.file('~/vs.json'), '{\n    "font": 18,\n    "theme": "dark"\n}\n');
});

test('edit: a remote change while the editor was open is caught (exit 3, nothing written)', async () => {
    const f = await cliFixture({ profiles: [profile('a')] });
    f.writeFile('~/a.json', 'mine');
    const r = await f.run(['edit', 'a'], {
        ...TTY,
        editor: async (_c, args) => {
            fs.writeFileSync(args[args.length - 1], 'edited');
            await f.setRemote('a-id', 'another machine');
            return 0;
        },
        now: clockTaking(5000),
        prompts: { confirm: async () => true }
    });
    assert.equal(r.code, 3);
    assert.match(r.stdout, /the remote changed meanwhile/);
    assert.equal(await f.remote('a-id'), 'another machine');
});

// ── profile add / remove / rename ─────────────────────────────────────

test('profile add with flags stores a portable path (relative to the current directory → ~/…)', async () => {
    const f = await cliFixture({ profiles: [] });
    const r = await f.run(['profile', 'add', 'zsh', '--file', 'dotfiles/.zshrc', '--id', 'zshrc', '--exclude', 'a.b', '--exclude', 'c']);
    assert.equal(r.code, 0, r.stderr);
    const saved = JSON.parse(fs.readFileSync(f.configPath, 'utf-8')).profiles;
    assert.deepEqual(saved, [{ name: 'zsh', filePath: '~/dotfiles/.zshrc', id: 'zshrc', tableName: 'json_records', excludeKeys: ['a.b', 'c'] }]);
});

test('profile add refuses duplicates, a file another profile uses, bad tables and missing fields', async () => {
    const f = await cliFixture({ profiles: [profile('a')] });
    const cases: Array<[string[], RegExp]> = [
        [['profile', 'add', 'a', '--file', '~/x.json', '--id', 'x'], /already exists/],
        [['profile', 'add', 'b', '--file', '~/a.json', '--id', 'x'], /Profile "a" already uses ~\/a\.json/],
        [['profile', 'add', 'b', '--file', '~/b.json', '--id', 'x', '--table', 'x;drop'], /letters, numbers/i],
        [['profile', 'add', 'b', '--id', 'x'], /needs --file/]
    ];
    for (const [argv, message] of cases) {
        const r = await f.run(argv);
        assert.equal(r.code, 2, argv.join(' '));
        assert.match(r.stderr, message, argv.join(' '));
    }
    assert.equal(JSON.parse(fs.readFileSync(f.configPath, 'utf-8')).profiles.length, 1);
});

test('profile add asks for missing values in a terminal; cancelling adds nothing', async () => {
    const f = await cliFixture({ profiles: [] });
    const answers = ['vs', '~/Library/vs.json', 'vs-id', 'json_records'];
    const r = await f.run(['profile', 'add'], { tty: true, prompts: { text: async () => answers.shift() } });
    assert.equal(r.code, 0);
    assert.equal(JSON.parse(fs.readFileSync(f.configPath, 'utf-8')).profiles[0].filePath, '~/Library/vs.json');

    const cancelled = await f.run(['profile', 'add'], { tty: true, prompts: { text: async () => undefined } });
    assert.equal(cancelled.code, 1);
    assert.equal(JSON.parse(fs.readFileSync(f.configPath, 'utf-8')).profiles.length, 1);
});

test('profile remove: exact names only, --yes in scripts, confirmation in a terminal; file and record untouched', async () => {
    const f = await cliFixture({ profiles: [profile('env-prod'), profile('env')] });
    await synced(f, 'env');

    assert.equal((await f.run(['profile', 'remove', 'env'])).code, 2, 'needs --yes without a terminal');
    assert.equal((await f.run(['profile', 'remove', 'env-p', '--yes'])).code, 2, 'no prefixes');
    assert.equal((await f.run(['profile', 'remove', 'env'], { tty: true, prompts: { confirm: async () => false } })).code, 1);

    const r = await f.run(['profile', 'remove', 'env', '--yes']);
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.configPath, 'utf-8')).profiles.map((p: { name: string }) => p.name), ['env-prod']);
    assert.equal(f.file('~/env.json'), 'base');
    assert.equal(await f.remote('env-id'), 'base');
});

test('profile rename keeps the sync history (it is not keyed by name)', async () => {
    const f = await cliFixture({ profiles: [profile('old'), profile('taken')] });
    await synced(f, 'old');
    await f.run(['status']);

    assert.equal((await f.run(['profile', 'rename', 'old', 'taken'])).code, 2);
    assert.equal((await f.run(['profile', 'rename', 'nope', 'x'])).code, 2);
    assert.equal((await f.run(['profile', 'rename', 'old', 'new'])).code, 0);

    f.writeFile('~/old.json', 'local edit');
    const s = JSON.parse((await f.run(['status', 'new', '--json'])).stdout).profiles[0];
    assert.deepEqual([s.status, s.label], ['auto', 'local changed'], 'still judged against the old baseline');
});

// ── init-db ───────────────────────────────────────────────────────────

test('init-db creates the table once; invalid names are refused', async () => {
    const f = await cliFixture();
    const first = await f.run(['init-db']);
    assert.equal(first.code, 0);
    assert.match(first.stdout, /Created table json_records in db\.example\.test\/neondb/);
    const cols = (await f.pg.db.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'json_records' ORDER BY ordinal_position"
    )).rows.map((r) => r.column_name);
    assert.deepEqual(cols, ['id', 'data', 'create_time', 'update_time']);

    assert.match((await f.run(['init-db'])).stdout, /already exists in db\.example\.test\/neondb; nothing changed/);
    assert.match((await f.run(['init-db', '--table', 'records'])).stdout, /already exists/);
    assert.equal((await f.run(['init-db', '--table', 'x; drop table y'])).code, 2);
});
