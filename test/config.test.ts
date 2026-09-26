import test = require('node:test');
import assert = require('node:assert/strict');
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { installModuleMocks, purgeProjectModules, resetMocks, testLocations } from './helpers/moduleMocks';
import type { ConfigFile, Profile } from '../src/config';

installModuleMocks();

interface SecretMock {
    values: Map<string, string>;
    get: (key: string) => Promise<string | undefined>;
    store: (key: string, value: string) => Promise<void>;
    delete: (key: string) => Promise<void>;
}

function createSecretMock(): SecretMock {
    const values = new Map<string, string>();
    return {
        values,
        async get(key: string): Promise<string | undefined> {
            return values.get(key);
        },
        async store(key: string, value: string): Promise<void> {
            values.set(key, value);
        },
        async delete(key: string): Promise<void> {
            values.delete(key);
        }
    };
}

function loadConfigModule() {
    purgeProjectModules();
    return require('../src/config') as typeof import('../src/config');
}

function initConfig(storagePath: string, secrets = createSecretMock()) {
    const { vscode } = resetMocks();
    const { ConfigManager } = loadConfigModule();
    ConfigManager.initialize({
        globalStorageUri: vscode.Uri.file(storagePath),
        secrets
    } as never, testLocations(storagePath));
    return { ConfigManager, secrets, vscode };
}

test('initialize creates the global storage directory and returns an empty profile list by default', () => {
    const storagePath = path.join(os.tmpdir(), `neon-sync-config-${Date.now()}-missing`);
    fs.rmSync(storagePath, { recursive: true, force: true });
    const { ConfigManager } = initConfig(storagePath);

    assert.equal(fs.existsSync(storagePath), true);
    assert.deepEqual(ConfigManager.getProfiles(), []);
});

test('saveProfiles persists profiles and getProfile reads them by name', async () => {
    const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'neon-sync-config-'));
    const { ConfigManager } = initConfig(storagePath);
    const profiles: Profile[] = [
        { name: 'alpha', filePath: 'alpha.json', id: '1', tableName: 'records' },
        { name: 'beta', filePath: 'beta.json', id: '2', tableName: 'public.records' }
    ];

    await ConfigManager.saveProfiles(profiles);

    assert.deepEqual(ConfigManager.getProfiles(), profiles);
    assert.deepEqual(ConfigManager.getProfile('beta'), profiles[1]);
    assert.equal(ConfigManager.getProfile('missing'), undefined);
});

test('getConnectionString migrates a legacy file value into SecretStorage and removes it from config', async () => {
    const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'neon-sync-config-'));
    const configPath = path.join(storagePath, 'neon-sync.json');
    const legacyConfig: ConfigFile = {
        connectionString: 'postgres://legacy',
        profiles: [{ name: 'alpha', filePath: 'alpha.json', id: '1', tableName: 'records' }]
    };
    fs.writeFileSync(configPath, JSON.stringify(legacyConfig, null, 2));
    const { ConfigManager, secrets, vscode } = initConfig(storagePath);

    const connectionString = await ConfigManager.getConnectionString();
    const rewritten = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as ConfigFile;

    assert.equal(connectionString, 'postgres://legacy');
    assert.equal(secrets.values.get('neonSync.connectionString'), 'postgres://legacy');
    assert.equal(rewritten.connectionString, undefined);
    assert.deepEqual(rewritten.profiles, legacyConfig.profiles);
    assert.deepEqual(vscode.window.infoMessages, ['Migrated connection string to secure storage.']);
});

test('setConnectionString stores the value in SecretStorage and notifies listeners', async () => {
    const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'neon-sync-config-'));
    const { ConfigManager, secrets } = initConfig(storagePath);
    let notificationCount = 0;
    const disposable = ConfigManager.onConnectionStringChanged(() => {
        notificationCount += 1;
    });

    await ConfigManager.setConnectionString('postgres://new');
    disposable.dispose();
    await ConfigManager.setConnectionString('postgres://newer');

    assert.equal(secrets.values.get('neonSync.connectionString'), 'postgres://newer');
    assert.equal(notificationCount, 1);
});

test('saveProfiles writes atomically via a sibling temp file', async () => {
    const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'neon-sync-config-'));
    const { ConfigManager } = initConfig(storagePath);
    const profiles: Profile[] = [
        { name: 'a', filePath: 'a.json', id: '1', tableName: 'records' }
    ];

    await ConfigManager.saveProfiles(profiles);

    const configPath = path.join(storagePath, 'neon-sync.json');
    assert.equal(fs.existsSync(configPath), true);
    // No leftover temp files in the storage directory.
    const leftovers = fs.readdirSync(storagePath).filter((name) => name.endsWith('.tmp'));
    assert.deepEqual(leftovers, []);
    const persisted = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as ConfigFile;
    assert.deepEqual(persisted.profiles, profiles);
});

