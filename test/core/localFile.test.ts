import test = require('node:test');
import assert = require('node:assert/strict');
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { samePathKey, writeFileAtomic } from '../../src/core/localFile';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'neon-sync-local-'));
const posix = process.platform !== 'win32';
const root = process.getuid?.() === 0;

test('writeFileAtomic creates, replaces, and leaves no temp files', () => {
    const dir = tmp();
    const file = path.join(dir, 'a.json');
    writeFileAtomic(file, 'one');
    writeFileAtomic(file, 'two');
    assert.equal(fs.readFileSync(file, 'utf-8'), 'two');
    assert.deepEqual(fs.readdirSync(dir), ['a.json']);
});

test('writeFileAtomic keeps the file mode', { skip: !posix }, () => {
    const file = path.join(tmp(), 'secret.env');
    fs.writeFileSync(file, 'x', { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    writeFileAtomic(file, 'y');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('writeFileAtomic writes through a symlink instead of replacing it', { skip: !posix }, () => {
    const dir = tmp();
    const real = path.join(dir, 'dotfiles', 'settings.json');
    fs.mkdirSync(path.dirname(real));
    fs.writeFileSync(real, 'old');
    const link = path.join(dir, 'settings.json');
    fs.symlinkSync(real, link);

    writeFileAtomic(link, 'new');

    assert.ok(fs.lstatSync(link).isSymbolicLink(), 'link preserved');
    assert.equal(fs.readFileSync(real, 'utf-8'), 'new');
});

test('writeFileAtomic refuses a read-only file (rename would bypass it)', { skip: !posix || root }, () => {
    const file = path.join(tmp(), 'ro.json');
    fs.writeFileSync(file, 'keep');
    fs.chmodSync(file, 0o444);
    try {
        assert.throws(() => writeFileAtomic(file, 'x'), /EACCES/);
        assert.equal(fs.readFileSync(file, 'utf-8'), 'keep');
    } finally {
        fs.chmodSync(file, 0o644);
    }
});

test('writeFileAtomic refuses a read-only directory rather than writing in place (no fragments)', { skip: !posix || root }, () => {
    const dir = tmp();
    const file = path.join(dir, 'a.json');
    fs.writeFileSync(file, 'old');
    fs.chmodSync(dir, 0o555);
    try {
        assert.throws(() => writeFileAtomic(file, 'new'), /EACCES/);
        assert.equal(fs.readFileSync(file, 'utf-8'), 'old');
    } finally {
        fs.chmodSync(dir, 0o755);
    }
});

test('writeFileAtomic follows a dangling symlink and creates its target', { skip: !posix }, () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'dotfiles'));
    const link = path.join(dir, 'settings.json');
    fs.symlinkSync(path.join('dotfiles', 'settings.json'), link); // relative, dangling

    writeFileAtomic(link, 'new');

    assert.ok(fs.lstatSync(link).isSymbolicLink());
    assert.equal(fs.readFileSync(path.join(dir, 'dotfiles', 'settings.json'), 'utf-8'), 'new');
});

test('a write that fails midway (file size limit) leaves the original intact and no temp file', { skip: !posix }, () => {
    const dir = tmp();
    const file = path.join(dir, 'big.json');
    fs.writeFileSync(file, 'original');
    const modulePath = path.resolve(__dirname, '..', '..', 'src', 'core', 'localFile.js');
    const script = `
        const { writeFileAtomic } = require(${JSON.stringify(modulePath)});
        try { writeFileAtomic(${JSON.stringify(file)}, 'x'.repeat(200000)); console.log('WROTE'); }
        catch (e) { console.log('FAILED', e.code); }`;
    const out = childProcess.spawnSync('/bin/sh', ['-c', `ulimit -f 64; "${process.execPath}" -e '${script.replace(/'/g, "'\\''")}'`], { encoding: 'utf-8' });

    assert.match(out.stdout, /FAILED EFBIG/, out.stderr);
    assert.equal(fs.readFileSync(file, 'utf-8'), 'original');
    assert.deepEqual(fs.readdirSync(dir), ['big.json']);
});

test('writeFileAtomic resolves a relative `..` link from the real directory, like the OS', { skip: !posix }, () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'real', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'real', 'settings.json'), 'v1');
    fs.symlinkSync(path.join(dir, 'real', 'sub'), path.join(dir, 'alias'));
    fs.symlinkSync(path.join('..', 'settings.json'), path.join(dir, 'real', 'sub', 'link.json'));
    const viaAlias = path.join(dir, 'alias', 'link.json');
    assert.equal(fs.readFileSync(viaAlias, 'utf-8'), 'v1', 'the OS reads real/settings.json');

    writeFileAtomic(viaAlias, 'v2');

    assert.equal(fs.readFileSync(viaAlias, 'utf-8'), 'v2', 'the write lands on the file that is read');
    assert.equal(fs.existsSync(path.join(dir, 'settings.json')), false, 'no stray file next to the alias');
});

