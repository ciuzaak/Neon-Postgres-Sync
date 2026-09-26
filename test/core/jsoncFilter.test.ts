import test = require('node:test');
import assert = require('node:assert/strict');
import { parsePaths } from '../../src/core/jsoncFilter';

test('parsePaths splits dot-separated strings, trims, drops empty, dedupes, preserves order', () => {
    assert.deepEqual(
        parsePaths(['a.b.c', '  d.e  ', '', 'a.b.c', 'f']),
        [['a', 'b', 'c'], ['d', 'e'], ['f']]
    );
});

test('parsePaths drops whitespace-only lines', () => {
    assert.deepEqual(parsePaths(['', '   ', '\t']), []);
});

test('parsePaths rejects lines with empty segments (trailing/leading/double dots)', () => {
    // "settings." should NOT silently become ["settings"] — that would match the
    // wrong key. Reject the entry entirely.
    assert.deepEqual(
        parsePaths(['valid.path', 'trailing.', '.leading', 'with..double', '   .leading2', 'a.   .b']),
        [['valid', 'path']]
    );
});

test('parsePaths returns single-segment paths for top-level keys', () => {
    assert.deepEqual(parsePaths(['root']), [['root']]);
});

test('parsePaths is non-destructive on the input array', () => {
    const input = ['a.b', 'a.b'];
    parsePaths(input);
    assert.deepEqual(input, ['a.b', 'a.b']);
});

import { assertJsonc, JsoncFilterParseError } from '../../src/core/jsoncFilter';

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

import { stripKeys } from '../../src/core/jsoncFilter';

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

test('stripKeys keeps the previous key\'s trailing comment when removing the last key', () => {
    const out = stripKeys('{\n    "fontSize": 14, // why 14\n    "theme": "dark"\n}\n', [['theme']]);
    assert.equal(out, '{\n    "fontSize": 14 // why 14\n}\n');
});

test('stripKeys keeps comment lines above the removed key', () => {
    const out = stripKeys('{\n    "a": 1,\n    // about theme\n    "theme": "dark"\n}', [['theme']]);
    assert.equal(out, '{\n    "a": 1\n    // about theme\n}');
});

test('stripKeys removes a key\'s own same-line comment but keeps the next key\'s', () => {
    const out = stripKeys('{\n    "a": 1,\n    "theme": "dark", // mine\n    "b": 2 // keep\n}\n', [['theme']]);
    assert.equal(out, '{\n    "a": 1,\n    "b": 2 // keep\n}\n');
});

test('stripKeys removes inline keys cleanly in any position', () => {
    assert.equal(stripKeys('{"a": 1, "theme": "dark", "b": 2}', [['theme']]), '{"a": 1, "b": 2}');
    assert.equal(stripKeys('{"theme": "dark", "a": 1}', [['theme']]), '{"a": 1}');
    assert.equal(stripKeys('{"a": 1, /*c*/ "theme": "dark"}', [['theme']]), '{"a": 1 /*c*/ }');
});

test('stripKeys preserves CRLF line endings', () => {
    const out = stripKeys('{\r\n    "a": 1, // x\r\n    "theme": "dark"\r\n}\r\n', [['theme']]);
    assert.equal(out, '{\r\n    "a": 1 // x\r\n}\r\n');
});

