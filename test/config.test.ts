import test = require('node:test');
import assert = require('node:assert/strict');
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { installModuleMocks, purgeProjectModules, resetMocks } from './helpers/moduleMocks';
import type { ConfigFile, Profile } from '../src/config';

installModuleMocks();

interface SecretMock {
    values: Map<string, string>;
    get: (key: string) => Promise<string | undefined>;
    store: (key: string, value: string) => Promise<void>;
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
    } as never);
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
