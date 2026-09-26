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
    pathEnv: PathEnv;
    keychain: Keychain;
    createStore(url: string): RecordStore;
    prompts: Prompter;
}

/** Interactive prompts; tests script the answers. */
export interface Prompter {
    password(message: string): Promise<string | undefined>;
    confirm(message: string): Promise<boolean | undefined>;
}

export function defaultContext(): CliContext {
    return {
        stdout: {
            write: (t) => { process.stdout.write(t); },
            isTTY: !!process.stdout.isTTY,
            get columns() { return process.stdout.columns; }
        },
        stderr: { write: (t) => { process.stderr.write(t); }, isTTY: !!process.stderr.isTTY },
        stdinIsTTY: !!process.stdin.isTTY,
        readStdin: async () => {
            const chunks: Buffer[] = [];
            for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
            return Buffer.concat(chunks).toString('utf-8');
        },
        env: process.env,
        pathEnv: currentPathEnv(),
        keychain: new OsKeychain(),
        createStore: (url) => new RecordStore(url),
        prompts: clackPrompter()
    };
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
        }
    };
}
