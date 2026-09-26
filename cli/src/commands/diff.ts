import { candidateFor } from '../../../src/core/plan';
import type { SyncDirection } from '../../../src/core/types';
import { CliContext, EXIT, ExitCode, UsageError } from '../context';
import { Host } from '../host';
import { renderDiff } from '../ui/diff';
import { planRows, type Row, type Ui } from './status';

export function parseDirection(value: string | undefined): SyncDirection | undefined {
    if (value === undefined) return undefined;
    if (value === 'upload' || value === 'download') return value;
    throw new UsageError(`--direction must be "upload" or "download", not "${value}".`);
}

/** Destination-now → destination-after text for a planned row, with labels. */
export function diffFor(host: Host, row: Row, direction: SyncDirection, ui: Ui): string {
    const plan = row.plan!;
    const profile = row.profile;
    const local = host.display(host.resolve(profile.filePath) ?? profile.filePath);
    const remote = `${profile.tableName}/${profile.id}`;
    const [before, label] = direction === 'upload'
        ? [plan.remoteContent, `remote ${remote}`]
        : [plan.localContent, `local ${local}`];
    return renderDiff(before, candidateFor(plan, direction), `${label} (now)`, `${label} (after ${direction})`, ui.style);
}

export async function diffCommand(
    ctx: CliContext,
    host: Host,
    names: string[],
    opts: { direction?: string; allowPrefix: boolean },
    ui: Ui
): Promise<ExitCode> {
    if (names.length !== 1) throw new UsageError('Usage: neon-sync diff <name> [--direction upload|download]');
    const forced = parseDirection(opts.direction);
    const [row] = await planRows(host, host.select(names, opts.allowPrefix));
    const { style, sym } = ui;

    if (row.cls.kind === 'error') {
        ctx.stdout.write(`${style.red(sym.error)} ${row.profile.name}: ${row.cls.label}${row.cls.detail ? ` — ${row.cls.detail}` : ''}\n`);
        return EXIT.stuck;
    }
    if (row.cls.kind === 'in-sync') {
        ctx.stdout.write(`${style.green(sym.inSync)} ${row.profile.name} is in sync.\n`);
        return EXIT.ok;
    }

    const direction = forced ?? row.cls.direction ?? row.plan!.suggestion.direction;
    const arrow = direction === 'upload' ? `${sym.upload} upload (Remote ${sym.arrowLeft} Local)` : `${sym.download} download (Local ${sym.arrowLeft} Remote)`;
    const notes = [
        row.cls.label,
        row.plan!.excludeKeys.length ? `excluded keys hidden: ${row.plan!.excludeKeys.map((k) => k.join('.')).join(', ')}` : ''
    ].filter(Boolean).join(` ${sym.dot} `);
    let text = `${style.bold(row.profile.name)}  ${arrow}  ${style.dim(notes)}\n\n`;
    text += diffFor(host, row, direction, ui) || style.dim('(no differences in this direction)\n');

    const tall = ctx.stdout.isTTY && ctx.stdout.rows !== undefined && text.split('\n').length > ctx.stdout.rows;
    if (!(tall && ctx.page(text))) ctx.stdout.write(text);
    return EXIT.pending;
}
