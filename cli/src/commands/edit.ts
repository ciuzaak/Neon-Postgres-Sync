import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { candidateFor } from '../../../src/core/plan';
import type { SyncDirection } from '../../../src/core/types';
import { CliContext, EXIT, ExitCode, UsageError } from '../context';
import { Host } from '../host';
import { renderDiff } from '../ui/diff';
import { sourceMissing } from '../policy';
import { describeOutcome } from './apply';
import { parseDirection } from './diff';
import { planRows, type Ui } from './status';

/** An editor returning faster than this without changes almost certainly didn't wait. */
const INSTANT_MS = 1000;

/**
 * Split an $EDITOR-style command into argv: whitespace separates words;
 * single quotes are literal, double quotes allow \" and \\, a backslash
 * outside quotes escapes the next character.
 */
export function splitCommand(command: string): string[] {
    const out: string[] = [];
    let word = '';
    let inWord = false;
    let quote: '"' | "'" | undefined;
    for (let i = 0; i < command.length; i++) {
        const ch = command[i];
        if (quote === "'") {
            if (ch === "'") quote = undefined; else word += ch;
        } else if (quote === '"') {
            if (ch === '"') quote = undefined;
            else if (ch === '\\' && (command[i + 1] === '"' || command[i + 1] === '\\')) word += command[++i];
            else word += ch;
        } else if (ch === "'" || ch === '"') {
            quote = ch;
            inWord = true;
        } else if (ch === '\\' && i + 1 < command.length) {
            word += command[++i];
            inWord = true;
        } else if (/\s/.test(ch)) {
            if (inWord) { out.push(word); word = ''; inWord = false; }
        } else {
            word += ch;
            inWord = true;
        }
    }
    if (quote) throw new UsageError(`Unbalanced quote in the editor command: ${command}`);
    if (inWord) out.push(word);
    return out;
}

export async function editCommand(
    ctx: CliContext,
    host: Host,
    names: string[],
    opts: { direction?: string; tool?: string },
    ui: Ui
): Promise<ExitCode> {
    if (!(ctx.stdinIsTTY && ctx.stdout.isTTY)) throw new UsageError('`edit` opens an editor, so it needs a terminal.');
    if (names.length !== 1) throw new UsageError('Usage: neon-sync edit <name> [--direction upload|download] [--tool code]');
    if (opts.tool !== undefined && opts.tool !== 'code') throw new UsageError(`--tool supports "code" only, not "${opts.tool}".`);
    const forced = parseDirection(opts.direction);
    const { style, sym } = ui;

    const [row] = await planRows(host, host.select(names, true));
    const name = row.profile.name;
    if (row.cls.kind === 'error') {
        ctx.stdout.write(`${style.red(sym.error)} ${name}: ${row.cls.label}${row.cls.detail ? ` — ${row.cls.detail}` : ''}\n`);
        return EXIT.stuck;
    }

    // Direction: given, else the known one, else ask (conflicts, guesses, in-sync rows).
    let direction: SyncDirection | undefined = forced ?? (row.cls.kind === 'auto' ? row.cls.direction : undefined);
    if (!direction) {
        const choices = (['upload', 'download'] as const)
            .filter((d) => !sourceMissing(row.plan!, d))
            .map((d) => ({
                value: d,
                label: d === 'upload' ? 'Edit the local version, then upload it' : 'Edit the remote version, then download it',
                hint: d === 'upload' ? 'replaces the remote version' : 'replaces the local file'
            }));
        const why = row.cls.kind === 'in-sync' ? 'in sync' : row.cls.detail ? `${row.cls.label} — ${row.cls.detail}` : row.cls.label;
        direction = await ctx.prompts.select(`${name}: ${why}. Which way?`, choices);
        if (!direction) return EXIT.pending;
    }
    const missing = sourceMissing(row.plan!, direction);
    if (missing) {
        ctx.stdout.write(`${style.red(sym.error)} ${name}: can't ${direction}: ${missing}.\n`);
        return EXIT.stuck;
    }

    const plan = row.plan!;
    const original = candidateFor(plan, direction);
    const destinationNow = direction === 'upload' ? plan.remoteContent : plan.localContent;
    const destLabel = direction === 'upload' ? `remote ${row.profile.tableName}/${row.profile.id}` : `local ${host.display(host.resolve(row.profile.filePath)!)}`;

    // Private temp dir; keep the profile's extension for syntax highlighting.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neon-sync-edit-'));
    try {
        fs.chmodSync(dir, 0o700);
        const ext = path.extname(row.profile.filePath) || '.txt';
        const safe = name.replace(/[^\w.-]+/g, '_');
        const candidatePath = path.join(dir, `${safe}.${direction === 'upload' ? 'local' : 'remote'}${ext}`);
        fs.writeFileSync(candidatePath, original, { mode: 0o600 });

        let command: string;
        let args: string[];
        if (opts.tool === 'code') {
            const destPath = path.join(dir, `${safe}.${direction === 'upload' ? 'remote' : 'local'}-now${ext}`);
            fs.writeFileSync(destPath, destinationNow, { mode: 0o600 });
            [command, args] = ['code', ['--wait', '--diff', destPath, candidatePath]];
        } else {
            const editor = ctx.env.VISUAL || ctx.env.EDITOR || (ctx.pathEnv.platform === 'win32' ? 'notepad' : 'vi');
            const parts = splitCommand(editor);
            if (parts.length === 0) throw new UsageError('$VISUAL/$EDITOR is empty.');
            [command, args] = [parts[0], [...parts.slice(1), candidatePath]];
        }

        ctx.stdout.write(style.dim(`Editing the ${direction === 'upload' ? 'local' : 'remote'} version of ${name} (excluded keys hidden). Save and close the editor when done.\n`));
        const started = ctx.now();
        const status = await ctx.runEditor(command, args);
        if (status !== 0) {
            ctx.stdout.write(`The editor exited with status ${status}; nothing was written.\n`);
            return EXIT.pending;
        }
        const edited = fs.readFileSync(candidatePath, 'utf-8');
        if (edited === original && ctx.now() - started < INSTANT_MS) {
            ctx.stdout.write(
                `${style.yellow(sym.conflict)} The editor returned immediately without changes — it probably doesn't wait for the file to close ` +
                '(for VS Code use `code --wait` in $EDITOR, or `--tool code`). Nothing was written.\n'
            );
            return EXIT.pending;
        }
        if (edited.trim() === '') {
            ctx.stdout.write('The file is empty; nothing was written.\n');
            return EXIT.pending;
        }

        // What the destination loses/gains — not just the edit.
        const diff = renderDiff(destinationNow, edited, `${destLabel} (now)`, `${destLabel} (after ${direction})`, style);
        ctx.stdout.write('\n' + (diff || style.dim('(the destination already holds exactly this)\n')) + '\n');
        const ok = await ctx.prompts.confirm(edited === original ? `Apply ${name} as is (${direction})?` : `Apply this to ${name} (${direction})?`);
        if (!ok) {
            ctx.stdout.write('Nothing was written.\n');
            return EXIT.pending;
        }

        const [outcome] = await (await host.engine([row.profile])).apply([{ plan, direction, candidate: edited }]);
        const d = describeOutcome(outcome, direction, ui);
        ctx.stdout.write(`  ${d.mark}  ${name}  ${d.text}\n`);
        return d.code;
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}
