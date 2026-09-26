import type { Style } from './format';

/**
 * A colored unified diff from `before` (what the destination holds now) to
 * `after` (what it would hold). Empty string when they're identical.
 */
export function renderDiff(before: string, after: string, beforeLabel: string, afterLabel: string, style: Style): string {
    if (before === after) return '';
    const { createTwoFilesPatch } = require('diff') as typeof import('diff');
    const patch = createTwoFilesPatch(beforeLabel, afterLabel, before, after, '', '', { context: 3 });
    return patch
        .split('\n')
        .filter((line) => !/^={10,}$/.test(line) && !line.startsWith('Index: '))
        .map((line) => {
            if (line.startsWith('---') || line.startsWith('+++')) return style.bold(line.replace(/\t$/, ''));
            if (line.startsWith('@@')) return style.cyan(line);
            if (line.startsWith('+')) return style.green(line);
            if (line.startsWith('-')) return style.red(line);
            if (line.startsWith('\\')) return style.dim(line);
            return line;
        })
        .join('\n')
        .replace(/\n+$/, '\n');
}
