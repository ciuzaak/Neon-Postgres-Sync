import { parseArgs } from 'util';
import { ConfigLockedError } from '../../src/core/configFile';
import { applyCommand, type ApplyMode } from './commands/apply';
import { configCommand } from './commands/config';
import { diffCommand } from './commands/diff';
import { profileCommand } from './commands/profile';
import { statusCommand, type Ui } from './commands/status';
import { CliContext, EXIT, ExitCode, UsageError } from './context';
import { Host } from './host';
import { KeychainUnavailableError, redactSecrets } from './secrets';
import { ASCII, asciiByDefault, colorEnabled, makeStyle, UNICODE } from './ui/format';

declare const __NEON_SYNC_VERSION__: string | undefined;
export const VERSION = typeof __NEON_SYNC_VERSION__ === 'string' ? __NEON_SYNC_VERSION__ : '0.0.0-dev';

export const HELP = `neon-sync — sync local config files with a Neon Postgres table

Usage:
  neon-sync                         status of every profile (then offers to apply)
  neon-sync status [names…]         what's out of sync (--json)
  neon-sync sync [names…]           apply what's safe; ask about the rest
      --yes                         don't ask: apply only what's safe, skip the rest
      --prefer local|remote         decide the named profiles' conflicts (needs names)
      --dry-run                     show what would be written
  neon-sync pull <names…|--all>     download (Local ← Remote); --force to overwrite changes
  neon-sync push <names…|--all>     upload (Remote ← Local);   --force to overwrite changes
  neon-sync diff <name>             what would change (--direction upload|download)
  neon-sync profile list | show <name>
  neon-sync config path | set-url | clear-url | test

Options:
  --json            machine-readable output
  --base <dir>      resolve relative profile paths against <dir>
  --config <file>   use another profiles file
  --no-color        plain output (also: NO_COLOR)
  --ascii           ASCII symbols only
  -h, --help        this help
  -v, --version     print the version

Exit codes: 0 in sync / done · 1 pending or needs a decision · 2 usage or
configuration error · 3 apply or runtime failure · 4 rows that can't sync
until fixed. (Precedence: 3 > 4 > 1 > 0.)

Profiles: ~/.config/neon-sync/neon-sync.json (shared with the VS Code
extension). Database URL: NEON_SYNC_DATABASE_URL, else the OS keychain.
`;

const OPTIONS = {
    json: { type: 'boolean' },
    yes: { type: 'boolean', short: 'y' },
    force: { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    all: { type: 'boolean' },
    prefer: { type: 'string' },
    direction: { type: 'string' },
    base: { type: 'string' },
    config: { type: 'string' },
    'no-color': { type: 'boolean' },
    ascii: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' }
} as const;

/** Flags each command accepts (beyond the global ones). */
const COMMAND_FLAGS: Record<string, string[]> = {
    status: ['json'],
    sync: ['json', 'yes', 'prefer', 'dry-run'],
    pull: ['json', 'yes', 'force', 'dry-run', 'all'],
    push: ['json', 'yes', 'force', 'dry-run', 'all'],
    diff: ['direction'],
    profile: ['json'],
    config: []
};
const GLOBAL_FLAGS = ['base', 'config', 'no-color', 'ascii', 'help', 'version'];

/** Run the CLI; returns the exit code (never calls process.exit). */
export async function main(argv: string[], ctx: CliContext): Promise<ExitCode> {
    try {
        let parsed;
        try {
            parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
        } catch (e) {
            const message = (e as Error).message;
            const unknown = /Unknown option '([^']+)'/.exec(message);
            throw new UsageError(`${unknown ? `Unknown option ${unknown[1]}` : message.replace(/\.$/, '')}. See \`neon-sync --help\`.`);
        }
        const { values, positionals } = parsed;
        if (values.version) {
            ctx.stdout.write(`${VERSION}\n`);
            return EXIT.ok;
        }
        if (values.help) {
            ctx.stdout.write(HELP);
            return EXIT.ok;
        }

        const [command = 'status', ...args] = positionals;
        const accepted = COMMAND_FLAGS[command];
        if (!accepted) {
            throw new UsageError(
                `Unknown command "${command}". Profile names go after a command, e.g. \`neon-sync status ${command}\`. See \`neon-sync --help\`.`
            );
        }
        for (const flag of Object.keys(values)) {
            if (!GLOBAL_FLAGS.includes(flag) && !accepted.includes(flag)) {
                throw new UsageError(`\`${command}\` doesn't take --${flag}.`);
            }
        }

        const json = !!values.json;
        const ui: Ui = {
            style: makeStyle(!json && colorEnabled(ctx.stdout.isTTY, ctx.env, !!values['no-color'])),
            sym: values.ascii || asciiByDefault(ctx.pathEnv.platform, ctx.env) ? ASCII : UNICODE
        };
        const host = new Host(ctx, { base: values.base, config: values.config });
        const interactive = ctx.stdinIsTTY && ctx.stdout.isTTY && !json;

        switch (command) {
            case 'status': {
                const code = await statusCommand(ctx, host, args, { json, allowPrefix: interactive }, ui);
                // Bare `neon-sync` in a terminal: offer to go straight on.
                if (positionals.length === 0 && interactive && code === EXIT.pending) {
                    if (await ctx.prompts.confirm('Review and apply now?')) {
                        return await applyCommand(ctx, host, 'sync', [], {
                            yes: false, force: false, dryRun: false, json: false, all: false, interactive: true, allowPrefix: true
                        }, ui);
                    }
                }
                return code;
            }
            case 'sync':
            case 'pull':
            case 'push': {
                const yes = !!values.yes;
                return await applyCommand(ctx, host, command as ApplyMode, args, {
                    yes,
                    force: !!values.force,
                    dryRun: !!values['dry-run'],
                    json,
                    all: !!values.all,
                    prefer: values.prefer,
                    interactive: interactive && !yes && !values['dry-run'],
                    allowPrefix: interactive && !yes
                }, ui);
            }
            case 'diff':
                return await diffCommand(ctx, host, args, { direction: values.direction, allowPrefix: interactive }, ui);
            case 'profile':
                return await profileCommand(ctx, host, args, { json }, ui);
            case 'config':
                return await configCommand(ctx, host, args, ui);
        }
        throw new UsageError(`Unknown command "${command}".`);
    } catch (e) {
        // Never print credentials: drivers quote rejected URLs verbatim.
        const message = redactSecrets(e instanceof Error ? e.message : String(e));
        if (e instanceof UsageError || e instanceof KeychainUnavailableError) {
            ctx.stderr.write(`neon-sync: ${message}\n`);
            return EXIT.usage;
        }
        // A held config lock is temporary ("try again"): a runtime failure, not a config error.
        ctx.stderr.write(`neon-sync: ${e instanceof ConfigLockedError ? '' : 'error: '}${message}\n`);
        return EXIT.failure;
    }
}
