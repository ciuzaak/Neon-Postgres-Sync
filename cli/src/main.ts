import { parseArgs } from 'util';
import { ConfigLockedError } from '../../src/core/configFile';
import { configCommand } from './commands/config';
import { profileCommand } from './commands/profile';
import { statusCommand, type Ui } from './commands/status';
import { CliContext, EXIT, ExitCode, UsageError } from './context';
import { Host } from './host';
import { KeychainUnavailableError } from './secrets';
import { ASCII, asciiByDefault, colorEnabled, makeStyle, UNICODE } from './ui/format';

declare const __NEON_SYNC_VERSION__: string | undefined;
export const VERSION = typeof __NEON_SYNC_VERSION__ === 'string' ? __NEON_SYNC_VERSION__ : '0.0.0-dev';

export const HELP = `neon-sync — sync local config files with a Neon Postgres table

Usage:
  neon-sync                         status of every profile
  neon-sync status [names…]         what's out of sync (--json)
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
            throw new UsageError(`Unknown command "${command}". See \`neon-sync --help\`.`);
        }
        if (positionals.length === 0 && args.length > 0) {
            throw new UsageError('Profile names go after a command, e.g. `neon-sync status <names…>`.');
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
            case 'status':
                return await statusCommand(ctx, host, args, { json, allowPrefix: interactive }, ui);
            case 'profile':
                return await profileCommand(ctx, host, args, { json }, ui);
            case 'config':
                return await configCommand(ctx, host, args, ui);
        }
        throw new UsageError(`Unknown command "${command}".`);
    } catch (e) {
        if (e instanceof UsageError || e instanceof KeychainUnavailableError || e instanceof ConfigLockedError) {
            ctx.stderr.write(`neon-sync: ${e.message}\n`);
            return EXIT.usage;
        }
        ctx.stderr.write(`neon-sync: error: ${e instanceof Error ? e.message : String(e)}\n`);
        return EXIT.failure;
    }
}
