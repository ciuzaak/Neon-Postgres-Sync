import test = require('node:test');
import assert = require('node:assert/strict');
import {
    baselineAfterSync,
    candidateFor,
    computeDiffStats,
    decideSyncDirection,
    finalizeCandidate,
    planSync
} from '../../src/core/plan';
import { filterFingerprint, hashProjection, SyncBaseline } from '../../src/core/syncState';
import { stripKeys } from '../../src/core/jsoncFilter';
import type { LocalSnapshot } from '../../src/core/localFile';
import type { FetchedRecord, Profile } from '../../src/core/types';

function profile(overrides: Partial<Profile> = {}): Profile {
    return { name: 'alpha', filePath: 'alpha.json', id: 'row-1', tableName: 'records', ...overrides };
}

function local(content: string | null, mtime: Date | null = new Date('2026-01-01T00:00:00Z')): LocalSnapshot {
    return content === null
        ? { exists: false, content: '', mtime: null }
        : { exists: true, content, mtime };
}

function remote(data: string | null, updateTime: Date | null = new Date('2026-01-01T00:01:00Z')): FetchedRecord {
    return data === null
        ? { data: null, updateTime: null, version: null }
        : { data, updateTime, version: `opaque-token:${data}` };
}

// ── decideSyncDirection ────────────────────────────────────────────────

test('decideSyncDirection downloads when the local file is missing', () => {
    const result = decideSyncDirection(false, true, null, new Date('2026-01-01T00:00:00Z'));

    assert.equal(result.direction, 'download');
    assert.equal(result.ambiguous, false);
    assert.equal(result.reason, 'no local file yet');
});

test('decideSyncDirection uploads when the remote row is missing', () => {
    const result = decideSyncDirection(true, false, new Date('2026-01-01T00:00:00Z'), null);

    assert.equal(result.direction, 'upload');
    assert.equal(result.ambiguous, false);
    assert.equal(result.reason, 'no remote record yet');
});

test('decideSyncDirection chooses the newer remote timestamp outside the ambiguity window', () => {
    const result = decideSyncDirection(
        true,
        true,
        new Date('2026-01-01T00:00:00.000Z'),
        new Date('2026-01-01T00:00:10.000Z')
    );

    assert.equal(result.direction, 'download');
    assert.equal(result.ambiguous, false);
    assert.match(result.reason, /remote is newer/);
});

test('decideSyncDirection marks close timestamps as ambiguous', () => {
    const result = decideSyncDirection(
        true,
        true,
        new Date('2026-01-01T00:00:00.000Z'),
        new Date('2026-01-01T00:00:04.999Z')
    );

    assert.equal(result.direction, 'download');
    assert.equal(result.ambiguous, true);
});

test('decideSyncDirection is ambiguous when a timestamp is missing on an existing side', () => {
    const result = decideSyncDirection(true, true, new Date('2026-01-01T00:00:00Z'), null);

    assert.equal(result.direction, 'upload');
    assert.equal(result.ambiguous, true);
});

// ── computeDiffStats ───────────────────────────────────────────────────

test('computeDiffStats reports lines added and removed when downloading remote content', () => {
    assert.deepEqual(
        computeDiffStats('same\nlocal-only', 'same\nremote-only\nremote-added', 'download'),
        { added: 2, removed: 1 }
    );
});

test('computeDiffStats flips added and removed counts when uploading local content', () => {
    assert.deepEqual(
        computeDiffStats('same\nlocal-only', 'same\nremote-only\nremote-added', 'upload'),
        { added: 1, removed: 2 }
    );
});

test('computeDiffStats treats an empty side as zero lines', () => {
    assert.deepEqual(computeDiffStats('', 'remote', 'download'), { added: 1, removed: 0 });
    assert.deepEqual(computeDiffStats('local', '', 'download'), { added: 0, removed: 1 });
});

// ── planSync ───────────────────────────────────────────────────────────

test('planSync reports missing-both when neither side exists', () => {
    const plan = planSync(profile(), local(null), remote(null));

    assert.equal(plan.status, 'missing-both');
    assert.equal(plan.localExists, false);
    assert.equal(plan.remoteExists, false);
});

test('planSync reports identical content without a filter', () => {
    const plan = planSync(profile(), local('{"a":1}'), remote('{"a":1}'));

    assert.equal(plan.status, 'identical');
});

