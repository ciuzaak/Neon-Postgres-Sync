import test = require('node:test');
import assert = require('node:assert/strict');
import {
    candidateFor,
    computeDiffStats,
    decideSyncDirection,
    finalizeCandidate,
    planSync
} from '../../src/core/plan';
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
    return { data, updateTime: data === null ? null : updateTime };
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
