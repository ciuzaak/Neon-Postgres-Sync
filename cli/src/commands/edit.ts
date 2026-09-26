import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { candidateFor } from '../../../src/core/plan';
import type { SyncDirection } from '../../../src/core/types';
import { CliContext, EXIT, ExitCode, UsageError } from '../context';
import { Host } from '../host';
import { renderDiff } from '../ui/diff';
import { isLargeDeletion, overwritesUnreviewed, sourceMissing } from '../policy';
import { describeOutcome } from './apply';
import { parseDirection } from './diff';
import { planRows, type Ui } from './status';

/** An editor returning faster than this without changes almost certainly didn't wait. */
const INSTANT_MS = 1000;

/**
 * Temp dirs holding config contents, removed on every way out: normal
 * return (finally), process exit, and SIGTERM/SIGHUP (which would otherwise
 * kill us before `finally` runs). SIGINT/SIGQUIT are ignored while the editor
 * runs (see context.runEditor).
 */
const liveTempDirs = new Set<string>();
let hooksInstalled = false;
function trackTempDir(dir: string): void {
    liveTempDirs.add(dir);
    if (hooksInstalled) return;
    hooksInstalled = true;
    const cleanup = () => { for (const d of liveTempDirs) fs.rmSync(d, { recursive: true, force: true }); liveTempDirs.clear(); };
    process.on('exit', cleanup);
    for (const signal of ['SIGTERM', 'SIGHUP'] as const) {
        process.once(signal, () => { cleanup(); process.kill(process.pid, signal); });
    }
}

/** A file extension safe to put in a temp file name (and on a Windows command line). */
function safeExtension(filePath: string): string {
    const ext = path.extname(filePath);
    return /^\.[A-Za-z0-9_-]{1,15}$/.test(ext) ? ext : '.txt';
}

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
    trackTempDir(dir);
    try {
        fs.chmodSync(dir, 0o700);
        const ext = safeExtension(row.profile.filePath);
        const safe = name.replace(/[^\w.-]+/g, '_').slice(0, 60);
        const candidatePath = path.join(dir, `${safe}.${direction === 'upload' ? 'local' : 'remote'}${ext}`);
        fs.writeFileSync(candidatePath, original, { mode: 0o600 });

        let command: string;
        let args: string[];
        let destPath: string | undefined;
        if (opts.tool === 'code') {
            destPath = path.join(dir, `${safe}.${direction === 'upload' ? 'remote' : 'local'}-now${ext}`);
            fs.writeFileSync(destPath, destinationNow, { mode: 0o600 });
            [command, args] = ['code', ['--wait', '--diff', destPath, candidatePath]];
        } else {
            const editor = ctx.env.VISUAL || ctx.env.EDITOR || (ctx.pathEnv.platform === 'win32' ? 'notepad' : 'vi');
            const parts = splitCommand(editor);
            if (parts.length === 0) throw new UsageError('$VISUAL/$EDITOR is empty.');
            [command, args] = [parts[0], [...parts.slice(1), candidatePath]];
        }

        const hidden = plan.excludeKeys.length > 0 ? ' (excluded keys hidden)' : '';
        const which = opts.tool === 'code' ? ' — edit the right-hand side' : '';
        ctx.stdout.write(style.dim(`Editing the ${direction === 'upload' ? 'local' : 'remote'} version of ${name}${hidden}${which}. Save and close the editor when done.\n`));
        const started = ctx.now();
        let status: number;
        try {
            status = await ctx.runEditor(command, args);
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
                throw new UsageError(`Couldn't start the editor "${command}". Set $VISUAL or $EDITOR (e.g. "code --wait", "nano", "vim").`);
            }
            throw e;
        }
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

        if (destPath && fs.readFileSync(destPath, 'utf-8') !== destinationNow) {
            ctx.stdout.write(style.yellow(`${sym.conflict} Edits to the left-hand (current ${direction === 'upload' ? 'remote' : 'local'}) side are ignored; only the right-hand side is used.\n`));
        }

        // What the destination loses/gains — not just the edit — and, like
        // push/pull, say plainly when this overrides the safety rule.
        const diff = renderDiff(destinationNow, edited, `${destLabel} (now)`, `${destLabel} (after ${direction})`, style);
        ctx.stdout.write('\n' + (diff || style.dim('(the destination already holds exactly this)\n')) + '\n');
        const destination = direction === 'upload' ? 'remote' : 'local';
        const warnings = [
            overwritesUnreviewed(plan, direction) && (plan.change === 'unknown'
                ? `This may overwrite ${destination} changes (no sync history).`
                : `This overwrites ${destination} changes made since the last sync.`),
            isLargeDeletion(edited, destinationNow) && `This removes most of the ${destination} content.`
        ].filter(Boolean);
        for (const w of warnings) ctx.stdout.write(style.yellow(`${sym.conflict} ${w}\n`));
        const ok = await ctx.prompts.confirm(edited === original ? `Apply ${name} as is (${direction})?` : `Apply this to ${name} (${direction})?`);
        if (!ok) {
            ctx.stdout.write('Nothing was written.\n');
            return EXIT.pending;
        }
        // The editor may still write after returning (e.g. `code` without --wait):
        // apply only what was shown.
        if (fs.readFileSync(candidatePath, 'utf-8') !== edited) {
            ctx.stdout.write(`${style.yellow(sym.conflict)} The file changed after the editor returned; nothing was written. Run \`neon-sync edit ${name}\` again.\n`);
            return EXIT.pending;
        }

        const [outcome] = await (await host.engine([row.profile])).apply([{ plan, direction, candidate: edited }]);
        const d = describeOutcome(outcome, direction, ui);
        ctx.stdout.write(`  ${d.mark}  ${name}  ${d.text}\n`);
        return d.code;
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
        liveTempDirs.delete(dir);
    }
}
