import type { ApplyOutcome } from '../../../src/core/engine';
import { candidateFor } from '../../../src/core/plan';
import type { SyncDirection } from '../../../src/core/types';
import { Choice, CliContext, EXIT, ExitCode, UsageError, worstExit } from '../context';
import { Host } from '../host';
import { forcedNeedsDecision, sourceMissing as missingSource } from '../policy';
import { diffFor } from './diff';
import { planRows, type Row, type Ui } from './status';

export type ApplyMode = 'sync' | 'pull' | 'push';

export interface ApplyOptions {
    yes: boolean;
    force: boolean;
    dryRun: boolean;
    json: boolean;
    all: boolean;
    prefer?: string;
    /** TTY on both ends and no --yes/--json: prompts allowed. */
    interactive: boolean;
    allowPrefix: boolean;
}

/** What happens to one row, before anything is written. */
type Decision =
    | { row: Row; action: 'apply'; direction: SyncDirection; how: 'auto' | 'preferred' | 'chosen' | 'forced' }
    | { row: Row; action: 'skip'; why: string; code: ExitCode }
    | { row: Row; action: 'none'; why: string; code: ExitCode }; // in sync, or can't sync

interface Pending {
    row: Row;
    /** Direction if it's already decided (auto / forced), else undefined. */
    direction?: SyncDirection;
    /** Needs an explicit per-row answer before it can be applied. */
    needsAnswer: boolean;
    /** How the direction was settled when no answer is needed. */
    how: 'auto' | 'preferred' | 'forced';
    reason: string;
}

const FORCED: Record<ApplyMode, SyncDirection | undefined> = { sync: undefined, pull: 'download', push: 'upload' };

/** A row's source side is missing (see policy.sourceMissing). */
function sourceMissing(row: Row, direction: SyncDirection): string | undefined {
    return missingSource(row.plan!, direction);
}

function sideName(direction: SyncDirection): string {
    return direction === 'upload' ? 'local' : 'remote';
}

export async function applyCommand(
    ctx: CliContext,
    host: Host,
    mode: ApplyMode,
    names: string[],
    opts: ApplyOptions,
    ui: Ui
): Promise<ExitCode> {
    if (opts.json && !opts.yes && !opts.dryRun) {
        throw new UsageError('--json never prompts: add --yes to apply, or --dry-run to preview.');
    }
    if (mode !== 'sync' && names.length === 0 && !opts.all) {
        throw new UsageError(`\`${mode}\` needs profile names, or --all.`);
    }
    if (opts.all && names.length > 0) throw new UsageError('Give profile names or --all, not both.');
    let prefer: SyncDirection | undefined;
    if (opts.prefer !== undefined) {
        if (opts.prefer !== 'local' && opts.prefer !== 'remote') {
            throw new UsageError(`--prefer must be "local" or "remote", not "${opts.prefer}".`);
        }
        if (names.length === 0) {
            throw new UsageError('--prefer needs explicit profile names (it decides those rows; there is no "resolve everything one way").');
        }
        prefer = opts.prefer === 'local' ? 'upload' : 'download';
    }
    if (opts.force && mode === 'sync') throw new UsageError('`sync` has no --force; use `pull` or `push` to force a direction.');

    const profiles = names.length > 0 ? host.select(names, opts.allowPrefix) : host.profiles();
    const rows = await planRows(host, profiles);
    const forced = FORCED[mode];

    // 1. Classify every row.
    const decisions: Decision[] = [];
    const pending: Pending[] = [];
    for (const row of rows) {
        const { cls } = row;
        if (cls.kind === 'error') {
            decisions.push({ row, action: 'none', why: `can't sync: ${cls.label}${cls.detail ? ` — ${cls.detail}` : ''}`, code: EXIT.stuck });
            continue;
        }
        if (cls.kind === 'in-sync') {
            decisions.push({ row, action: 'none', why: 'in sync', code: EXIT.ok });
            continue;
        }
        if (forced) {
            const missing = sourceMissing(row, forced);
            if (missing) {
                decisions.push({ row, action: 'none', why: `can't ${mode}: ${missing}`, code: EXIT.stuck });
            } else if (forcedNeedsDecision(row.plan!, forced)) {
                // --force skips the question only unattended (with --yes); in a
                // terminal every such row is still confirmed one by one.
                pending.push({
                    row,
                    direction: forced,
                    needsAnswer: !(opts.force && opts.yes),
                    how: 'forced',
                    reason: forcedNeedsDecision(row.plan!, forced)!
                });
            } else {
                pending.push({ row, direction: forced, needsAnswer: false, how: 'forced', reason: cls.label });
            }
            continue;
        }
        // sync
        if (cls.kind === 'auto') {
            pending.push({ row, direction: cls.direction, needsAnswer: false, how: 'auto', reason: cls.label });
        } else if (prefer) {
            // Only reachable with explicit names (checked above): naming the profile is the decision.
            pending.push({ row, direction: prefer, needsAnswer: false, how: 'preferred', reason: `${cls.label} — --prefer ${opts.prefer}` });
        } else {
            pending.push({ row, direction: undefined, needsAnswer: true, how: 'auto', reason: cls.detail ? `${cls.label} — ${cls.detail}` : cls.label });
        }
    }

    // 2. Resolve rows that need an answer: prompts interactively, else skip.
    const chosen = opts.interactive ? await askUser(ctx, host, mode, pending, ui) : undefined;
    if (opts.interactive && chosen === undefined) {
        ctx.stdout.write('Cancelled; nothing was written.\n');
        return EXIT.pending;
    }
    for (const p of pending) {
        const answer = chosen?.get(p.row);
        let direction: SyncDirection | undefined;
        let how: 'auto' | 'preferred' | 'chosen' | 'forced';
        if (opts.interactive) {
            if (answer === undefined || answer === 'skip') {
                decisions.push({ row: p.row, action: 'skip', why: answer === 'skip' ? 'skipped' : 'not selected', code: EXIT.pending });
                continue;
            }
            direction = answer;
            how = p.needsAnswer ? 'chosen' : p.how;
        } else if (p.needsAnswer) {
            const hint = forced
                ? `${p.reason}; confirm it in a terminal, or add --force --yes`
                : `${p.reason}; decide interactively, or \`neon-sync sync ${p.row.profile.name} --prefer local|remote --yes\``;
            decisions.push({ row: p.row, action: 'skip', why: `needs a decision: ${hint}`, code: EXIT.pending });
            continue;
        } else {
            direction = p.direction!;
            how = p.how;
        }
        const missing = sourceMissing(p.row, direction);
        if (missing) {
            decisions.push({ row: p.row, action: 'skip', why: `can't ${direction}: ${missing} (deletions aren't synced)`, code: EXIT.stuck });
            continue;
        }
        decisions.push({ row: p.row, action: 'apply', direction, how });
    }

    const toApply = decisions.filter((d): d is Extract<Decision, { action: 'apply' }> => d.action === 'apply');

    // 3. Preview / refuse / apply.
    const applying = toApply.length > 0 && !opts.dryRun && (opts.yes || opts.interactive);
    let outcomes = new Map<Row, ApplyOutcome>();
    if (applying) {
        const engine = await host.engine(toApply.map((d) => d.row.profile));
        const requests = toApply.map((d) => ({ plan: d.row.plan!, direction: d.direction, candidate: candidateFor(d.row.plan!, d.direction) }));
        const results = await engine.apply(requests);
        outcomes = new Map(results.map((o, i) => [toApply[i].row, o]));
    }

    return report(ctx, host, decisions, outcomes, { ...opts, applying }, ui);
}

