import * as fs from 'fs';
import { parsePaths } from '../../../src/core/jsoncFilter';
import { normalizeProfileForWrite } from '../../../src/core/configFile';
import { samePathKey } from '../../../src/core/localFile';
import { abbreviateHome } from '../../../src/core/paths';
import { hasErrors, validateProfileForm } from '../../../src/core/profileValidation';
import type { Profile } from '../../../src/core/types';
import { CliContext, EXIT, ExitCode, shellArg, UsageError } from '../context';
import { Host } from '../host';
import { pad, truncateMiddle } from '../ui/format';
import { DEFAULT_TABLE } from './initDb';
import type { Ui } from './status';

export interface ProfileFlags {
    /** Flags actually given, to reject ones this subcommand doesn't use. */
    given: string[];
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
    const allowed: Record<string, string[]> = {
        list: ['json'], show: ['json'], add: ['json', 'file', 'id', 'table', 'exclude'], remove: ['json', 'yes'], rename: ['json']
    };
    for (const flag of opts.given) {
        if (Object.prototype.hasOwnProperty.call(allowed, sub) && !allowed[sub].includes(flag)) throw new UsageError(`\`profile ${sub}\` doesn't take --${flag}.`);
    }
    const done = (human: string, json: Record<string, unknown>) => {
        ctx.stdout.write(opts.json ? JSON.stringify(json, null, 2) + '\n' : human);
        return EXIT.ok;
    };
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
            const pathW = Math.min(48, Math.max(...profiles.map((p) => p.filePath.length)));
            for (const p of profiles) {
                const excluded = p.excludeKeys?.length ? ui.style.dim(`  excludes ${p.excludeKeys.join(', ')}`) : '';
                ctx.stdout.write(
                    `  ${pad(p.name, nameW)}  ${pad(truncateMiddle(p.filePath, pathW, ui.sym.ellipsis), pathW)}  ${ui.style.dim(`${p.tableName}/${p.id}`)}${excluded}\n`
                );
            }
            return EXIT.ok;
        }
        case 'show': {
            if (rest.length !== 1) throw new UsageError('Usage: neon-sync profile show <name>');
            const [p] = host.select(rest, interactive);
            const resolved = host.resolve(p.filePath);
            const blocked = host.blockers([p]).get(p.name);
            if (opts.json) {
                ctx.stdout.write(JSON.stringify({ ...p, resolvedPath: resolved ?? null, blocked: blocked ? `${blocked.label}: ${blocked.detail}` : null }, null, 2) + '\n');
                return blocked ? EXIT.stuck : EXIT.ok;
            }
            const line = (k: string, v: string) => ctx.stdout.write(`  ${pad(k, 13)}${v}\n`);
            line('name', p.name);
            line('file', p.filePath + (resolved && resolved !== p.filePath ? ui.style.dim(`  ${ui.sym.arrowRight} ${resolved}`) : ''));
            line('record', `${p.tableName} / ${p.id}`);
            line('excludeKeys', p.excludeKeys?.length ? p.excludeKeys.join(', ') : ui.style.dim('none'));
            if (blocked) line('status', ui.style.red(`can't sync (${blocked.label}): ${blocked.detail}`));
            return blocked ? EXIT.stuck : EXIT.ok;
        }
        case 'add':
            return addProfile(ctx, host, rest, opts, interactive, ui);
        case 'remove': {
            if (rest.length !== 1) throw new UsageError('Usage: neon-sync profile remove <name> [--yes]');
            const [target] = host.select(rest, false, '`profile remove` needs the exact name'); // this deletes
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
            return done(`Removed profile ${target.name}. Its file and remote record were not touched.\n`, { removed: target.name });
        }
        case 'rename': {
            if (rest.length !== 2) throw new UsageError('Usage: neon-sync profile rename <old> <new>');
            host.profiles(); // refuse to edit a config that can't be used as it is
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
            return done(`Renamed ${from} to ${to}. (Sync history isn't tied to names, so nothing else changes.)\n`, { renamed: { from, to } });
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
    const missing = [!name?.trim() && 'a name', !file?.trim() && '--file', !id?.trim() && '--id'].filter(Boolean);
    if (missing.length > 0) throw new UsageError(`profile add needs ${missing.join(', ')}.`);
    const excludes = (opts.exclude ?? []).map((k) => k.trim()).filter(Boolean);
    const unusable = excludes.filter((k) => parsePaths([k]).length === 0);
    if (unusable.length > 0) {
        throw new UsageError(`Unsupported --exclude ${unusable.map((k) => `"${k}"`).join(', ')}: use dot-separated key names (no wildcards, indexes or empty parts).`);
    }

    // A path typed on the command line is relative to --base or the current
    // directory; store it in the portable ~/… (or absolute) form.
    host.profiles(); // refuse to add to a config that can't be used as it is
    const absolute = host.resolveArgument(file!.trim());
    try {
        if (fs.statSync(absolute).isDirectory()) throw new UsageError(`${abbreviateHome(absolute, ctx.pathEnv)} is a directory; --file must name a file.`);
    } catch (e) {
        if (e instanceof UsageError) throw e; // a missing file is fine: it will be downloaded
    }
    const profile: Profile = normalizeProfileForWrite({
        name: name!.trim(),
        filePath: abbreviateHome(absolute, ctx.pathEnv),
        id: id!.trim(),
        tableName: (table ?? DEFAULT_TABLE).trim(),
        excludeKeys: excludes
    });

    let problem: string | undefined;
    host.configStore().update((config) => {
        problem = undefined;
        const errors = validateProfileForm(profile, { existingNames: config.profiles.map((p) => p.name) });
        if (hasErrors(errors)) {
            const flag: Record<string, string> = { name: 'name', filePath: '--file', id: '--id', tableName: '--table' };
            problem = Object.entries(errors).filter(([, v]) => v).map(([k, v]) => `${flag[k] ?? k}: ${v}`).join(' ');
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
        // Same rule as the engine's batch check: two profiles on one record can't sync together.
        const recordKey = (p: Profile) => `${p.tableName.toLowerCase().split('.').pop()}\u0000${p.id}`;
        const sameRecord = config.profiles.find((p) => recordKey(p) === recordKey(profile));
        if (sameRecord) {
            problem = `Profile "${sameRecord.name}" already syncs record ${profile.tableName}/${profile.id}; each profile needs its own record.`;
            return undefined;
        }
        return { ...config, profiles: [...config.profiles, profile] };
    });
    if (problem) throw new UsageError(problem);
    if (opts.json) {
        ctx.stdout.write(JSON.stringify({ added: profile }, null, 2) + '\n');
        return EXIT.ok;
    }
    ctx.stdout.write(`${ui.style.green(ui.sym.inSync)} Added ${profile.name}: ${profile.filePath} ${ui.sym.both} ${profile.tableName}/${profile.id}\n`);
    ctx.stdout.write(ui.style.dim(`  Next: \`neon-sync status ${shellArg(profile.name, ctx.pathEnv.platform)}\`\n`));
    return EXIT.ok;
}

class Cancelled extends Error {}