test('planSync reports pending with the suggested direction when content differs', () => {
    const plan = planSync(profile(), local('old'), remote('new'));

    assert.equal(plan.status, 'pending');
    assert.equal(plan.suggestion.direction, 'download');
    assert.equal(plan.localContent, 'old');
    assert.equal(plan.remoteContent, 'new');
});

test('planSync treats differences only in excluded keys as identical and keeps raw originals', () => {
    const plan = planSync(
        profile({ excludeKeys: ['theme'] }),
        local('{"a": 1, "theme": "dark"}'),
        remote('{"a": 1, "theme": "light"}')
    );

    assert.equal(plan.status, 'identical');
    assert.equal(plan.localContent, plan.remoteContent);
    assert.match(plan.localOriginal, /dark/);
    assert.match(plan.remoteOriginal, /light/);
});

test('planSync reports parse-error with the failing side and leaves content unstripped', () => {
    const plan = planSync(
        profile({ excludeKeys: ['theme'] }),
        local('{"theme": "dark"}'),
        remote('not json')
    );

    assert.equal(plan.status, 'parse-error');
    assert.equal(plan.parseError?.side, 'remote');
    assert.equal(plan.localContent, '{"theme": "dark"}');
});

test('planSync only parses sides that exist when filtering', () => {
    const plan = planSync(profile({ excludeKeys: ['theme'] }), local(null), remote('{"theme": 1}'));

    assert.equal(plan.status, 'pending');
    assert.equal(plan.suggestion.direction, 'download');
});

// ── candidateFor / finalizeCandidate ───────────────────────────────────

test('candidateFor picks the source side for the direction', () => {
    const plan = { localContent: 'L', remoteContent: 'R' };

    assert.equal(candidateFor(plan, 'download'), 'R');
    assert.equal(candidateFor(plan, 'upload'), 'L');
});

test('finalizeCandidate is a no-op without excludeKeys', () => {
    const ctx = { localOriginal: 'L', remoteOriginal: 'R', excludeKeys: [] };

    assert.equal(finalizeCandidate('C', 'download', ctx), 'C');
});

test('finalizeCandidate restores excluded keys from the destination side', () => {
    const ctx = {
        localOriginal: '{"a": 1, "theme": "dark"}',
        remoteOriginal: '{"a": 2, "theme": "light"}',
        excludeKeys: [['theme']]
    };

    // Download → destination is local: keep local's theme.
    assert.deepEqual(JSON.parse(finalizeCandidate('{"a": 2}', 'download', ctx)), { a: 2, theme: 'dark' });
    // Upload → destination is remote: keep remote's theme.
    assert.deepEqual(JSON.parse(finalizeCandidate('{"a": 1}', 'upload', ctx)), { a: 1, theme: 'light' });
});

// ── baseline-aware planning (spec Part 1 decision table) ───────────────

const KEY = { tableName: 'records', id: 'row-1', localPath: '/abs/alpha.json' };
const SYNCED_AT = new Date('2026-09-20T14:02:00Z');

function baselineOf(projection: string, excludeKeys: string[][] = []): SyncBaseline {
    return {
        ...KEY,
        baseHash: hashProjection(projection),
        filterFingerprint: filterFingerprint(excludeKeys),
        remoteVersion: null,
        syncedAt: SYNCED_AT.toISOString()
    };
}

// Timestamps chosen so the legacy heuristic would pick the OPPOSITE of the
// baseline answer — proves the baseline, not the clock, decided.
const LOCAL_NEWER = new Date('2026-09-25T00:10:00Z');
const REMOTE_OLDER = new Date('2026-09-25T00:00:00Z');

test('baseline: only remote changed ⇒ download, not ambiguous, even if local looks newer', () => {
    const plan = planSync(profile(), local('base', LOCAL_NEWER), remote('theirs', REMOTE_OLDER), baselineOf('base'));

    assert.equal(plan.change, 'remote');
    assert.deepEqual(
        [plan.suggestion.direction, plan.suggestion.ambiguous],
        ['download', false]
    );
    assert.match(plan.suggestion.reason, /only remote changed since last sync \(2026-09-20T14:02:00\.000Z\)/);
});