test('stripKeys removes a multi-line value and a nested key', () => {
    assert.deepEqual(
        JSON.parse(stripKeys('{\n    "a": 1,\n    "obj": {\n        "x": [1,\n 2]\n    },\n    "z": 3\n}', [['obj']])),
        { a: 1, z: 3 }
    );
    assert.equal(stripKeys('{"o": {"k": 1, "theme": 2}}', [['o', 'theme']]), '{"o": {"k": 1}}');
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

import { mergeBack, JsoncFilterMergeError } from '../../src/core/jsoncFilter';

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

test('mergeBack deleting a key keeps the neighbouring key\'s comment', () => {
    const out = mergeBack('{\n    "a": 1, // note\n    "stale": true\n}', '{"a": 0}', [['stale']]);
    assert.equal(out, '{\n    "a": 1 // note\n}');
});

test('upload round trip keeps a comment next to an excluded key', () => {
    const local = '{\n    "fontSize": 14, // why 14\n    "theme": "dark"\n}\n';
    const remote = '{\n    "fontSize": 16,\n    "theme": "light"\n}\n';
    const final = mergeBack(stripKeys(local, [['theme']]), remote, [['theme']]);
    assert.match(final, /\/\/ why 14/);
    assert.deepEqual(JSON.parse(final.replace(/\/\/.*$/gm, '')), { fontSize: 14, theme: 'light' });
});

test('mergeBack appends a restored key after a trailing comment, not before it', () => {
    const out = mergeBack('{\n    "fontSize": 14 // why 14\n}\n', '{"theme": "light"}', [['theme']]);
    assert.equal(out, '{\n    "fontSize": 14, // why 14\n    "theme": "light"\n}\n');
});

test('mergeBack insertion respects trailing commas, inline objects, empty objects, CRLF and tabs', () => {
    assert.equal(mergeBack('{\n    "a": 1, // c\n}', '{"t": 1}', [['t']]), '{\n    "a": 1, // c\n    "t": 1,\n}', 'keeps trailing-comma style');
    assert.equal(mergeBack('{"a": 1}', '{"t": "x"}', [['t']]), '{"a": 1, "t": "x"}');
    assert.equal(mergeBack('{}', '{"t": "x"}', [['t']]), '{"t": "x"}');
    assert.equal(mergeBack('{\n}', '{"t": "x"}', [['t']]), '{\n    "t": "x"\n}');
    assert.equal(mergeBack('{\r\n    "a": 1 // c\r\n}\r\n', '{"t": 1}', [['t']]), '{\r\n    "a": 1, // c\r\n    "t": 1\r\n}\r\n');
    assert.equal(mergeBack('{\n\t"a": 1\n}', '{"t": 1}', [['t']]), '{\n\t"a": 1,\n\t"t": 1\n}');
});

test('mergeBack inserts into an existing nested object at its indentation', () => {
    const out = mergeBack('{\n    "o": {\n        "k": 1 // kc\n    }\n}', '{"o": {"t": 2}}', [['o', 't']]);
    assert.equal(out, '{\n    "o": {\n        "k": 1, // kc\n        "t": 2\n    }\n}');
});

test('mergeBack splices the destination value verbatim, keeping its formatting and comments', () => {
    const dest = '{\n    "obj": {\n        // inner\n        "k": 1.0\n    }\n}';
    const out = mergeBack('{\n    "a": 1\n}', dest, [['obj']]);
    assert.equal(out, '{\n    "a": 1,\n    "obj": {\n        // inner\n        "k": 1.0\n    }\n}');
    // Replacing an existing value keeps the candidate's comments around it.
    assert.equal(
        mergeBack('{\n    "theme": "dark", // mine\n    "a": 1\n}', '{"theme": "light"}', [['theme']]),
        '{\n    "theme": "light", // mine\n    "a": 1\n}'
    );
});

test('strip → merge round trip reproduces the original projection exactly', () => {
    const K = [['theme']];
    const local = '{\n    "fontSize": 14, // why 14\n    "theme": "dark"\n}\n';
    const after = mergeBack(stripKeys(local, K), '{\n    "fontSize": 16,\n    "theme": "light"\n}\n', K);
    assert.equal(stripKeys(after, K), stripKeys(local, K));
});

// ── regressions found by fuzzing ───────────────────────────────────────

test('fuzz: a comment right after `{` stays put when a key is restored into the emptied object', () => {
    const K = [['editor', 'fontSize']];
    const local = '{\n  "editor": { // per machine\n    "fontSize": 14\n  }\n}';
    const stripped = stripKeys(local, K);
    assert.equal(stripped, '{\n  "editor": { // per machine\n  }\n}');
    const merged = mergeBack(stripped, '{"editor": {"fontSize": 16}}', K);
    assert.equal(merged, '{\n  "editor": { // per machine\n    "fontSize": 16\n  }\n}');
    assert.equal(stripKeys(merged, K), stripped);
});

test('fuzz: a comment between a value and a comma on a later line survives removal', () => {
    assert.equal(
        stripKeys('{\n  "k": 1\n  // about b\n  , "b": 2\n}', [['k']]),
        '{\n  // about b\n   "b": 2\n}'
    );
    assert.deepEqual(JSON.parse(stripKeys('{"c":6\n/**/,}', [['c']]).replace(/\/\*\*\//, '')), {});
    assert.match(stripKeys('{"c":6\n/**/,}', [['c']]), /\/\*\*\//);
});

test('fuzz: bare CR line endings are line breaks', () => {
    assert.equal(stripKeys('{\n  "k": 1, // c\r  "b": 2\n}', [['k']]), '{\n  "b": 2\n}');
    const merged = mergeBack('{\n  "x": {\n    "a": 1 // c\r  }, "b": 2\n}', '{"x":{"k":3}}', [['x', 'k']]);
    assert.deepEqual(JSON.parse(merged.replace(/\/\/[^\r\n]*/g, '')), { x: { a: 1, k: 3 }, b: 2 });
    assert.match(merged, /"a": 1, \/\/ c\r    "k": 3\r/);
});

test('fuzz: duplicate keys resolve like JSON.parse (last wins) and are stripped entirely', () => {
    assert.equal(stripKeys('{"a":0,"a":1}', [['a']]), '{}');
    assert.deepEqual(JSON.parse(mergeBack('{}', '{"b":9,"b":1}', [['b']])), { b: 1 });
    assert.deepEqual(JSON.parse(mergeBack('{"k":"x","k":"y"}', '{"k":"r"}', [['k']])), { k: 'r' });
});

test('fuzz: a filtered key is stripped from every duplicate parent, not just the effective one', () => {
    const out = stripKeys('{"a":{"k":"secret"},"a":{"j":2}}', [['a', 'k']]);
    assert.equal(out.includes('secret'), false);
});

test('fuzz: stripping handles any number of duplicate copies', () => {
    const many = `{${Array.from({ length: 1200 }, (_, i) => `"k":${i}`).join(',')}}`;
    assert.equal(stripKeys(many, [['k']]), '{}');
});

test('fuzz: trailing-comma style survives a strip → merge → strip round trip', () => {
    const K = [['k']];
    for (const local of ['{\n  "a": 1,\n  "k": 2,\n}', '{"a": 1, "k": 2,}', '{ "a": 1, "b": 3, "k": 2 }', '{"theme":"x","a":2}']) {
        const stripped = stripKeys(local, K);
        assert.equal(stripKeys(mergeBack(stripped, '{"k": 3}', K), K), stripped, local);
    }
});

test('fuzz: a key restored after a trailing line comment does not adopt it', () => {
    const K = [['a'], ['b']];
    const out = mergeBack('{"b":""\n,//\n}', '{"a":""}', K);
    assert.match(stripKeys(out, K), /\/\//);
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

test('mergeBack throws JsoncFilterMergeError when destination has a value but candidate blocks restoration', () => {
    // Filter path "a.secret"; destination has a.secret as a value, but candidate
    // changed "a" to a scalar — restoration is impossible without overwriting
    // user's edit. mergeBack must surface this rather than silently lose data.
    const candidate = '{"a": "scalar"}';
    const destination = '{"a": {"secret": "value"}}';
    assert.throws(
        () => mergeBack(candidate, destination, [['a', 'secret']]),
        (err: unknown) => {
            assert.ok(err instanceof JsoncFilterMergeError, 'expected JsoncFilterMergeError');
            assert.deepEqual([...(err as JsoncFilterMergeError).path], ['a', 'secret']);
            return true;
        }
    );
});

test('mergeBack silently no-ops when destination lacks path AND candidate cannot reach it', () => {
    // No data to restore, and candidate's structure blocks the path. This is
    // benign — destination is "empty" for this key, so the user's intent is met.
    const candidate = '{"a": "scalar"}';
    const destination = '{"a": "scalar-too"}';
    const out = mergeBack(candidate, destination, [['a', 'secret']]);
    assert.deepEqual(JSON.parse(out), { a: 'scalar' });
});

test('parsePaths rejects lines using v1-unsupported wildcard or array-index syntax', () => {
    // Per spec, wildcards (a.*) and array indices (a[0], a.[0]) are not
    // supported in v1. They should be rejected outright rather than silently
    // matched as literal key names like "*" or "[0]".
    assert.deepEqual(
        parsePaths([
            'valid.key',
            'a.*',
            'a[0]',
            'a.[0]',
            'wild*card',
            'arr[1].b'
        ]),
        [['valid', 'key']]
    );
});

// ── flat dotted keys ("editor.fontSize", as VS Code writes settings) ──

test('stripKeys matches a flat dotted key, keeping comments and neighbours', () => {
    const text = '{\n  // font\n  "editor.fontSize": 14, // mine\n  "editor.tabSize": 2\n}\n';
    assert.equal(stripKeys(text, parsePaths(['editor.fontSize'])), '{\n  // font\n  "editor.tabSize": 2\n}\n');
});

test('a written path matches every flat/nested split that exists, and only whole keys', () => {
    const text = JSON.stringify({ 'a.b.c': 1, a: { 'b.c': 2, b: { c: 3, cd: 9 } }, 'a.b': { c: 4 }, 'a.bc': 5, keep: 0 });
    const out = JSON.parse(stripKeys(text, parsePaths(['a.b.c'])));
    assert.deepEqual(out, { a: { b: { cd: 9 } }, 'a.b': {}, 'a.bc': 5, keep: 0 });
    // A prefix of a key name is not a match.
    assert.equal(stripKeys('{"editor.fontSize": 1}', parsePaths(['editor.font'])), '{"editor.fontSize": 1}');
});

test('stripKeys removes every duplicate of a flat key', () => {
    assert.deepEqual(JSON.parse(stripKeys('{"a.b": 1, "x": 0, "a.b": 2}', parsePaths(['a.b']))), { x: 0 });
});

test('mergeBack restores a flat key flat (not as a nested object)', () => {
    const dest = '{\n  "editor.fontSize": 14,\n  "x": 1\n}\n';
    const candidate = '{\n  "x": 2\n}\n';
    const out = mergeBack(candidate, dest, parsePaths(['editor.fontSize']));
    assert.deepEqual(JSON.parse(out), { x: 2, 'editor.fontSize': 14 });
    assert.ok(!/"editor"\s*:/.test(out), out);
});

test('mergeBack gives each concrete form the destination\'s value, removing forms the destination lacks', () => {
    // Candidate (the incoming side) writes it flat; this machine has it nested.
    const dest = '{\n  "editor": { "fontSize": 14, "other": 1 },\n  "x": 1\n}\n';
    const candidate = '{\n  "editor.fontSize": 20,\n  "editor": { "other": 2 },\n  "x": 2\n}\n';
    const out = mergeBack(candidate, dest, parsePaths(['editor.fontSize']));
    assert.deepEqual(JSON.parse(out), { editor: { other: 2, fontSize: 14 }, x: 2 });
});

test('mergeBack removes a flat key the destination does not have', () => {
    const out = mergeBack('{"editor.fontSize": 20, "x": 2}', '{"x": 1}', parsePaths(['editor.fontSize']));
    assert.deepEqual(JSON.parse(out), { x: 2 });
});

test('strip → merge round trip with flat keys reproduces the destination\'s own values', () => {
    const local = '{\n  "editor.fontSize": 14, // this machine\n  "workbench.colorTheme": "Dark",\n  "files.eol": "\\n"\n}\n';
    const remote = '{\n  "editor.fontSize": 20,\n  "workbench.colorTheme": "Light",\n  "files.eol": "\\r\\n"\n}\n';
    const paths = parsePaths(['editor.fontSize', 'workbench.colorTheme']);
    // Download: take the remote, keep this machine's excluded values.
    const merged = mergeBack(remote, local, paths);
    assert.deepEqual(JSON.parse(merged), { 'editor.fontSize': 14, 'workbench.colorTheme': 'Dark', 'files.eol': '\r\n' });
    assert.equal(stripKeys(merged, paths), stripKeys(remote, paths));
});
