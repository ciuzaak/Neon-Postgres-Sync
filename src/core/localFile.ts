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
