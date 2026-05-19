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

import { assertJsonc, JsoncFilterParseError } from '../src/jsoncFilter';

test('assertJsonc accepts plain JSON', () => {
    assertJsonc('{"a": 1, "b": [1, 2]}', 'local');
});

test('assertJsonc accepts JSONC with comments and trailing commas', () => {
    const input = `{
        // a comment
        "a": 1,
        "b": [1, 2,],
        /* block */
        "c": "x",
    }`;
    assertJsonc(input, 'remote');
});

test('assertJsonc throws JsoncFilterParseError on truly invalid input', () => {
    assert.throws(
        () => assertJsonc('{ "a": ', 'local'),
        (err: unknown) => {
            assert.ok(err instanceof JsoncFilterParseError, 'expected JsoncFilterParseError');
            assert.equal((err as JsoncFilterParseError).side, 'local');
            return true;
        }
    );
});

test('assertJsonc accepts an empty object/array', () => {
    assertJsonc('{}', 'local');
    assertJsonc('[]', 'remote');
});

test('assertJsonc treats a whitespace-only string as invalid', () => {
    assert.throws(() => assertJsonc('   \n\t', 'local'), JsoncFilterParseError);
});

import { stripKeys } from '../src/jsoncFilter';

test('stripKeys removes a single top-level key', () => {
    const out = stripKeys('{"a": 1, "b": 2}', [['a']]);
    const parsed = JSON.parse(out);
    assert.deepEqual(parsed, { b: 2 });
});

test('stripKeys removes a nested key while keeping the parent', () => {
    const out = stripKeys('{"a": {"b": 1, "c": 2}}', [['a', 'b']]);
    const parsed = JSON.parse(out);
    assert.deepEqual(parsed, { a: { c: 2 } });
});

test('stripKeys removes multiple keys (top-level and nested) in one pass', () => {
    const out = stripKeys(
        '{"a": 1, "b": {"x": 2, "y": 3}, "c": 4}',
        [['a'], ['b', 'x']]
    );
    const parsed = JSON.parse(out);
    assert.deepEqual(parsed, { b: { y: 3 }, c: 4 });
});

test('stripKeys is a no-op when the path does not exist', () => {
    const out = stripKeys('{"a": 1}', [['nope'], ['a', 'b', 'c']]);
    const parsed = JSON.parse(out);
    assert.deepEqual(parsed, { a: 1 });
});

test('stripKeys preserves comments on surviving keys', () => {
    const input = `{
    // keep this
    "a": 1,
    // remove this
    "b": 2
}`;
    const out = stripKeys(input, [['b']]);
    assert.match(out, /\/\/ keep this/);
    assert.equal(out.includes('"b"'), false);
});

test('stripKeys tolerates trailing commas in the input', () => {
    const out = stripKeys('{"a": 1, "b": 2,}', [['a']]);
    const parsed = JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
    assert.deepEqual(parsed, { b: 2 });
});

test('stripKeys returns the input unchanged when paths array is empty', () => {
    const input = '{"a": 1}';
    assert.equal(stripKeys(input, []), input);
});

import { mergeBack } from '../src/jsoncFilter';

test('mergeBack restores a top-level filtered key from destination', () => {
    const candidate = '{"shared": "new"}';
    const destination = '{"shared": "old", "secret": 42}';
    const out = mergeBack(candidate, destination, [['secret']]);
    assert.deepEqual(JSON.parse(out), { shared: 'new', secret: 42 });
});

test('mergeBack overrides candidate value at filtered path with destination value', () => {
    const candidate = '{"a": 1, "k": "from-candidate"}'; // user accidentally kept "k"
    const destination = '{"a": 0, "k": "from-destination"}';
    const out = mergeBack(candidate, destination, [['k']]);
    assert.deepEqual(JSON.parse(out), { a: 1, k: 'from-destination' });
});

test('mergeBack removes filtered key from candidate when destination lacks it', () => {
    const candidate = '{"a": 1, "stale": true}';
    const destination = '{"a": 0}';
    const out = mergeBack(candidate, destination, [['stale']]);
    assert.deepEqual(JSON.parse(out), { a: 1 });
});

test('mergeBack with neither side holding the filtered key is a no-op', () => {
    const candidate = '{"a": 1}';
    const destination = '{"a": 0}';
    const out = mergeBack(candidate, destination, [['gone']]);
    assert.deepEqual(JSON.parse(out), { a: 1 });
});

test('mergeBack restores a nested filtered key, building intermediates if needed', () => {
    const candidate = '{"keep": true}';
    const destination = '{"keep": false, "outer": {"inner": {"deep": "value"}}}';
    const out = mergeBack(candidate, destination, [['outer', 'inner', 'deep']]);
    const parsed = JSON.parse(out);
    assert.equal(parsed.keep, true);
    assert.equal(parsed.outer.inner.deep, 'value');
});

test('mergeBack preserves comments in candidate', () => {
    const candidate = `{
    // user's comment
    "shared": "new"
}`;
    const destination = '{"shared": "old", "secret": 1}';
    const out = mergeBack(candidate, destination, [['secret']]);
    assert.match(out, /\/\/ user's comment/);
});

test('mergeBack with empty paths array returns candidate unchanged', () => {
    const candidate = '{"a": 1}';
    assert.equal(mergeBack(candidate, '{"a": 2}', []), candidate);
});

test('mergeBack restores filtered key values of every JSON type', () => {
    const candidate = '{}';
    const destination = '{"s": "x", "n": 3.14, "b": true, "nul": null, "arr": [1, 2], "obj": {"k": "v"}}';
    const out = mergeBack(candidate, destination, [
        ['s'], ['n'], ['b'], ['nul'], ['arr'], ['obj']
    ]);
    assert.deepEqual(JSON.parse(out), {
        s: 'x', n: 3.14, b: true, nul: null, arr: [1, 2], obj: { k: 'v' }
    });
});
