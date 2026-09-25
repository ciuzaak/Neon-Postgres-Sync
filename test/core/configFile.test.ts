import test = require('node:test');
import assert = require('node:assert/strict');
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConfigFileReadError, ConfigFileStore } from '../../src/core/configFile';
import type { ConfigFile } from '../../src/core/types';

function tempConfigPath(): string {
    return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neon-sync-core-config-')), 'neon-sync.json');
}

test('read returns undefined when the file does not exist', () => {
    assert.equal(new ConfigFileStore(tempConfigPath()).read(), undefined);
});

test('read throws ConfigFileReadError on malformed JSON', () => {
    const filePath = tempConfigPath();
    fs.writeFileSync(filePath, '{ nope');

    assert.throws(() => new ConfigFileStore(filePath).read(), (e: unknown) => {
        assert.ok(e instanceof ConfigFileReadError);
        assert.match(e.message, /^Failed to parse neon-sync\.json: /);
        return true;
    });
});

test('read wraps IO failures (e.g. the path is a directory) in ConfigFileReadError', () => {
    const filePath = tempConfigPath();
    fs.mkdirSync(filePath);

    assert.throws(() => new ConfigFileStore(filePath).read(), ConfigFileReadError);
});

test('saveProfiles normalizes profiles and preserves other top-level fields', () => {
    const filePath = tempConfigPath();
    fs.writeFileSync(filePath, JSON.stringify({ connectionString: 'postgres://legacy', profiles: [] }));
    const store = new ConfigFileStore(filePath);

    store.saveProfiles([
        { name: 'A', filePath: 'a.json', id: 'a', tableName: 't', excludeKeys: [] },
        { name: 'B', filePath: 'b.json', id: 'b', tableName: 't', excludeKeys: ['x'], extra: 1 } as never
    ]);

    const written = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as ConfigFile;
    assert.equal(written.connectionString, 'postgres://legacy');
    assert.deepEqual(written.profiles, [
        { name: 'A', filePath: 'a.json', id: 'a', tableName: 't' },
        { name: 'B', filePath: 'b.json', id: 'b', tableName: 't', excludeKeys: ['x'] }
    ]);
});

test('removeConnectionString drops only the legacy field', () => {
    const filePath = tempConfigPath();
    const profiles = [{ name: 'A', filePath: 'a.json', id: 'a', tableName: 't' }];
    fs.writeFileSync(filePath, JSON.stringify({ connectionString: 'postgres://legacy', profiles }));

    new ConfigFileStore(filePath).removeConnectionString();

    assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf-8')), { profiles });
});

test('ensureExists creates the file and parent directory once', () => {
    const filePath = path.join(path.dirname(tempConfigPath()), 'nested', 'neon-sync.json');
    const store = new ConfigFileStore(filePath);

    assert.equal(store.ensureExists({ profiles: [] }), true);
    assert.equal(store.ensureExists({ profiles: [{ name: 'ignored' } as never] }), false);
    assert.deepEqual(store.read(), { profiles: [] });
});
