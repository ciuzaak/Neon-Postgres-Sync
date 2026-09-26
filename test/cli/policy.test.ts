import test = require('node:test');
import assert = require('node:assert/strict');
import { classify, isLargeDeletion, overwritesUnreviewed } from '../../cli/src/policy';
import { planSync } from '../../src/core/plan';
import { filterFingerprint, hashProjection } from '../../src/core/syncState';
import type { Profile } from '../../src/core/types';

const P: Profile = { name: 'p', filePath: '/p.json', id: 'p', tableName: 't' };
const local = (c: string | null, mtime = new Date(2000)) => c === null ? { exists: false, content: '', mtime: null } : { exists: true, content: c, mtime };
const remote = (c: string | null, t = new Date(1000)) => ({ data: c, updateTime: c === null ? null : t, version: c });
const base = (content: string) => ({
    tableName: 't', id: 'p', localPath: '/p.json', baseHash: hashProjection(content),
    filterFingerprint: filterFingerprint([]), remoteVersion: null, syncedAt: '2026-01-01T00:00:00Z'
});
const plan = (l: string | null, r: string | null, b?: string) => planSync(P, local(l), remote(r), b === undefined ? undefined : base(b));

test('the safety table: which rows are auto-applicable', () => {
    const cases: Array<[string, ReturnType<typeof plan>, string, string | undefined]> = [
        ['identical', plan('x', 'x'), 'in-sync', undefined],
        ['local changed', plan('new', 'base', 'base'), 'auto', 'upload'],
        ['remote changed', plan('base', 'new', 'base'), 'auto', 'download'],
        ['both changed', plan('a', 'b', 'base'), 'decide', undefined],
        ['no history', plan('a', 'b'), 'decide', undefined],
        ['first-time local only', plan('a', null), 'auto', 'upload'],
        ['first-time remote only', plan(null, 'b'), 'auto', 'download'],
        ['deleted locally since sync', plan(null, 'b', 'b'), 'decide', undefined],
        ['deleted remotely since sync', plan('a', null, 'a'), 'decide', undefined],
        ['missing both', plan(null, null), 'error', undefined]
    ];
    for (const [name, p, kind, direction] of cases) {
        const c = classify(p);
        assert.equal(c.kind, kind, name);
        if (direction) assert.equal(c.direction, direction, name);
    }
});

test('large deletion: empty candidate, or more than half the destination and at least 10 lines', () => {
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `l${i}`).join('\n');
    assert.equal(isLargeDeletion('', 'x'), true);
    assert.equal(isLargeDeletion('', ''), false);
    assert.equal(isLargeDeletion(lines(2), lines(30)), true);
    assert.equal(isLargeDeletion(lines(20), lines(30)), false, 'removes 10 of 30: not more than half');
    assert.equal(isLargeDeletion(lines(1), lines(9)), false, 'fewer than 10 lines removed');
    const p = plan(lines(2), lines(30), lines(30)); // local truncated since sync
    assert.deepEqual([classify(p).kind, classify(p).label], ['decide', 'large deletion']);
});

test('forcing a direction over a changed or unknown destination is a destructive override', () => {
    assert.equal(overwritesUnreviewed(plan('new', 'base', 'base'), 'upload'), false, 'remote unchanged');
    assert.equal(overwritesUnreviewed(plan('new', 'base', 'base'), 'download'), true, 'local changed');
    assert.equal(overwritesUnreviewed(plan('a', 'b', 'base'), 'upload'), true, 'both');
    assert.equal(overwritesUnreviewed(plan('a', 'b'), 'download'), true, 'unknown');
    assert.equal(overwritesUnreviewed(plan('a', null, 'a'), 'upload'), false, 'destination missing: nothing overwritten');
    assert.equal(overwritesUnreviewed(plan('x', 'x'), 'upload'), false, 'identical');
});
