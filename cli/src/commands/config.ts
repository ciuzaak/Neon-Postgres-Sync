import { CliContext, EXIT, ExitCode, UsageError } from '../context';
import { Host } from '../host';
import { describeUrl, looksLikePostgresUrl, URL_ENV } from '../secrets';
import type { Ui } from './status';

export async function configCommand(ctx: CliContext, host: Host, args: string[], ui: Ui): Promise<ExitCode> {
    const [sub, ...rest] = args;
    const envOverride = !!ctx.env[URL_ENV]?.trim();
    switch (sub) {
        case 'path': {
            ctx.stdout.write(`config  ${host.configPath()}\nstate   ${host.stateDir()}\n`);
            return EXIT.ok;
        }
        case 'set-url': {
            if (rest.length > 0) {
                throw new UsageError(
                    "Don't pass the URL as an argument (it would be saved in your shell history). " +
                    'Run `neon-sync config set-url` and paste it, or pipe it in.'
                );
            }
            let url: string | undefined;
            if (ctx.stdinIsTTY) {
                url = await ctx.prompts.password('Database URL (postgres://…)');
                if (url === undefined) return EXIT.pending; // cancelled
            } else {
                url = (await ctx.readStdin()).split(/\r?\n/)[0];
            }
            url = url.trim();
            if (!looksLikePostgresUrl(url)) {
                throw new UsageError('That doesn\'t look like a postgres:// or postgresql:// URL.');
            }
            await ctx.keychain.set(url);
            ctx.stdout.write(`${ui.style.green(ui.sym.inSync)} Saved the URL for ${describeUrl(url)} in the OS keychain.\n`);
            if (envOverride) {
                ctx.stdout.write(ui.style.yellow(`  Note: ${URL_ENV} is set and takes precedence.\n`));
            }
            return EXIT.ok;
        }
        case 'clear-url': {
            const removed = await ctx.keychain.clear();
            ctx.stdout.write(removed ? 'Removed the URL from the OS keychain.\n' : 'No URL was stored in the OS keychain.\n');
            if (envOverride) {
                ctx.stdout.write(ui.style.yellow(`  Note: ${URL_ENV} is still set.\n`));
            }
            return EXIT.ok;
        }
        case 'test': {
            const { url, source } = await host.connection();
            await ctx.createStore(url).ping();
            ctx.stdout.write(
                `${ui.style.green(ui.sym.inSync)} Connected to ${describeUrl(url)} ` +
                `${ui.style.dim(`(URL from ${source === 'env' ? URL_ENV : 'the OS keychain'})`)}\n`
            );
            return EXIT.ok;
        }
        default:
            throw new UsageError('Usage: neon-sync config path | set-url | clear-url | test');
    }
}
