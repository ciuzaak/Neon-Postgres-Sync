import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { installModuleMocks, purgeProjectModules, resetMocks } from '../helpers/moduleMocks';
import { createPgliteSql } from '../helpers/pgliteSql';
import type { Profile } from '../../src/core/types';
import type { CliContext, Prompter } from '../../cli/src/context';
import type { Keychain } from '../../cli/src/secrets';

installModuleMocks();

export interface RunResult {
    code: number;
    stdout: string;
    stderr: string;
}

export interface CliFixture {
    home: string;
    /** Where the CLI reads profiles on this platform (the harness passes no APPDATA/LOCALAPPDATA). */
    configPath: string;
    /** The machine-local sync-state directory on this platform. */
    stateDir: string;
    pg: Awaited<ReturnType<typeof createPgliteSql>>;
    keychain: Keychain & { value?: string };
    run(argv: string[], opts?: { stdin?: string; tty?: boolean; env?: Record<string, string>; prompts?: Partial<Prompter>; columns?: number;
        editor?: (command: string, args: string[]) => Promise<number>; now?: () => number;
        /** Pretend to run on another platform (paths still resolve on this one). */
        platform?: NodeJS.Platform; platformEnv?: Record<string, string> }): Promise<RunResult>;
    file(p: string): string;
    writeFile(p: string, content: string, mtime?: Date): void;
    remote(id: string): Promise<string | undefined>;
    setRemote(id: string, data: string, updateTime?: Date): Promise<void>;
}

export const OLD = new Date('2026-01-01T00:00:00Z');
export const NEW = new Date('2026-01-02T00:00:00Z');

/**
 * A throwaway home with a shared config, a PGlite database behind the
 * mocked Neon driver, an in-memory keychain, and captured output.
 */
export async function cliFixture(opts: {
    profiles?: Profile[];
    url?: string | null;
    configRaw?: string;
} = {}): Promise<CliFixture> {
    const { neon } = resetMocks();
    purgeProjectModules();
    const { main } = require('../../cli/src/main') as typeof import('../../cli/src/main');
    const { MemoryKeychain } = require('../../cli/src/secrets') as typeof import('../../cli/src/secrets');
    const { RecordStore } = require('../../src/core/db') as typeof import('../../src/core/db');

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'neon-sync-cli-home-'));
    const { configDir, stateDir } = require('../../src/core/paths') as typeof import('../../src/core/paths');
    const pathEnv = { platform: process.platform, home, env: {} };
    const configPath = path.join(configDir(pathEnv), 'neon-sync.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    if (opts.configRaw !== undefined) fs.writeFileSync(configPath, opts.configRaw);
    else if (opts.profiles) fs.writeFileSync(configPath, JSON.stringify({ profiles: opts.profiles }, null, 2));

    const pg = await createPgliteSql();
    const keychain = new MemoryKeychain(opts.url === null ? undefined : opts.url ?? 'postgres://user:pw@db.example.test/neondb');
    const resolve = (p: string) => path.isAbsolute(p) ? p : path.join(home, p.replace(/^~\//, ''));

    return {
        home,
        configPath,
        stateDir: path.join(stateDir(pathEnv), 'sync-state'),
        pg,
        keychain,
        async run(argv, runOpts = {}) {
            let stdout = '';
            let stderr = '';
            const tty = runOpts.tty ?? false;
            const ctx: CliContext = {
                stdout: { write: (t) => { stdout += t; }, isTTY: tty, columns: runOpts.columns ?? 120 },
                stderr: { write: (t) => { stderr += t; }, isTTY: tty },
                stdinIsTTY: tty,
                readStdin: async () => runOpts.stdin ?? '',
                // A modern Windows terminal (Windows Terminal sets WT_SESSION), so
                // every platform gets the Unicode symbols the assertions expect.
                env: { WT_SESSION: 'test', ...(runOpts.env ?? {}) },
                cwd: home,
                pathEnv: { platform: runOpts.platform ?? process.platform, home, env: runOpts.platformEnv ?? {} },
                keychain,
                createStore: (url) => {
                    neon.nextSql = pg.sql;
                    return new RecordStore(url);
                },
                prompts: {
                    password: async () => undefined,
                    confirm: async () => undefined,
                    select: async () => undefined,
                    multiselect: async () => undefined,
                    text: async () => undefined,
                    ...runOpts.prompts
                } as Prompter,
                page: () => false,
                runEditor: runOpts.editor ?? (async () => { throw new Error('no editor in tests'); }),
                now: runOpts.now ?? (() => Date.now())
            };
            const code = await main(argv, ctx);
            return { code, stdout, stderr };
        },
        file: (p) => fs.readFileSync(resolve(p), 'utf-8'),
        writeFile(p, content, mtime) {
            const abs = resolve(p);
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, content);
            if (mtime) fs.utimesSync(abs, mtime, mtime);
        },
        async remote(id) {
            return (await pg.db.query<{ data: string }>('SELECT data FROM records WHERE id = $1', [id])).rows[0]?.data;
        },
        async setRemote(id, data, updateTime = OLD) {
            await pg.db.query(
                `INSERT INTO records (id, data, create_time, update_time) VALUES ($1, $2, $3, $3)
                 ON CONFLICT (id) DO UPDATE SET data = $2, update_time = $3`,
                [id, data, updateTime.toISOString()]
            );
        }
    };
}

export const profile = (name: string, overrides: Partial<Profile> = {}): Profile =>
    ({ name, filePath: `~/${name}.json`, id: `${name}-id`, tableName: 'records', ...overrides });
