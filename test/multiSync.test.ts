import test = require('node:test');
import assert = require('node:assert/strict');
import { installModuleMocks, purgeProjectModules, resetMocks } from './helpers/moduleMocks';
import type { SyncDirection } from '../src/sync';

installModuleMocks();

interface MultiSyncInternals {
    computeDiffStats: (
        localContent: string,
        remoteContent: string,
        direction: SyncDirection
    ) => { added: number; removed: number };
}

function loadMultiSyncInternals(): MultiSyncInternals {
    purgeProjectModules();
    const { MultiSyncManager } = require('../src/multiSync') as typeof import('../src/multiSync');
    return MultiSyncManager as unknown as MultiSyncInternals;
}

test('computeDiffStats reports lines added and removed when downloading remote content', () => {
    resetMocks();
    const manager = loadMultiSyncInternals();

    const stats = manager.computeDiffStats('same\nlocal-only', 'same\nremote-only\nremote-added', 'download');

    assert.deepEqual(stats, { added: 2, removed: 1 });
});

test('computeDiffStats flips added and removed counts when uploading local content', () => {
    resetMocks();
    const manager = loadMultiSyncInternals();

    const stats = manager.computeDiffStats('same\nlocal-only', 'same\nremote-only\nremote-added', 'upload');

    assert.deepEqual(stats, { added: 1, removed: 2 });
});

test('computeDiffStats treats an empty side as zero lines', () => {
    resetMocks();
    const manager = loadMultiSyncInternals();

    assert.deepEqual(manager.computeDiffStats('', 'remote', 'download'), { added: 1, removed: 0 });
    assert.deepEqual(manager.computeDiffStats('local', '', 'download'), { added: 0, removed: 1 });
});
