import type { RowClass } from '../policy';

export interface Style {
    bold(s: string): string;
    dim(s: string): string;
    green(s: string): string;
    red(s: string): string;
    yellow(s: string): string;
    cyan(s: string): string;
}

const identity = (s: string) => s;
export const PLAIN: Style = { bold: identity, dim: identity, green: identity, red: identity, yellow: identity, cyan: identity };

export function makeStyle(enabled: boolean): Style {
    if (!enabled) return PLAIN;
    const pc = require('picocolors') as typeof import('picocolors');
    const c = pc.createColors(true);
    return { bold: c.bold, dim: c.dim, green: c.green, red: c.red, yellow: c.yellow, cyan: c.cyan };
}

/** Colors on only for a TTY, and never with NO_COLOR / --no-color / TERM=dumb. */
export function colorEnabled(isTTY: boolean, env: Record<string, string | undefined>, noColorFlag: boolean): boolean {
    return isTTY && !noColorFlag && env.TERM !== 'dumb' && !('NO_COLOR' in env && env.NO_COLOR !== '');
}

/**
 * Legacy Windows consoles can't render the status symbols (they'd come out
 * as "?", itself a symbol). Use ASCII there unless the terminal is known
 * to be modern.
 */
export function asciiByDefault(platform: NodeJS.Platform, env: Record<string, string | undefined>): boolean {
    if (env.TERM === 'dumb') return true;
    if (platform !== 'win32') return false;
    return !(env.WT_SESSION || env.TERM_PROGRAM || env.ConEmuANSI === 'ON' || /xterm|256color/.test(env.TERM ?? ''));
}

export interface Symbols {
    inSync: string;
    upload: string;
    download: string;
    conflict: string;
    unknown: string;
    error: string;
    ellipsis: string;
    minus: string;
    dot: string;
    arrowLeft: string;
    arrowRight: string;
    /** Between two things that sync both ways. */
    both: string;
    /** A dash between a label and its explanation. */
    dash: string;
}

export const UNICODE: Symbols = { inSync: '✓', upload: '↑', download: '↓', conflict: '⚠', unknown: '?', error: '✗', ellipsis: '…', minus: '−', dot: '·', arrowLeft: '←', arrowRight: '→', both: '⇄', dash: '—' };
export const ASCII: Symbols = { inSync: '=', upload: '^', download: 'v', conflict: '!', unknown: '?', error: 'x', ellipsis: '...', minus: '-', dot: '|', arrowLeft: '<-', arrowRight: '->', both: '<->', dash: '-' };

export function rowSymbol(row: RowClass, sym: Symbols, style: Style): string {
    switch (row.kind) {
        case 'in-sync': return style.green(sym.inSync);
        case 'error': return style.red(sym.error);
        case 'auto': return style.cyan(row.direction === 'upload' ? sym.upload : sym.download);
        case 'decide': return style.yellow(/^(no history|excludeKeys)/.test(row.label) ? sym.unknown : sym.conflict);
    }
}

/** Shorten `text` to `width` by cutting the middle (paths keep both ends readable). */
export function truncateMiddle(text: string, width: number, ellipsis: string): string {
    if (text.length <= width) return text;
    if (width <= ellipsis.length) return text.slice(0, width);
    const keep = width - ellipsis.length;
    const head = Math.ceil(keep / 2);
    return text.slice(0, head) + ellipsis + text.slice(text.length - (keep - head));
}

export function pad(text: string, width: number): string {
    return text.length >= width ? text : text + ' '.repeat(width - text.length);
}