test('baseline: only local changed ⇒ upload, not ambiguous, even if remote looks newer', () => {
    const plan = planSync(
        profile(),
        local('mine', REMOTE_OLDER),
        remote('base', LOCAL_NEWER),
        baselineOf('base')
    );

    assert.equal(plan.change, 'local');
    assert.deepEqual([plan.suggestion.direction, plan.suggestion.ambiguous], ['upload', false]);
});

test('baseline: both changed ⇒ conflict, always ambiguous even with a large timestamp gap', () => {
    const plan = planSync(profile(), local('mine', LOCAL_NEWER), remote('theirs', REMOTE_OLDER), baselineOf('base'));

    assert.equal(plan.change, 'both');
    assert.equal(plan.suggestion.ambiguous, true);
    assert.match(plan.suggestion.reason, /both local and remote changed/);
});

test('identical ⇒ change none, with or without a baseline (even a stale one)', () => {
    assert.equal(planSync(profile(), local('same'), remote('same')).change, 'none');
    assert.equal(planSync(profile(), local('same'), remote('same'), baselineOf('same')).change, 'none');
    assert.equal(planSync(profile(), local('same'), remote('same'), baselineOf('old')).change, 'none');
});

test('no baseline ⇒ change unknown and the timestamp heuristic decides, labelled as such', () => {
    const plan = planSync(profile(), local('mine', LOCAL_NEWER), remote('theirs', REMOTE_OLDER));

    assert.equal(plan.change, 'unknown');
    assert.equal(plan.suggestion.direction, 'upload');
    assert.match(plan.suggestion.reason, /^no sync history; local is newer/);
});

test('baseline taken under a different excludeKeys set is ignored, and the reason says so', () => {
    const p = profile({ excludeKeys: ['theme'] });
    const plan = planSync(p, local('{"a":1}', LOCAL_NEWER), remote('{"a":2}', REMOTE_OLDER), baselineOf('{"a":1}'));

    assert.equal(plan.change, 'unknown');
    assert.match(plan.suggestion.reason, /^excludeKeys changed since last sync; local is newer/);
});

test('no baseline + close timestamps ⇒ still ambiguous, reason prefixed', () => {
    const plan = planSync(profile(), local('a', new Date(1000)), remote('b', new Date(2000)));

    assert.equal(plan.suggestion.ambiguous, true);
    assert.match(plan.suggestion.reason, /^no sync history; remote is newer/);
});

test('regression: a comment-only local edit next to an excluded key is a change, not hidden', () => {
    const p = profile({ excludeKeys: ['theme'] });
    const K = [['theme']];
    const base = stripKeys('{\n    "fontSize": 14, // why 14\n    "theme": "dark"\n}\n', K);
    const plan = planSync(
        p,
        local('{\n    "fontSize": 14, // why 14: ops ticket 123\n    "theme": "dark"\n}\n', LOCAL_NEWER),
        remote('{\n    "fontSize": 16, // why 14\n    "theme": "dark"\n}\n', REMOTE_OLDER),
        baselineOf(base, K)
    );

    assert.equal(plan.change, 'both');
    assert.equal(plan.suggestion.ambiguous, true);
});

test('baseline: edits confined to excluded keys never count as a change', () => {
    const p = profile({ excludeKeys: ['theme'] });
    const doc = (a: number, theme: string) => `{\n    "a": ${a},\n    "theme": "${theme}"\n}\n`;
    // Base = projection of what the remote held after the last sync.
    const base = stripKeys(doc(1, 'light'), [['theme']]);
    const plan = planSync(
        p,
        local(doc(1, 'dark'), LOCAL_NEWER),        // only the excluded key moved
        remote(doc(2, 'light'), REMOTE_OLDER),     // a real change
        baselineOf(base, [['theme']])
    );

    assert.equal(plan.change, 'remote');
    assert.equal(plan.suggestion.direction, 'download');
});

test('baseline is not applied when a side is missing (delete propagation is out of scope)', () => {
    const plan = planSync(profile(), local(null), remote('theirs'), baselineOf('base'));

    assert.equal(plan.change, 'unknown');
    assert.equal(plan.suggestion.reason, 'no local file yet');
});