/**
 * Interactive selection; returns per row the chosen direction or 'skip' (the
 * user picked Skip), absent = not selected. Undefined if cancelled.
 */
async function askUser(ctx: CliContext, host: Host, mode: ApplyMode, pending: Pending[], ui: Ui): Promise<Map<Row, SyncDirection | 'skip'> | undefined> {
    const out = new Map<Row, SyncDirection | 'skip'>();
    if (pending.length === 0) return out;
    const { sym } = ui;
    const arrow = (d?: SyncDirection) => d === 'upload' ? sym.upload : d === 'download' ? sym.download : sym.conflict;
    const choices: Choice<string>[] = pending.map((p, i) => ({
        value: String(i),
        label: `${arrow(p.direction)} ${p.row.profile.name}`,
        hint: p.needsAnswer ? `${p.reason} — you'll be asked` : p.reason
    }));
    const picked = await ctx.prompts.multiselect(
        mode === 'sync' ? 'Apply which?' : `${mode === 'pull' ? 'Download' : 'Upload'} which?`,
        choices,
        pending.flatMap((p, i) => (p.needsAnswer ? [] : [String(i)]))
    );
    if (picked === undefined) return undefined;

    for (const index of picked) {
        const p = pending[Number(index)];
        if (!p.needsAnswer) {
            out.set(p.row, p.direction!);
            continue;
        }
        const plan = p.row.plan!;
        for (;;) {
            const options: Choice<string>[] = [];
            if (p.direction && mode !== 'sync') {
                options.push({ value: p.direction, label: `${p.direction === 'upload' ? 'Upload' : 'Download'} anyway`, hint: p.reason });
            } else {
                for (const d of ['upload', 'download'] as const) {
                    if (sourceMissing(p.row, d)) continue;
                    const other = d === 'upload' ? 'remote' : 'local';
                    const destinationMissing = d === 'upload' ? !plan.remoteExists : !plan.localExists;
                    options.push({
                        value: d,
                        label: `Keep ${sideName(d)} (${d})`,
                        hint: destinationMissing ? `restores the ${other} copy` : `replaces the ${other} version`
                    });
                }
            }
            options.push({ value: 'diff', label: 'Show diff' }, { value: 'skip', label: 'Skip' });
            const answer = await ctx.prompts.select(`${p.row.profile.name}: ${p.reason}. What should happen?`, options);
            if (answer === undefined) return undefined;
            if (answer === 'skip') {
                out.set(p.row, 'skip');
                break;
            }
            if (answer === 'diff') {
                // The diff of every direction offered, so neither choice is blind.
                const directions = options.map((o) => o.value).filter((v): v is SyncDirection => v === 'upload' || v === 'download');
                const text = directions
                    .map((d) => `${ui.style.bold(`If you ${d}:`)}\n${diffFor(host, p.row, d, ui) || '(no differences)\n'}`)
                    .join('\n');
                const tall = ctx.stdout.rows !== undefined && text.split('\n').length > ctx.stdout.rows;
                if (!(tall && ctx.page(text))) ctx.stdout.write(text + '\n');
                continue;
            }
            out.set(p.row, answer as SyncDirection);
            break;
        }
    }
    return out;
}