test('promptMissingConnectionString shows an error toast with an Open Settings button', async () => {
    const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'neon-sync-config-'));
    const { ConfigManager, vscode } = initConfig(storagePath);

    await ConfigManager.promptMissingConnectionString();

    assert.deepEqual(vscode.window.errorMessages, [
        'PostgreSQL connection string is not configured.'
    ]);
    assert.deepEqual(
        vscode.commands.executed,
        [{ command: 'neonSync.openSettings', args: [{ focus: 'connection' }] }]
    );
});

test('promptMissingConnectionString does not open settings when the user dismisses the toast', async () => {
    const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'neon-sync-config-'));
    const { ConfigManager, vscode } = initConfig(storagePath);
    vscode.window.showErrorMessage = async (message: string) => {
        vscode.window.errorMessages.push(message);
        return undefined;
    };

    await ConfigManager.promptMissingConnectionString();

    assert.deepEqual(vscode.commands.executed, []);
});

test('clearConnectionString deletes the secret, removes any legacy file value, and notifies listeners', async () => {
    const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'neon-sync-config-'));
    const configPath = path.join(storagePath, 'neon-sync.json');
    fs.writeFileSync(
        configPath,
        JSON.stringify({ connectionString: 'postgres://legacy', profiles: [] }, null, 2)
    );
    const secrets = createSecretMock();
    secrets.values.set('neonSync.connectionString', 'postgres://stored');
    const { ConfigManager } = initConfig(storagePath, secrets);
    let notifications = 0;
    ConfigManager.onConnectionStringChanged(() => { notifications += 1; });

    await ConfigManager.clearConnectionString();

    assert.equal(secrets.values.has('neonSync.connectionString'), false);
    const rewritten = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as ConfigFile;
    assert.equal(rewritten.connectionString, undefined);
    assert.equal(notifications, 1);
    assert.equal(await ConfigManager.getConnectionString(), undefined);
});

test('saveProfiles drops empty/missing excludeKeys when writing the config file', async () => {
    const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'neon-sync-config-'));
    const { ConfigManager } = initConfig(storagePath);

    await ConfigManager.saveProfiles([
        { name: 'A', filePath: 'a.json', id: 'a1', tableName: 'json_records' },
        { name: 'B', filePath: 'b.json', id: 'b1', tableName: 'json_records', excludeKeys: [] },
        { name: 'C', filePath: 'c.json', id: 'c1', tableName: 'json_records', excludeKeys: ['x.y'] }
    ]);

    const written = JSON.parse(
        fs.readFileSync(path.join(storagePath, 'neon-sync.json'), 'utf-8')
    ) as ConfigFile;

    assert.equal(Object.prototype.hasOwnProperty.call(written.profiles[0], 'excludeKeys'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(written.profiles[1], 'excludeKeys'), false);
    assert.deepEqual(written.profiles[2].excludeKeys, ['x.y']);
});

test('an unreadable config file surfaces a toast and yields no profiles instead of throwing', () => {
    const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'neon-sync-config-'));
    fs.mkdirSync(path.join(storagePath, 'neon-sync.json'));
    const { ConfigManager, vscode } = initConfig(storagePath);

    assert.deepEqual(ConfigManager.getProfiles(), []);
    assert.equal(vscode.window.errorMessages.length, 1);
    assert.match(vscode.window.errorMessages[0], /^Failed to parse neon-sync\.json: .*EISDIR/);
});

