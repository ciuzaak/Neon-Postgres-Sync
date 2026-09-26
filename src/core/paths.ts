import * as os from 'os';
import * as path from 'path';

/** The bits of the environment that decide where things live (injectable for tests). */
export interface PathEnv {
    platform: NodeJS.Platform;
    home: string;
    env: Record<string, string | undefined>;
}

export function currentPathEnv(): PathEnv {
    return { platform: process.platform, home: os.homedir(), env: process.env };
}

const APP_DIR = 'neon-sync';

/**
 * Per-user directory for `neon-sync.json`, shared by the extension and the
 * CLI. Deliberately fixed — no XDG_CONFIG_HOME or custom env override: the
 * extension host doesn't reliably see shell variables (Dock launches,
 * Flatpak), and two tools silently reading different directories would
 * judge syncs against different histories.
 *
 * macOS/Linux: ~/.config/neon-sync · Windows: %APPDATA%\neon-sync
 */
export function configDir(p: PathEnv = currentPathEnv()): string {
    if (p.platform === 'win32') {
        return path.win32.join(p.env.APPDATA || path.win32.join(p.home, 'AppData', 'Roaming'), APP_DIR);
    }
    return path.posix.join(p.home, '.config', APP_DIR);
}

/**
 * Per-machine directory for sync state (baselines). Machine-local on purpose:
 * ~/.config is often synced as dotfiles and %APPDATA% roams on domain
 * accounts, but a baseline only describes this machine.
 *
 * macOS/Linux: ~/.local/state/neon-sync · Windows: %LOCALAPPDATA%\neon-sync
 */
export function stateDir(p: PathEnv = currentPathEnv()): string {
    if (p.platform === 'win32') {
        return path.win32.join(p.env.LOCALAPPDATA || path.win32.join(p.home, 'AppData', 'Local'), APP_DIR);
    }
    return path.posix.join(p.home, '.local', 'state', APP_DIR);
}

/**
 * Expand a leading `~` (`~`, `~/…`, and `~\…` on Windows) to the home
 * directory. `~user` forms are left literal.
 */
export function expandHome(filePath: string, p: Pick<PathEnv, 'platform' | 'home'> = currentPathEnv()): string {
    if (filePath === '~') return p.home;
    const sep = filePath[1];
    if (filePath[0] === '~' && (sep === '/' || (p.platform === 'win32' && sep === '\\'))) {
        const join = p.platform === 'win32' ? path.win32.join : path.posix.join;
        return join(p.home, filePath.slice(2));
    }
    return filePath;
}

/** `~`-abbreviated form of an absolute path under the home directory, for display and storage. */
export function abbreviateHome(absolutePath: string, p: Pick<PathEnv, 'platform' | 'home'> = currentPathEnv()): string {
    const impl = p.platform === 'win32' ? path.win32 : path.posix;
    const rel = impl.relative(p.home, absolutePath);
    if (rel === '') return '~';
    if (rel.startsWith('..') || impl.isAbsolute(rel)) return absolutePath;
    return p.platform === 'win32' ? `~\\${rel}` : `~/${rel}`;
}

/**
 * Why a file must not be synced from this side of a WSL boundary, if so.
 * A file reachable from both Windows (`C:\…` / `\\wsl$\…`) and WSL
 * (`/mnt/c/…`) would be judged against two separate sync-state stores; one
 * of them is bound to be stale, and a stale baseline can pick a confident
 * wrong direction. `realPath` must already have symlinks resolved.
 */
export function wslBoundaryError(realPath: string, p: Pick<PathEnv, 'platform' | 'env'> = currentPathEnv()): string | undefined {
    if (p.platform === 'win32' && /^\\\\(wsl\$|wsl\.localhost)\\/i.test(realPath)) {
        return 'this file lives inside WSL — sync it from WSL (neon-sync CLI), not from Windows';
    }
    if (p.platform === 'linux' && p.env.WSL_DISTRO_NAME && /^\/mnt\/[a-z]\//i.test(realPath)) {
        return 'this file is on a Windows drive — sync it from Windows, or keep a WSL-side copy';
    }
    return undefined;
}
