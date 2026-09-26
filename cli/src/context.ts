import { RecordStore } from '../../src/core/db';
import { currentPathEnv, PathEnv } from '../../src/core/paths';
import { Keychain, OsKeychain } from './secrets';

/** Exit codes (spec: "Exit codes"). Precedence when several apply: 3 > 4 > 1 > 0. */
export const EXIT = {
    ok: 0,
    pending: 1,
    usage: 2,
    failure: 3,
    stuck: 4
} as const;
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

const PRECEDENCE: ExitCode[] = [EXIT.failure, EXIT.stuck, EXIT.pending, EXIT.ok];

/** The highest-priority code among `codes` (usage errors never get here: they stop first). */
export function worstExit(...codes: ExitCode[]): ExitCode {
    for (const c of PRECEDENCE) if (codes.includes(c)) return c;
    return EXIT.ok;
}

/** Thrown for bad arguments or configuration: printed without a stack, exit 2. */
export class UsageError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'UsageError';
    }
}

export interface Output {
    write(text: string): void;
    isTTY: boolean;
    columns?: number;
    rows?: number;
}

/**
 * Everything the CLI touches outside itself, so commands are testable
 * without a terminal, a keychain or a real database.
 */
export interface CliContext {
    stdout: Output;
    stderr: Output;
    /** stdin is interactive (prompts allowed). */
    stdinIsTTY: boolean;
    readStdin(): Promise<string>;
    env: Record<string, string | undefined>;
    /** Working directory: relative paths typed on the command line resolve against it. */
    cwd: string;
    pathEnv: PathEnv;
    keychain: Keychain;
    createStore(url: string): RecordStore;
    prompts: Prompter;
    /** Show long text through a pager; returns false if none could run (caller prints it). */
    page(text: string): boolean;
    /** Run an editor command and wait for it; resolves with its exit code. */
    runEditor(command: string, args: string[]): Promise<number>;
    /** Wall clock, injectable so tests can simulate an editor that returns instantly. */
    now(): number;
}

export interface Choice<T extends string> {
    value: T;
    label: string;
    hint?: string;
}

/** Interactive prompts; tests script the answers. `undefined` = cancelled. */
export interface Prompter {
    password(message: string): Promise<string | undefined>;
    confirm(message: string): Promise<boolean | undefined>;
    select<T extends string>(message: string, choices: Choice<T>[]): Promise<T | undefined>;
    text(message: string, opts?: { initial?: string; placeholder?: string; validate?: (value: string) => string | undefined }): Promise<string | undefined>;
    multiselect<T extends string>(message: string, choices: Choice<T>[], initial: T[]): Promise<T[] | undefined>;
}

export function defaultContext(): CliContext {
    return {
        stdout: {
            write: (t) => { process.stdout.write(t); },
            isTTY: !!process.stdout.isTTY,
            get columns() { return process.stdout.columns; },
            get rows() { return process.stdout.rows; }
        },
        stderr: { write: (t) => { process.stderr.write(t); }, isTTY: !!process.stderr.isTTY },
        stdinIsTTY: !!process.stdin.isTTY,
        readStdin: async () => {
            const chunks: Buffer[] = [];
            for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
            return Buffer.concat(chunks).toString('utf-8');
        },
        env: process.env,
        cwd: process.cwd(),
        pathEnv: currentPathEnv(),
        keychain: new OsKeychain(),
        createStore: (url) => new RecordStore(url),
        prompts: clackPrompter(),
        page: (text) => runPager(text, process.env),
        runEditor: (command, args) => new Promise((resolve, reject) => {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { spawn } = require('child_process') as typeof import('child_process');
            // Windows editors are often .cmd shims (code.cmd), which need a shell.
            const child = spawn(command, args, { stdio: 'inherit', shell: process.platform === 'win32' });
            child.on('error', reject);
            child.on('exit', (code) => resolve(code ?? 1));
        }),
        now: () => Date.now()
    };
}

/** $PAGER (default `less -R`; none on Windows unless $PAGER is set). */
function runPager(text: string, env: NodeJS.ProcessEnv): boolean {
    const pager = env.PAGER || (process.platform === 'win32' ? undefined : 'less -R');
    if (!pager) return false;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { spawnSync } = require('child_process') as typeof import('child_process');
    const result = spawnSync(pager, { input: text, stdio: ['pipe', 'inherit', 'inherit'], shell: true });
    return result.status === 0;
}

function clackPrompter(): Prompter {
    // Loaded on first use: most commands never prompt.
    const clack = () => require('@clack/prompts') as typeof import('@clack/prompts');
    return {
        async password(message) {
            const value = await clack().password({ message });
            return clack().isCancel(value) ? undefined : value;
        },
        async confirm(message) {
            const value = await clack().confirm({ message });
            return clack().isCancel(value) ? undefined : value;
        },
        async text(message, opts = {}) {
            const value = await clack().text({
                message,
                initialValue: opts.initial,
                placeholder: opts.placeholder,
                validate: opts.validate ? (v) => opts.validate!(v ?? '') : undefined
            });
            return clack().isCancel(value) ? undefined : value;
        },
        async select(message, choices) {
            const options = choices.map((c) => ({ value: c.value, label: c.label, hint: c.hint }));
            const value = await clack().select({ message, options: options as never });
            return clack().isCancel(value) ? undefined : value as typeof choices[number]['value'];
        },
        async multiselect(message, choices, initial) {
            const value = await clack().multiselect({
                message,
                options: choices.map((c) => ({ value: c.value, label: c.label, hint: c.hint })) as never,
                initialValues: initial as never,
                required: false
            });
            return clack().isCancel(value) ? undefined : value as typeof initial;
        }
    };
}