test('writeFileAtomic follows a dangling relative `..` link under a symlinked directory', { skip: !posix }, () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'real', 'sub'), { recursive: true });
    fs.symlinkSync(path.join(dir, 'real', 'sub'), path.join(dir, 'alias'));
    fs.symlinkSync(path.join('..', 'new.json'), path.join(dir, 'real', 'sub', 'link.json'));

    writeFileAtomic(path.join(dir, 'alias', 'link.json'), 'created');

    assert.equal(fs.readFileSync(path.join(dir, 'real', 'new.json'), 'utf-8'), 'created');
    assert.equal(fs.readFileSync(path.join(dir, 'alias', 'link.json'), 'utf-8'), 'created');
});

test('writeFileAtomic handles link text that walks up out of a symlinked directory (`dir-link/..`)', { skip: !posix }, () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'real', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'real', 'settings.json'), 'v1');
    fs.writeFileSync(path.join(dir, 'settings.json'), 'unrelated');
    fs.symlinkSync(path.join(dir, 'real', 'sub'), path.join(dir, 'alias2'));
    const link = path.join(dir, 'link.json');
    fs.symlinkSync('alias2/../settings.json', link);
    assert.equal(fs.readFileSync(link, 'utf-8'), 'v1', 'the OS opens real/settings.json');

    writeFileAtomic(link, 'v2');

    assert.equal(fs.readFileSync(link, 'utf-8'), 'v2');
    assert.equal(fs.readFileSync(path.join(dir, 'settings.json'), 'utf-8'), 'unrelated');
    assert.ok(fs.lstatSync(link).isSymbolicLink());
});

test('writeFileAtomic creates the target of a dangling `dir-link/..` link where the OS would', { skip: !posix }, () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'real', 'sub'), { recursive: true });
    fs.symlinkSync(path.join(dir, 'real', 'sub'), path.join(dir, 'alias2'));
    const link = path.join(dir, 'link.json');
    fs.symlinkSync('alias2/../fresh.json', link);

    writeFileAtomic(link, 'made');

    assert.equal(fs.readFileSync(path.join(dir, 'real', 'fresh.json'), 'utf-8'), 'made');
    assert.equal(fs.existsSync(path.join(dir, 'fresh.json')), false);
    assert.equal(fs.readFileSync(link, 'utf-8'), 'made');
});

test('samePathKey identifies the same file through symlinks and, on macOS/Windows, case', { skip: !posix }, () => {
    const dir = tmp();
    const file = path.join(dir, 'Settings.json');
    fs.writeFileSync(file, '');
    fs.symlinkSync(file, path.join(dir, 'link.json'));

    assert.equal(samePathKey(path.join(dir, 'link.json')), samePathKey(file));
    assert.equal(samePathKey(path.join(dir, 'x', '..', 'Settings.json')), samePathKey(file));
    if (process.platform === 'darwin') {
        assert.equal(samePathKey(path.join(dir, 'settings.json')), samePathKey(file));
    }
    // A file that doesn't exist yet still resolves through its parent.
    assert.equal(samePathKey(path.join(dir, 'new.json')), samePathKey(path.join(dir, '.', 'new.json')));
});
