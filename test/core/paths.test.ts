import test = require('node:test');
import assert = require('node:assert/strict');
import * as os from 'node:os';
import * as path from 'node:path';
import { abbreviateHome, configDir, expandHome, stateDir, wslBoundaryError } from '../../src/core/paths';
import { resolveProfilePath } from '../../src/core/localFile';

const mac = { platform: 'darwin' as const, home: '/Users/me', env: {} };
const linux = { platform: 'linux' as const, home: '/home/me', env: {} };
const win = {
    platform: 'win32' as const,
    home: 'C:\\Users\\me',
    env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }
};

test('config dir: ~/.config/neon-sync on macOS/Linux, %APPDATA%\\neon-sync on Windows', () => {
    assert.equal(configDir(mac), '/Users/me/.config/neon-sync');
    assert.equal(configDir(linux), '/home/me/.config/neon-sync');
    assert.equal(configDir(win), 'C:\\Users\\me\\AppData\\Roaming\\neon-sync');
    assert.equal(configDir({ ...win, env: {} }), 'C:\\Users\\me\\AppData\\Roaming\\neon-sync', 'falls back without APPDATA');
});

test('state dir is machine-local: ~/.local/state/neon-sync, %LOCALAPPDATA%\\neon-sync', () => {
    assert.equal(stateDir(mac), '/Users/me/.local/state/neon-sync');
    assert.equal(stateDir(win), 'C:\\Users\\me\\AppData\\Local\\neon-sync');
});

test('no environment override can move the config (XDG and friends are ignored)', () => {
    const env = { XDG_CONFIG_HOME: '/elsewhere', XDG_STATE_HOME: '/elsewhere', NEON_SYNC_HOME: '/elsewhere' };
    assert.equal(configDir({ ...linux, env }), '/home/me/.config/neon-sync');
    assert.equal(stateDir({ ...linux, env }), '/home/me/.local/state/neon-sync');
});

test('expandHome: ~, ~/…, ~\\… on Windows only; ~user and mid-path ~ stay literal', () => {
    assert.equal(expandHome('~', linux), '/home/me');
    assert.equal(expandHome('~/a/b.json', linux), '/home/me/a/b.json');
    assert.equal(expandHome('~\\a.json', linux), '~\\a.json');
    assert.equal(expandHome('~\\a\\b.json', win), 'C:\\Users\\me\\a\\b.json');
    assert.equal(expandHome('~/a.json', win), 'C:\\Users\\me\\a.json');
    assert.equal(expandHome('~other/a.json', linux), '~other/a.json');
    assert.equal(expandHome('/x/~/a', linux), '/x/~/a');
});

test('abbreviateHome: ~ form under home, absolute elsewhere; round-trips with expandHome', () => {
    assert.equal(abbreviateHome('/home/me/.zshrc', linux), '~/.zshrc');
    assert.equal(abbreviateHome('/home/me', linux), '~');
    assert.equal(abbreviateHome('/home/meow/x', linux), '/home/meow/x');
    assert.equal(abbreviateHome('/etc/hosts', linux), '/etc/hosts');
    assert.equal(abbreviateHome('C:\\Users\\me\\x\\y.json', win), '~\\x\\y.json');
    assert.equal(abbreviateHome('D:\\x.json', win), 'D:\\x.json');
    for (const p of ['/home/me/a/b', '/home/me']) {
        assert.equal(expandHome(abbreviateHome(p, linux), linux), p);
    }
});

test('resolveProfilePath expands ~ against the real home directory', () => {
    assert.equal(resolveProfilePath('~/x.json', '/ws'), path.join(os.homedir(), 'x.json'));
    assert.equal(resolveProfilePath('rel.json', '/ws'), path.join('/ws', 'rel.json'));
});

test('wslBoundaryError: \\\\wsl$ paths on Windows, /mnt/<drive>/ inside WSL, nothing otherwise', () => {
    assert.match(wslBoundaryError('\\\\wsl$\\Ubuntu\\home\\me\\x', win)!, /inside WSL/);
    assert.match(wslBoundaryError('\\\\WSL.LOCALHOST\\Ubuntu\\x', win)!, /inside WSL/);
    assert.equal(wslBoundaryError('C:\\Users\\me\\x', win), undefined);

    const wsl = { platform: 'linux' as const, env: { WSL_DISTRO_NAME: 'Ubuntu' } };
    assert.match(wslBoundaryError('/mnt/c/Users/me/x', wsl)!, /Windows drive/);
    assert.equal(wslBoundaryError('/home/me/x', wsl), undefined);
    assert.equal(wslBoundaryError('/mnt/c/Users/me/x', linux), undefined, 'plain Linux: /mnt is just a mount');
});
