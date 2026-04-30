import Module = require('node:module');
import * as path from 'node:path';

type ModuleLoader = (request: string, parent: NodeModule | null, isMain: boolean) => unknown;
const moduleWithLoad = Module as typeof Module & { _load: ModuleLoader };

export interface MockVscode {
    Disposable: new (callback?: () => void) => { dispose: () => void };
    ProgressLocation: { Notification: number };
    ThemeIcon: new (id: string) => { id: string };
    Uri: {
        file: (filePath: string) => { fsPath: string; toString: () => string };
        joinPath: (
            base: { fsPath: string },
            ...segments: string[]
        ) => { fsPath: string; toString: () => string };
    };
    commands: {
        executed: Array<{ command: string; args: unknown[] }>;
        executeCommand: (command: string, ...args: unknown[]) => Promise<undefined>;
        registerCommand: (command: string, callback: (...args: unknown[]) => unknown) => { dispose: () => void };
    };
    window: {
        infoMessages: string[];
        warningMessages: string[];
        errorMessages: string[];
        showInformationMessage: (message: string, ...items: unknown[]) => Promise<unknown>;
        showWarningMessage: (message: string, ...items: unknown[]) => Promise<unknown>;
        showErrorMessage: (message: string, ...items: unknown[]) => Promise<unknown>;
        withProgress: <T>(options: unknown, task: () => Thenable<T> | T) => Promise<T>;
        onDidChangeVisibleTextEditors: (listener: unknown) => { dispose: () => void };
        createWebviewPanel: () => unknown;
        showQuickPick: () => Promise<undefined>;
        createQuickPick: () => unknown;
        showInputBox: () => Promise<undefined>;
        showTextDocument: () => Promise<undefined>;
        activeTextEditor: undefined;
    };
    workspace: {
        workspaceFolders: Array<{ uri: { fsPath: string } }> | undefined;
        textDocuments: unknown[];
        openTextDocument: (input: string | { fsPath: string }) => Promise<unknown>;
    };
    languages: {
        setTextDocumentLanguage: (doc: unknown, languageId: string) => Promise<unknown>;
    };
    ViewColumn: { One: number; Active: number };
}

export interface MockSql {
    queryCalls: Array<{ query: string; params: unknown[] }>;
    transactionCalls: unknown[][];
    queryResults: unknown[];
    transactionResults: unknown[];
    query: (query: string, params: unknown[]) => Promise<unknown>;
    transaction: (queries: unknown[]) => Promise<unknown>;
}

export interface NeonMock {
    calls: string[];
    instances: MockSql[];
    nextSql?: MockSql;
    neon: (connectionString: string) => MockSql;
}

let originalLoad: ModuleLoader | undefined;
let currentVscode = createVscodeMock();
let currentNeon = createNeonMock();

export function installModuleMocks(): void {
    if (originalLoad) return;
    originalLoad = moduleWithLoad._load;
    moduleWithLoad._load = function patchedLoad(
        this: unknown,
        request: string,
        parent: NodeModule | null,
        isMain: boolean
    ): unknown {
        if (request === 'vscode') {
            return currentVscode;
        }
        if (request === '@neondatabase/serverless') {
            return { neon: currentNeon.neon };
        }
        return originalLoad!.apply(this, [request, parent, isMain]);
    };
}

export function resetMocks(): { vscode: MockVscode; neon: NeonMock } {
    currentVscode = createVscodeMock();
    currentNeon = createNeonMock();
    return { vscode: currentVscode, neon: currentNeon };
}

export function createMockSql(): MockSql {
    const sql: MockSql = {
        queryCalls: [],
        transactionCalls: [],
        queryResults: [],
        transactionResults: [],
        async query(query: string, params: unknown[]): Promise<unknown> {
            sql.queryCalls.push({ query, params });
            if (sql.queryResults.length > 0) {
                return sql.queryResults.shift();
            }
            return [];
        },
        async transaction(queries: unknown[]): Promise<unknown> {
            sql.transactionCalls.push(queries);
            if (sql.transactionResults.length > 0) {
                return sql.transactionResults.shift();
            }
            return [];
        }
    };
    return sql;
}

export function purgeProjectModules(): void {
    for (const key of Object.keys(require.cache)) {
        if (key.includes(`${path.sep}out-test${path.sep}src${path.sep}`)) {
            delete require.cache[key];
        }
    }
}

function createNeonMock(): NeonMock {
    const mock: NeonMock = {
        calls: [],
        instances: [],
        neon(connectionString: string): MockSql {
            mock.calls.push(connectionString);
            const sql = mock.nextSql ?? createMockSql();
            mock.nextSql = undefined;
            mock.instances.push(sql);
            return sql;
        }
    };
    return mock;
}

function createVscodeMock(): MockVscode {
    class Disposable {
        constructor(private readonly callback?: () => void) {}

        dispose(): void {
            this.callback?.();
        }
    }

    class ThemeIcon {
        constructor(public readonly id: string) {}
    }

    const makeUri = (filePath: string) => ({
        fsPath: filePath,
        toString: () => `file://${filePath}`
    });

    const vscode: MockVscode = {
        Disposable,
        ProgressLocation: { Notification: 15 },
        ThemeIcon,
        Uri: {
            file: makeUri,
            joinPath: (base, ...segments) => makeUri(path.join(base.fsPath, ...segments))
        },
        commands: {
            executed: [],
            async executeCommand(command: string, ...args: unknown[]): Promise<undefined> {
                vscode.commands.executed.push({ command, args });
                return undefined;
            },
            registerCommand: () => new Disposable()
        },
        window: {
            infoMessages: [],
            warningMessages: [],
            errorMessages: [],
            async showInformationMessage(message: string, ...items: unknown[]): Promise<unknown> {
                vscode.window.infoMessages.push(message);
                return items[0];
            },
            async showWarningMessage(message: string, ...items: unknown[]): Promise<unknown> {
                vscode.window.warningMessages.push(message);
                return items[0];
            },
            async showErrorMessage(message: string, ...items: unknown[]): Promise<unknown> {
                vscode.window.errorMessages.push(message);
                return items[0];
            },
            async withProgress<T>(options: unknown, task: () => Thenable<T> | T): Promise<T> {
                return await task();
            },
            onDidChangeVisibleTextEditors: () => new Disposable(),
            createWebviewPanel: () => {
                throw new Error('createWebviewPanel is not implemented in the test mock.');
            },
            showQuickPick: async () => undefined,
            createQuickPick: () => {
                throw new Error('createQuickPick is not implemented in the test mock.');
            },
            showInputBox: async () => undefined,
            showTextDocument: async () => undefined,
            activeTextEditor: undefined
        },
        workspace: {
            workspaceFolders: undefined,
            textDocuments: [],
            async openTextDocument(input: string | { fsPath: string }): Promise<unknown> {
                const fsPath = typeof input === 'string' ? input : input.fsPath;
                return {
                    uri: makeUri(fsPath),
                    languageId: 'plaintext',
                    isDirty: false,
                    save: async () => true,
                    getText: () => ''
                };
            }
        },
        languages: {
            async setTextDocumentLanguage(doc: unknown): Promise<unknown> {
                return doc;
            }
        },
        ViewColumn: { One: 1, Active: -1 }
    };

    return vscode;
}
