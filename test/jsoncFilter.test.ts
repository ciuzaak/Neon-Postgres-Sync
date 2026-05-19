import test = require('node:test');
import assert = require('node:assert/strict');
import { parsePaths } from '../src/jsoncFilter';

test('parsePaths splits dot-separated strings, trims, drops empty, dedupes, preserves order', () => {
    assert.deepEqual(
        parsePaths(['a.b.c', '  d.e  ', '', 'a.b.c', 'f']),
        [['a', 'b', 'c'], ['d', 'e'], ['f']]
    );
});

test('parsePaths drops segments that become empty after trim', () => {
    assert.deepEqual(parsePaths(['', '   ', '\t']), []);
});

test('parsePaths returns single-segment paths for top-level keys', () => {
    assert.deepEqual(parsePaths(['root']), [['root']]);
});

test('parsePaths is non-destructive on the input array', () => {
    const input = ['a.b', 'a.b'];
    parsePaths(input);
    assert.deepEqual(input, ['a.b', 'a.b']);
});
