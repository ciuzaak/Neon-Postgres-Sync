import type { SyncPlan } from '../../../src/core/plan';
import type { Profile } from '../../../src/core/types';
import { CliContext, EXIT, ExitCode, worstExit } from '../context';
import { Host } from '../host';
import { classify, RowClass } from '../policy';
import { describeUrl } from '../secrets';
import { pad, rowSymbol, truncateMiddle, type Style, type Symbols } from '../ui/format';

export interface Ui {
    style: Style;
    sym: Symbols;
}

export interface Row {
    profile: Profile;
    cls: RowClass;
    plan?: SyncPlan;
}

/**
 * Plan every selected profile (one batch fetch). Blocked profiles (relative
 * path, shared file, WSL boundary) become error rows without being planned.
 */
export async function planRows(host: Host, profiles: Profile[]): Promise<Row[]> {
    const blockers = host.blockers(profiles);
    const syncable = profiles.filter((p) => !blockers.has(p.name));
    const plans = syncable.length > 0 ? await (await host.engine(syncable)).plan(syncable) : [];
    const byName = new Map(plans.map((plan) => [plan.profile.name, plan]));
    return profiles.map((profile) => {
        const blocked = blockers.get(profile.name);
        if (blocked) {
            return { profile, cls: { kind: 'error', label: blocked.label, detail: blocked.detail, added: 0, removed: 0 } };
        }
        const plan = byName.get(profile.name)!;
        return { profile, plan, cls: classify(plan) };
    });
}

export function exitFor(rows: Row[]): ExitCode {
    return worstExit(...rows.map((r) =>
        r.cls.kind === 'error' ? EXIT.stuck : r.cls.kind === 'in-sync' ? EXIT.ok : EXIT.pending
    ));
}

export async function statusCommand(
    ctx: CliContext,
    host: Host,
    names: string[],
    opts: { json: boolean; allowPrefix: boolean },
    ui: Ui,
    report?: { actionable: number }
): Promise<ExitCode> {
    const profiles = host.select(names, opts.allowPrefix);
    const rows = await planRows(host, profiles);
    if (report) report.actionable = rows.filter((r) => r.cls.kind === 'auto' || r.cls.kind === 'decide').length;

    if (opts.json) {
        ctx.stdout.write(JSON.stringify({
            configPath: host.configPath(),
            profiles: rows.map(({ profile, cls, plan }) => ({
                name: profile.name,
                filePath: profile.filePath,
                status: cls.kind,
                change: plan?.change ?? null,
                direction: cls.direction ?? null,
                autoApplicable: cls.kind === 'auto',
                label: cls.label,
                reason: cls.detail ?? null,
                added: cls.added,
                removed: cls.removed,
                error: cls.kind === 'error' ? (cls.detail ? `${cls.label}: ${cls.detail}` : cls.label) : null
            }))
        }, null, 2) + '\n');
        return exitFor(rows);
    }

    const { style, sym } = ui;
    const where = rows.some((r) => r.plan) ? ` ${sym.dot} ${describeUrl((await host.connection()).url)}` : '';
    const head = `neon-sync ${sym.dot} ${profiles.length} profile${profiles.length === 1 ? '' : 's'}${where} ${sym.dot} `;
    const cols = ctx.stdout.columns || 100; // 0 from some ptys means unknown
    const configShown = truncateMiddle(host.display(host.configPath()), Math.max(12, cols - 1 - head.length), sym.ellipsis);
    ctx.stdout.write(`\n ${style.bold('neon-sync')}${head.slice('neon-sync'.length)}${style.dim(configShown)}\n\n`);
    if (profiles.length === 0) {
        ctx.stdout.write('  No profiles yet. Add one with `neon-sync profile add`.\n\n');
        return EXIT.ok;
    }

    // Layout: symbol, name, path, label, stats. On narrow terminals names and
    // labels are shortened first; the path column is dropped when it would be
    // too narrow to be useful (`profile show` has it in full).
    const columns = cols;
    const shownPath = (p: Profile) => host.display(host.resolve(p.filePath) ?? p.filePath);
    const STATS_W = rows.some((r) => r.cls.kind === 'auto' || r.cls.kind === 'decide') ? 10 : 0;
    const nameW = Math.min(Math.max(...rows.map((r) => r.profile.name.length)), Math.max(10, Math.floor(columns * 0.3)));
    const labelW = Math.min(Math.max(...rows.map((r) => r.cls.label.length)), 28, Math.max(8, columns - (9 + nameW + STATS_W)));
    const room = columns - (2 + 1 + 2 + nameW + 2 + 2 + labelW + 2 + STATS_W);
    const pathW = room >= 12 ? Math.min(48, room, Math.max(...rows.map((r) => shownPath(r.profile).length))) : 0;
    const clip = (text: string, width: number) => text.length <= width ? text : text.slice(0, Math.max(1, width - sym.ellipsis.length)) + sym.ellipsis;

    for (const { profile, cls } of rows) {
        const stats = cls.kind === 'auto'
            ? `${style.green(`+${cls.added}`)} ${style.red(`${sym.minus}${cls.removed}`)}`
            : cls.kind === 'decide' ? style.yellow('decide') : '';
        const shown = clip(cls.label, labelW);
        const label = cls.kind === 'error' ? style.red(shown) : shown;
        const labelPad = ' '.repeat(Math.max(0, labelW - shown.length));
        const pathCell = pathW > 0 ? `${style.dim(pad(truncateMiddle(shownPath(profile), pathW, sym.ellipsis), pathW))}  ` : '';
        ctx.stdout.write(
            `  ${rowSymbol(cls, sym, style)}  ${pad(clip(profile.name, nameW), nameW)}  ${pathCell}` +
            `${label}${labelPad}  ${stats}`.trimEnd() + '\n'
        );
        if (cls.kind === 'error' && cls.detail) {
            ctx.stdout.write(`       ${style.dim(clip(cls.detail, Math.max(20, columns - 7)))}\n`);
        }
    }

    const count = (k: RowClass['kind']) => rows.filter((r) => r.cls.kind === k).length;
    const parts = [
        count('auto') && `${count('auto')} ready to apply`,
        count('decide') && `${count('decide')} need${count('decide') === 1 ? 's' : ''} a decision`,
        count('error') && `${count('error')} can't sync`
    ].filter(Boolean);
    ctx.stdout.write(`\n  ${parts.length ? parts.join(` ${sym.dot} `) : style.green('Everything is in sync.')}\n`);
    if (count('auto') + count('decide') > 0) {
        ctx.stdout.write(style.dim('  Run `neon-sync sync` to review and apply.\n'));
    }
    ctx.stdout.write('\n');
    return exitFor(rows);
}