function report(
    ctx: CliContext,
    host: Host,
    decisions: Decision[],
    outcomes: Map<Row, ApplyOutcome>,
    opts: ApplyOptions & { applying: boolean },
    ui: Ui
): ExitCode {
    const { style, sym } = ui;
    const codes: ExitCode[] = [];
    const json: Array<Record<string, unknown>> = [];
    const lines: string[] = [];
    const verb = (d: SyncDirection) => (d === 'upload' ? 'uploaded' : 'downloaded');

    for (const d of decisions) {
        const name = d.row.profile.name;
        if (d.action !== 'apply') {
            codes.push(d.code);
            json.push({ name, kind: d.action === 'skip' ? 'skipped' : d.code === EXIT.ok ? 'in-sync' : 'error', reason: d.why });
            if (d.code !== EXIT.ok || decisions.length === 1) {
                const mark = d.code === EXIT.stuck ? style.red(sym.error) : d.code === EXIT.ok ? style.green(sym.inSync) : style.yellow(sym.conflict);
                lines.push(`  ${mark}  ${name}  ${style.dim(d.why)}`);
            }
            continue;
        }
        const arrow = style.cyan(d.direction === 'upload' ? sym.upload : sym.download);
        if (!opts.applying) {
            codes.push(EXIT.pending);
            json.push({ name, kind: 'would-apply', direction: d.direction, how: d.how });
            lines.push(`  ${arrow}  ${name}  ${style.dim(`would ${d.direction}`)}`);
            continue;
        }
        const o = outcomes.get(d.row)!;
        switch (o.kind) {
            case 'ok':
                codes.push(EXIT.ok);
                json.push({ name, kind: 'applied', direction: d.direction, ...(o.baselineError ? { baselineError: o.baselineError } : {}) });
                lines.push(`  ${arrow}  ${name}  ${verb(d.direction)}` + (o.baselineError
                    ? style.yellow(` (couldn't record sync history: ${o.baselineError} — the next sync may ask about this profile)`)
                    : ''));
                break;
            case 'stale-remote':
            case 'not-applied':
                codes.push(EXIT.failure);
                json.push({ name, kind: o.kind, direction: d.direction });
                lines.push(`  ${style.red(sym.error)}  ${name}  ${o.kind === 'stale-remote'
                    ? 'the remote changed meanwhile — nothing written; re-run'
                    : 'not applied — another row in the batch was stale; re-run'}`);
                break;
            case 'stale-local':
                codes.push(EXIT.failure);
                json.push({ name, kind: o.kind, direction: d.direction, remoteCommitted: o.remoteCommitted });
                lines.push(`  ${style.red(sym.error)}  ${name}  ${o.remoteCommitted
                    ? 'remote saved, but the local file changed meanwhile and was not overwritten; re-run'
                    : 'the local file changed meanwhile — nothing written; re-run'}`);
                break;
            case 'merge-error':
                codes.push(EXIT.failure);
                json.push({ name, kind: o.kind, direction: d.direction, error: o.error.message });
                lines.push(`  ${style.red(sym.error)}  ${name}  ${o.error.message}`);
                break;
            case 'local-write-failed':
                codes.push(EXIT.failure);
                json.push({ name, kind: o.kind, direction: d.direction, remoteCommitted: o.remoteCommitted, error: o.error });
                lines.push(`  ${style.red(sym.error)}  ${name}  ${o.remoteCommitted
                    ? `remote saved, but writing the local file failed (${o.error}); re-run to rewrite it`
                    : `writing the local file failed: ${o.error}`}`);
                break;
        }
    }

    const code = worstExit(...codes);
    if (opts.json) {
        ctx.stdout.write(JSON.stringify({ configPath: host.configPath(), dryRun: opts.dryRun, outcomes: json }, null, 2) + '\n');
        return code;
    }
    if (lines.length === 0) {
        ctx.stdout.write(`${style.green(sym.inSync)} Everything is in sync.\n`);
        return code;
    }
    ctx.stdout.write(lines.join('\n') + '\n');
    if (!opts.applying && decisions.some((d) => d.action === 'apply') && !opts.dryRun) {
        ctx.stdout.write(style.dim('\nNothing was written: add --yes to apply (or run in a terminal to choose).\n'));
    }
    return code;
}