test('baselineAfterSync hashes the remote projection with excluded keys stripped', () => {
    const plan = planSync(profile({ excludeKeys: ['theme'] }), local('{}'), remote('{}'));

    const b = baselineAfterSync(plan, KEY, '{"a": 1, "theme": "light"}', 'v9', SYNCED_AT);

    assert.equal(b.baseHash, hashProjection(stripKeys('{"a": 1, "theme": "light"}', [['theme']])));
    const later = planSync(profile({ excludeKeys: ['theme'] }), local('{}'), remote('{"a": 1, "theme": "light"}'));
    assert.equal(b.baseHash, hashProjection(later.remoteContent), 'matches the projection a later plan computes');
    assert.equal(b.filterFingerprint, filterFingerprint([['theme']]));
    assert.deepEqual([b.tableName, b.id, b.localPath, b.remoteVersion, b.syncedAt], [
        'records', 'row-1', '/abs/alpha.json', 'v9', '2026-09-20T14:02:00.000Z'
    ]);
});

test('round trip: after a download where the user edited the candidate, the next plan sees a local change', () => {
    // Remote had "theirs"; user downloaded but edited the candidate to "edited" before confirming.
    const first = planSync(profile(), local('mine'), remote('theirs'));
    const baseline = baselineAfterSync(first, KEY, first.remoteOriginal, null, SYNCED_AT);

    const next = planSync(profile(), local('edited'), remote('theirs'), baseline);

    assert.equal(next.change, 'local');
    assert.equal(next.suggestion.direction, 'upload');
});

test('round trip: after an upload, an untouched pair plans as identical and later remote edits as remote', () => {
    const first = planSync(profile(), local('mine'), remote('theirs'));
    const baseline = baselineAfterSync(first, KEY, 'mine', 'v2', SYNCED_AT);

    assert.equal(planSync(profile(), local('mine'), remote('mine'), baseline).status, 'identical');
    assert.equal(planSync(profile(), local('mine'), remote('newer'), baseline).change, 'remote');
});

// ── round trips with excludeKeys through finalizeCandidate ────────────

const K_THEME = [['theme']];
const withTheme = (font: number, theme: string, comment = '') =>
    `{\n    "fontSize": ${font},${comment}\n    "theme": "${theme}"\n}\n`;

test('round trip with excludeKeys: after a download, both sides plan as identical', () => {
    const p = profile({ excludeKeys: ['theme'] });
    const first = planSync(p, local(withTheme(14, 'dark', ' // mine')), remote(withTheme(16, 'light')));
    const localAfter = finalizeCandidate(candidateFor(first, 'download'), 'download', first);
    const baseline = baselineAfterSync(first, KEY, first.remoteOriginal, null, SYNCED_AT);

    const next = planSync(p, local(localAfter), remote(first.remoteOriginal), baseline);

    assert.match(localAfter, /"theme": "dark"/, 'local keeps its own excluded value');
    assert.equal(next.status, 'identical');
});

test('round trip with excludeKeys: after an upload, both sides plan as identical', () => {
    const p = profile({ excludeKeys: ['theme'] });
    const first = planSync(p, local(withTheme(14, 'dark', ' // why 14')), remote(withTheme(16, 'light')));
    const remoteAfter = finalizeCandidate(candidateFor(first, 'upload'), 'upload', first);
    const baseline = baselineAfterSync(first, KEY, remoteAfter, 'v2', SYNCED_AT);

    const next = planSync(p, local(first.localOriginal), remote(remoteAfter), baseline);

    assert.match(remoteAfter, /"theme": "light"/, 'remote keeps its own excluded value');
    assert.match(remoteAfter, /\/\/ why 14/, 'comment next to the excluded key survives');
    assert.equal(next.status, 'identical');
    // Later, a remote-only change is attributed to the remote.
    assert.equal(planSync(p, local(first.localOriginal), remote(withTheme(18, 'light', ' // why 14')), baseline).change, 'remote');
});

test('baselineExists tells first-time setup from a side deleted since the last sync', () => {
    const fresh = planSync(profile(), local(null), remote('theirs'));
    const deleted = planSync(profile(), local(null), remote('theirs'), baselineOf('theirs'));

    assert.equal(fresh.baselineExists, false);
    assert.equal(deleted.baselineExists, true);
    // Filter changes make a baseline unusable, but it still exists.
    const refiltered = planSync(profile({ excludeKeys: ['x'] }), local('{}'), remote('{"a":1}'), baselineOf('{}'));
    assert.deepEqual([refiltered.change, refiltered.baselineExists], ['unknown', true]);
});
