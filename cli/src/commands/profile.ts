import { CliContext, EXIT, ExitCode, UsageError } from '../context';
import { Host } from '../host';
import { pad } from '../ui/format';
import type { Ui } from './status';

export async function profileCommand(
    ctx: CliContext,
    host: Host,
    args: string[],
    opts: { json: boolean },
    ui: Ui
): Promise<ExitCode> {
    const [sub, ...rest] = args;
    switch (sub) {
        case 'list': {
            if (rest.length > 0) throw new UsageError('Usage: neon-sync profile list');
            const profiles = host.profiles();
            if (opts.json) {
                ctx.stdout.write(JSON.stringify({ configPath: host.configPath(), profiles }, null, 2) + '\n');
                return EXIT.ok;
            }
            if (profiles.length === 0) {
                ctx.stdout.write(`No profiles in ${host.display(host.configPath())}. Add one with \`neon-sync profile add\`.\n`);
                return EXIT.ok;
            }
            const nameW = Math.max(...profiles.map((p) => p.name.length));
            for (const p of profiles) {
                const excluded = p.excludeKeys?.length ? ui.style.dim(`  excludes ${p.excludeKeys.join(', ')}`) : '';
                ctx.stdout.write(
                    `  ${pad(p.name, nameW)}  ${p.filePath}  ${ui.style.dim(`${p.tableName}/${p.id}`)}${excluded}\n`
                );
            }
            return EXIT.ok;
        }
        case 'show': {
            if (rest.length !== 1) throw new UsageError('Usage: neon-sync profile show <name>');
            const [p] = host.select(rest, ctx.stdinIsTTY && !opts.json);
            const resolved = host.resolve(p.filePath);
            const blocked = host.blockers([p]).get(p.name);
            if (opts.json) {
                ctx.stdout.write(JSON.stringify({ ...p, resolvedPath: resolved ?? null, blocked: blocked ? `${blocked.label}: ${blocked.detail}` : null }, null, 2) + '\n');
                return EXIT.ok;
            }
            const line = (k: string, v: string) => ctx.stdout.write(`  ${pad(k, 13)}${v}\n`);
            line('name', p.name);
            line('file', p.filePath + (resolved && resolved !== p.filePath ? ui.style.dim(`  → ${resolved}`) : ''));
            line('record', `${p.tableName} / ${p.id}`);
            line('excludeKeys', p.excludeKeys?.length ? p.excludeKeys.join(', ') : ui.style.dim('none'));
            if (blocked) line('status', ui.style.red(`can't sync (${blocked.label}): ${blocked.detail}`));
            return blocked ? EXIT.stuck : EXIT.ok;
        }
        default:
            throw new UsageError('Usage: neon-sync profile list | show <name>');
    }
}