test('a corrupt config file surfaces a toast and is never overwritten (a typo must not wipe every profile)', async () => {
    const storagePath = fs.mkdtempSync(path.join(os.tmpdir(), 'neon-sync-config-'));
    const configPath = path.join(storagePath, 'neon-sync.json');
    fs.writeFileSync(configPath, '{ not json');
    const { ConfigManager, vscode } = initConfig(storagePath);
    const profiles: Profile[] = [{ name: 'a', filePath: 'a.json', id: '1', tableName: 'records' }];

    assert.deepEqual(ConfigManager.getProfiles(), []);
    await ConfigManager.saveProfiles(profiles);

    assert.match(vscode.window.errorMessages.at(-1)!, /^Couldn't save profiles: Failed to parse neon-sync\.json: /);
    assert.equal(fs.readFileSync(configPath, 'utf-8'), '{ not json');
});

// ── migration to the shared config (spec 2026-09-26, Part 1) ─────────

function setupMigration(legacy: unknown, shared?: unknown, secrets = createSecretMock()) {
    const { vscode } = resetMocks();
    const { ConfigManager } = loadConfigModule();
    const globalStorage = fs.mkdtempSync(path.join(os.tmpdir(), 'neon-sync-legacy-'));
    const sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neon-sync-shared-'));
    const legacyPath = path.join(globalStorage, 'neon-sync.json');
    const sharedPath = path.join(sharedDir, 'neon-sync.json');
    if (legacy !== undefined) fs.writeFileSync(legacyPath, typeof legacy === 'string' ? legacy : JSON.stringify(legacy));
    if (shared !== undefined) fs.writeFileSync(sharedPath, typeof shared === 'string' ? shared : JSON.stringify(shared));
    ConfigManager.initialize({ globalStorageUri: vscode.Uri.file(globalStorage), secrets } as never, {
        configDir: sharedDir,
        stateDir: path.join(sharedDir, '.state')
    });
    const readShared = () => JSON.parse(fs.readFileSync(sharedPath, 'utf-8')) as ConfigFile;
    return { ConfigManager, vscode, secrets, legacyPath, sharedPath, readShared };
}

const P = (name: string, filePath = `~/${name}.json`, extra: Partial<Profile> = {}): Profile =>
    ({ name, filePath, id: `${name}-id`, tableName: 'records', ...extra });

test('migration copies this editor\'s profiles into a missing shared file and leaves a marker and the backup', async () => {
    const legacy = { profiles: [P('a'), P('b')] };
    const { ConfigManager, vscode, legacyPath, readShared } = setupMigration(legacy);

    const report = await ConfigManager.migrateLegacyConfig();

    assert.deepEqual(report?.added, ['a', 'b']);
    assert.deepEqual(readShared().profiles.map((p) => p.name), ['a', 'b']);
    assert.ok(fs.existsSync(`${legacyPath}.migrated`));
    assert.deepEqual(JSON.parse(fs.readFileSync(legacyPath, 'utf-8')), legacy, 'backup untouched');
    assert.match(vscode.window.infoMessages.at(-1)!, /now keeps profiles in .*neon-sync\.json.*Added from this editor: a, b\./);
    assert.deepEqual(ConfigManager.getProfiles().map((p) => p.name), ['a', 'b']);
});

test('migration runs once: profiles deleted from the shared file later are not resurrected', async () => {
    const { ConfigManager, readShared } = setupMigration({ profiles: [P('a'), P('b')] });
    await ConfigManager.migrateLegacyConfig();
    await ConfigManager.saveProfiles([P('a')]);

    assert.equal(await ConfigManager.migrateLegacyConfig(), undefined);
    assert.deepEqual(readShared().profiles.map((p) => p.name), ['a']);
});

test('migration merges by name: keeps the shared version on conflicts and skips profiles for the same file', async () => {
    const shared = { profiles: [P('same'), P('differs', '~/one.json'), P('existing', '~/shared-file.json')] };
    const legacy = { profiles: [P('same'), P('differs', '~/two.json'), P('alias', '~/shared-file.json'), P('fresh')] };
    const { ConfigManager, vscode, readShared } = setupMigration(legacy, shared);

    const report = await ConfigManager.migrateLegacyConfig();

    assert.deepEqual(report, { added: ['fresh'], keptShared: ['differs'], skippedSameFile: ['alias'], skippedInvalid: [] });
    assert.deepEqual(readShared().profiles.map((p) => [p.name, p.filePath]), [
        ['same', '~/same.json'], ['differs', '~/one.json'], ['existing', '~/shared-file.json'], ['fresh', '~/fresh.json']
    ]);
    const note = vscode.window.infoMessages.at(-1)!;
    assert.match(note, /Kept the shared version of: differs\./);
    assert.match(note, /Skipped \(same file as an existing profile\): alias\./);
});

test('a corrupt shared file aborts migration without a marker; this editor keeps its own list meanwhile', async () => {
    const { ConfigManager, vscode, legacyPath, sharedPath } = setupMigration({ profiles: [P('a')] }, '{ broken');

    assert.equal(await ConfigManager.migrateLegacyConfig(), undefined);

    assert.equal(fs.existsSync(`${legacyPath}.migrated`), false);
    assert.equal(fs.readFileSync(sharedPath, 'utf-8'), '{ broken');
    assert.match(vscode.window.errorMessages.at(-1)!, /couldn't move profiles to the shared config .*this editor shows its own profile list \(read-only\)/);
    assert.deepEqual(ConfigManager.getProfiles().map((p) => p.name), ['a']);
});

test('migration moves a legacy plaintext URL into SecretStorage and never copies it', async () => {
    const { ConfigManager, secrets, legacyPath, readShared } = setupMigration({
        connectionString: 'postgres://legacy-secret',
        profiles: [P('a')]
    });

    await ConfigManager.migrateLegacyConfig();

    assert.equal(secrets.values.get('neonSync.connectionString'), 'postgres://legacy-secret');
    assert.equal(fs.readFileSync(legacyPath, 'utf-8').includes('legacy-secret'), false, 'stripped from the backup');
    assert.equal(JSON.stringify(readShared()).includes('legacy-secret'), false, 'never in the shared file');
});

test('migration keeps an existing SecretStorage URL over a legacy one', async () => {
    const secrets = createSecretMock();
    secrets.values.set('neonSync.connectionString', 'postgres://current');
    const { ConfigManager, legacyPath } = setupMigration({ connectionString: 'postgres://old', profiles: [] }, undefined, secrets);

    await ConfigManager.migrateLegacyConfig();

    assert.equal(secrets.values.get('neonSync.connectionString'), 'postgres://current');
    assert.equal(fs.readFileSync(legacyPath, 'utf-8').includes('postgres://old'), false);
});

test('a corrupt legacy file is reported and left for a later retry', async () => {
    const { ConfigManager, vscode, legacyPath, sharedPath } = setupMigration('{ nope');

    assert.equal(await ConfigManager.migrateLegacyConfig(), undefined);

    assert.equal(fs.existsSync(`${legacyPath}.migrated`), false);
    assert.equal(fs.existsSync(sharedPath), false);
    assert.match(vscode.window.errorMessages.at(-1)!, /couldn't migrate this editor's profiles/);
});

test('without a legacy file there is nothing to migrate', async () => {
    const { ConfigManager, sharedPath } = setupMigration(undefined);
    assert.equal(await ConfigManager.migrateLegacyConfig(), undefined);
    assert.equal(fs.existsSync(sharedPath), false);
});

test('while migration is blocked by a corrupt shared file, profile edits are refused (they would be lost later)', async () => {
    const { ConfigManager, vscode, legacyPath } = setupMigration({ profiles: [P('a')] }, '{ broken');
    await ConfigManager.migrateLegacyConfig();

    assert.equal(ConfigManager.updateProfiles((ps) => [...ps, P('b')]), undefined);

    assert.match(vscode.window.errorMessages.at(-1)!, /can't be edited right now: the shared config couldn't be used \(.*Failed to parse/);
    assert.match(ConfigManager.getFallbackReason()!, /couldn't be used/);
    assert.match(ConfigManager.getConfigPathForDisplay()!, /neon-sync\.json$/, 'the path shown is still the shared one');
    assert.notEqual(ConfigManager.getConfigPathForDisplay(), legacyPath);
    assert.deepEqual(JSON.parse(fs.readFileSync(legacyPath, 'utf-8')).profiles.map((p: Profile) => p.name), ['a']);
});

test('incomplete legacy profiles are skipped and reported; the rest still migrate', async () => {
    const legacy = { profiles: [P('a'), { name: 'stub', id: 'x', tableName: 'records' }, P('c'), null] };
    const { ConfigManager, vscode, readShared } = setupMigration(legacy);

    const report = await ConfigManager.migrateLegacyConfig();

    assert.deepEqual(report?.added, ['a', 'c']);
    assert.deepEqual(report?.skippedInvalid, ['stub', '#4']);
    assert.deepEqual(readShared().profiles.map((p) => p.name), ['a', 'c']);
    assert.match(vscode.window.infoMessages.at(-1)!, /Skipped \(incomplete, left in the old file\): stub, #4\./);
});

test('a busy config lock postpones migration (no fallback, no marker) instead of failing it', async () => {
    const { ConfigManager, vscode, legacyPath, sharedPath } = setupMigration({ profiles: [P('a')] });
    fs.mkdirSync(`${sharedPath}.lock`);

    assert.equal(await ConfigManager.migrateLegacyConfig(), undefined);

    assert.equal(fs.existsSync(`${legacyPath}.migrated`), false);
    assert.match(vscode.window.warningMessages.at(-1)!, /will move this editor's profiles to the shared config next time/);
    fs.rmdirSync(`${sharedPath}.lock`);
    assert.deepEqual((await ConfigManager.migrateLegacyConfig())?.added, ['a'], 'retried later');
});

test('Open Settings (JSON) opens the shared file even when it is corrupt', async () => {
    const { ConfigManager, vscode, sharedPath } = setupMigration(undefined, '{ broken');
    const opened: string[] = [];
    vscode.workspace.openTextDocument = async (input: string | { fsPath: string }) => {
        opened.push(typeof input === 'string' ? input : input.fsPath);
        return {};
    };

    await ConfigManager.openConfigFile();

    assert.deepEqual(opened, [sharedPath]);
    assert.equal(fs.readFileSync(sharedPath, 'utf-8'), '{ broken');
});

test('setting the URL works with a read-only config directory', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
    const { ConfigManager, secrets, sharedPath } = setupMigration(undefined, { profiles: [P('a')] });
    fs.chmodSync(path.dirname(sharedPath), 0o555);
    try {
        let notified = 0;
        ConfigManager.onConnectionStringChanged(() => { notified += 1; });
        await ConfigManager.setConnectionString('postgres://new');
        await ConfigManager.clearConnectionString();
        assert.equal(notified, 2);
        assert.equal(secrets.values.has('neonSync.connectionString'), false);
        assert.deepEqual(ConfigManager.getProfiles().map((p) => p.name), ['a']);
    } finally {
        fs.chmodSync(path.dirname(sharedPath), 0o755);
    }
});

test('a read-only shared config (e.g. home-manager) stays in use; profiles only this editor had are reported once, not copied', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
    const { ConfigManager, vscode, legacyPath, sharedPath } = setupMigration(
        { profiles: [P('legacyOnly'), P('nixA')] },
        { profiles: [P('nixA'), P('nixB')] }
    );
    fs.chmodSync(path.dirname(sharedPath), 0o555);
    try {
        const report = await ConfigManager.migrateLegacyConfig();

        assert.deepEqual(report?.notCopied, ['legacyOnly']);
        assert.deepEqual(ConfigManager.getProfiles().map((p) => p.name), ['nixA', 'nixB'], 'the managed list, not the legacy one');
        assert.match(vscode.window.warningMessages.at(-1)!, /read-only here, so these profiles from this editor were not added: legacyOnly/);
        assert.ok(fs.existsSync(`${legacyPath}.migrated`), 'not re-attempted on every launch');
        assert.equal(await ConfigManager.migrateLegacyConfig(), undefined);
    } finally {
        fs.chmodSync(path.dirname(sharedPath), 0o755);
    }
});

test('a busy lock on the very first migration shows this editor\'s profiles (read-only) for the session', async () => {
    const { ConfigManager, sharedPath, vscode } = setupMigration({ profiles: [P('a')] });
    fs.mkdirSync(path.dirname(sharedPath), { recursive: true });
    fs.mkdirSync(`${sharedPath}.lock`);
    try {
        await ConfigManager.migrateLegacyConfig();
        assert.deepEqual(ConfigManager.getProfiles().map((p) => p.name), ['a']);
        assert.equal(ConfigManager.updateProfiles((ps) => ps), undefined, 'read-only meanwhile');
        assert.match(vscode.window.errorMessages.at(-1)!, /couldn't be created yet .*retried next launch/, 'says why: busy, not broken');
    } finally {
        fs.rmdirSync(`${sharedPath}.lock`);
    }
});

test('a permission error before the shared file exists postpones migration (no marker) and shows this editor\'s profiles', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
    const { ConfigManager, legacyPath, sharedPath } = setupMigration({ profiles: [P('a'), P('b')] });
    fs.chmodSync(path.dirname(sharedPath), 0o555);
    try {
        assert.equal(await ConfigManager.migrateLegacyConfig(), undefined);
        assert.equal(fs.existsSync(`${legacyPath}.migrated`), false);
        assert.deepEqual(ConfigManager.getProfiles().map((p) => p.name), ['a', 'b']);
    } finally {
        fs.chmodSync(path.dirname(sharedPath), 0o755);
    }
    // Writable again: the next launch (a fresh initialize) migrates.
    ConfigManager.initialize({ globalStorageUri: { fsPath: path.dirname(legacyPath) }, secrets: createSecretMock() } as never, {
        configDir: path.dirname(sharedPath), stateDir: path.join(path.dirname(sharedPath), '.state')
    });
    assert.deepEqual((await ConfigManager.migrateLegacyConfig())?.added, ['a', 'b']);
});
