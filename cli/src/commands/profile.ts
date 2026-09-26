import * as path from 'path';
import { normalizeProfileForWrite } from '../../../src/core/configFile';
import { samePathKey } from '../../../src/core/localFile';
import { abbreviateHome, expandHome } from '../../../src/core/paths';
import { hasErrors, validateProfileForm } from '../../../src/core/profileValidation';
import type { Profile } from '../../../src/core/types';
import { CliContext, EXIT, ExitCode, UsageError } from '../context';
import { Host } from '../host';
import { pad } from '../ui/format';
import { DEFAULT_TABLE } from './initDb';
import type { Ui } from './status';

export interface ProfileFlags {
    json: boolean;
    yes: boolean;
    file?: string;
    id?: string;
    table?: string;
    exclude?: string[];
}

export async function profileCommand(
    ctx: CliContext,
    host: Host,
    args: string[],
    opts: ProfileFlags,
    ui: Ui
): Promise<ExitCode> {
    const interactive = ctx.stdinIsTTY && ctx.stdout.isTTY && !opts.json;
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
        case 'add':
            return addProfile(ctx, host, rest, opts, interactive, ui);
        case 'remove': {
            if (rest.length !== 1) throw new UsageError('Usage: neon-sync profile remove <name> [--yes]');
            const [target] = host.select(rest, false); // exact names only: this deletes
            if (!opts.yes) {
                if (!interactive) throw new UsageError('Removing a profile needs --yes when not in a terminal.');
                const ok = await ctx.prompts.confirm(`Remove profile "${target.name}"? (The file and the remote record are kept.)`);
                if (!ok) return EXIT.pending;
            }
            let found = false;
            host.configStore().update((config) => {
                found = config.profiles.some((p) => p.name === target.name);
                return found ? { ...config, profiles: config.profiles.filter((p) => p.name !== target.name) } : undefined;
            });
            if (!found) throw new UsageError(`Profile "${target.name}" was already removed.`);
            ctx.stdout.write(`Removed profile ${target.name}. Its file and remote record were not touched.\n`);
            return EXIT.ok;
        }
        case 'rename': {
            if (rest.length !== 2) throw new UsageError('Usage: neon-sync profile rename <old> <new>');
            const [from, to] = [rest[0], rest[1].trim()];
            let problem: string | undefined;
            host.configStore().update((config) => {
                problem = undefined;
                const target = config.profiles.find((p) => p.name === from);
                if (!target) { problem = `No profile named "${from}".`; return undefined; }
                const errors = validateProfileForm(
                    { name: to, filePath: target.filePath, id: target.id, tableName: target.tableName },
                    { existingNames: config.profiles.map((p) => p.name), originalName: from }
                );
                if (errors.name) { problem = errors.name; return undefined; }
                return { ...config, profiles: config.profiles.map((p) => (p.name === from ? { ...p, name: to } : p)) };
            });
            if (problem) throw new UsageError(problem);
            ctx.stdout.write(`Renamed ${from} to ${to}. (Sync history isn't tied to names, so nothing else changes.)\n`);
            return EXIT.ok;
        }
        default:
            throw new UsageError('Usage: neon-sync profile list | show <name> | add | remove <name> | rename <old> <new>');
    }
}

async function addProfile(
    ctx: CliContext,
    host: Host,
    args: string[],
    opts: ProfileFlags,
    interactive: boolean,
    ui: Ui
): Promise<ExitCode> {
    if (args.length > 1) throw new UsageError('Usage: neon-sync profile add [name] --file <path> --id <record id> [--table <name>] [--exclude <key>]…');
    let name = args[0];
    let file = opts.file;
    let id = opts.id;
    let table = opts.table;
    if (interactive) {
        const ask = async (message: string, initial?: string, placeholder?: string) => {
            const v = await ctx.prompts.text(message, { initial, placeholder, validate: (x) => (x.trim() ? undefined : 'Required') });
            if (v === undefined) throw new Cancelled();
            return v.trim();
        };
        try {
            name ??= await ask('Profile name', undefined, 'vscode-settings');
            file ??= await ask('Local file', undefined, '~/Library/Application Support/Code/User/settings.json');
            id ??= await ask('Record id in the table', name);
            table ??= await ask('Table', DEFAULT_TABLE);
        } catch (e) {
            if (e instanceof Cancelled) return EXIT.pending;
            throw e;
        }
    }
    const missing = [!name && 'a name', !file && '--file', !id && '--id'].filter(Boolean);
    if (missing.length > 0) throw new UsageError(`profile add needs ${missing.join(', ')}.`);

    // A path typed on the command line is relative to the current directory;
    // store it in the portable ~/… (or absolute) form.
    const expanded = expandHome(file!.trim(), ctx.pathEnv);
    const absolute = path.isAbsolute(expanded) ? expanded : path.resolve(ctx.cwd, expanded);
    const profile: Profile = normalizeProfileForWrite({
        name: name!.trim(),
        filePath: abbreviateHome(absolute, ctx.pathEnv),
        id: id!.trim(),
        tableName: (table ?? DEFAULT_TABLE).trim(),
        excludeKeys: (opts.exclude ?? []).map((k) => k.trim()).filter(Boolean)
    });

    let problem: string | undefined;
    host.configStore().update((config) => {
        problem = undefined;
        const errors = validateProfileForm(profile, { existingNames: config.profiles.map((p) => p.name) });
        if (hasErrors(errors)) {
            problem = Object.values(errors).filter(Boolean).join(' ');
            return undefined;
        }
        const key = samePathKey(absolute);
        const clash = config.profiles.find((p) => {
            const other = host.resolve(p.filePath);
            return other !== undefined && samePathKey(other) === key;
        });
        if (clash) {
            problem = `Profile "${clash.name}" already uses ${profile.filePath}; each profile needs its own file.`;
            return undefined;
        }
        return { ...config, profiles: [...config.profiles, profile] };
    });
    if (problem) throw new UsageError(problem);
    ctx.stdout.write(`${ui.style.green(ui.sym.inSync)} Added ${profile.name}: ${profile.filePath} ⇄ ${profile.tableName}/${profile.id}\n`);
    ctx.stdout.write(ui.style.dim(`  Next: \`neon-sync status ${profile.name}\`\n`));
    return EXIT.ok;
}

class Cancelled extends Error {}
