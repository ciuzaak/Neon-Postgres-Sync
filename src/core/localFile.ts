import * as fs from 'fs';
import * as path from 'path';

export interface LocalSnapshot {
    exists: boolean;
    /** Empty string when the file does not exist. */
    content: string;
    mtime: Date | null;
}

export function readLocalFile(absolutePath: string): LocalSnapshot {
    if (!fs.existsSync(absolutePath)) {
        return { exists: false, content: '', mtime: null };
    }
    return {
        exists: true,
        content: fs.readFileSync(absolutePath, 'utf-8'),
        mtime: fs.statSync(absolutePath).mtime
    };
}

/**
 * Absolute paths pass through; relative paths are anchored to `baseDir` when
 * one is given (the VS Code host passes the first workspace folder), otherwise
 * left for the OS to resolve against the process cwd.
 */
export function resolveProfilePath(filePath: string, baseDir: string | undefined): string {
    if (path.isAbsolute(filePath)) {
        return filePath;
    }
    if (baseDir) {
        return path.join(baseDir, filePath);
    }
    return filePath;
}

/**
 * The file a write to `absolutePath` should land on: symlinks are followed —
 * including dangling ones, whose target gets created — so a link managed by
 * a dotfile tool stays a link.
 */
function resolveWriteTarget(absolutePath: string): string {
    let target = absolutePath;
    for (let hops = 0; hops < 40; hops++) {
        let stat: fs.Stats;
        try {
            stat = fs.lstatSync(target);
        } catch {
            return target; // doesn't exist (yet)
        }
        if (!stat.isSymbolicLink()) return fs.realpathSync(target);
        target = path.resolve(path.dirname(target), fs.readlinkSync(target));
    }
    throw new Error(`Too many levels of symbolic links: ${absolutePath}`);
}

/**
 * Replace `absolutePath`'s content atomically: write a sibling temp file, then
 * rename it over the target, so a failure midway (disk full, size limit,
 * crash) leaves either the old file or the new one — never a fragment that a
 * later sync would read as a local edit and upload.
 *
 * - Symlinks are followed (see resolveWriteTarget); hard links are not
 *   preserved (rename gives the path a new inode — inherent to atomic writes).
 * - The existing file's permission bits are kept.
 * - A file the user can't write stays unwritable: rename would otherwise
 *   bypass a read-only file, so that is checked explicitly (EACCES).
 * - A directory that can't take the temp file fails the write rather than
 *   falling back to an in-place write, which could leave a fragment.
 */
export function writeFileAtomic(absolutePath: string, content: string): void {
    const target = resolveWriteTarget(absolutePath);
    let mode: number | undefined;
    if (fs.existsSync(target)) {
        fs.accessSync(target, fs.constants.W_OK);
        mode = fs.statSync(target).mode & 0o7777;
    }
    const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
    try {
        fs.writeFileSync(temp, content, mode === undefined ? undefined : { mode });
        if (mode !== undefined) fs.chmodSync(temp, mode);
        fs.renameSync(temp, target);
    } catch (e) {
        try { fs.unlinkSync(temp); } catch { /* swallow: may not exist */ }
        throw e;
    }
}

/**
 * A key that is equal for two paths naming the same file, as far as can be
 * told without the file existing: resolved, symlinks followed where they
 * exist, and case-folded on the usually case-insensitive macOS/Windows.
 */
export function samePathKey(absolutePath: string): string {
    let resolved = path.resolve(absolutePath);
    try {
        resolved = fs.realpathSync.native(resolved);
    } catch {
        try {
            resolved = path.join(fs.realpathSync.native(path.dirname(resolved)), path.basename(resolved));
        } catch { /* parent missing too: keep as resolved */ }
    }
    return process.platform === 'darwin' || process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
