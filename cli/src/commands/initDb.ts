import { PROFILE_TABLENAME_RE } from '../../../src/core/profileValidation';
import { CliContext, EXIT, ExitCode, UsageError } from '../context';
import { Host } from '../host';
import { describeUrl } from '../secrets';
import type { Ui } from './status';

export const DEFAULT_TABLE = 'json_records';

export async function initDbCommand(ctx: CliContext, host: Host, args: string[], opts: { table?: string }, ui: Ui): Promise<ExitCode> {
    if (args.length > 0) throw new UsageError('Usage: neon-sync init-db [--table <name>]');
    const table = (opts.table ?? DEFAULT_TABLE).trim();
    if (!PROFILE_TABLENAME_RE.test(table)) {
        throw new UsageError(`Invalid table name "${table}": letters, digits and underscores, optionally schema.table.`);
    }
    const { url } = await host.connection();
    const { created, problem } = await ctx.createStore(url).createTable(table);
    if (problem) {
        throw new UsageError(`${table} already exists in ${describeUrl(url)} but can't be used for syncing: ${problem}. Pick another --table, or fix it.`);
    }
    ctx.stdout.write(created
        ? `${ui.style.green(ui.sym.inSync)} Created table ${table} in ${describeUrl(url)}.\n`
        : `Table ${table} already exists in ${describeUrl(url)}; nothing changed.\n`);
    return EXIT.ok;
}
