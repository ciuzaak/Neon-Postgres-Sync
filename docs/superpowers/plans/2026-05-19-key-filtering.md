# Key Filtering for JSON/JSONC Sync — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-profile `excludeKeys` filtering for JSON/JSONC sync — filtered keys are hidden from the diff view and preserved on the target side on confirm, with the underlying file's comments and formatting intact.

**Architecture:** A new pure-function module (`src/jsoncFilter.ts`) does all JSONC text surgery via Microsoft's `jsonc-parser` library. Both `src/sync.ts` (single-file) and `src/multiSync.ts` (multi-profile panel) consult this module: at panel/diff entry they call `stripKeys` to produce the "what the user sees" version; at confirm they call `mergeBack` to splice the target side's original filtered-key values back into the candidate before persisting. Profile schema gains `excludeKeys?: string[]`; the settings webview adds a collapsible Advanced section with a one-path-per-line textarea.

**Tech Stack:** TypeScript, Node 18 type defs, VS Code Extension API, `jsonc-parser` (new dep), Neon serverless DB client (already present). Tests: `node --test` against TypeScript compiled to `out-test/`.

**Spec reference:** [docs/superpowers/specs/2026-05-19-key-filtering-design.md](../specs/2026-05-19-key-filtering-design.md)

---

## File map

| File | Purpose |
|---|---|
| `package.json` | Add `jsonc-parser` runtime dep |
| `src/config.ts` | `Profile.excludeKeys?: string[]`; serialize-drop when empty |
| `src/jsoncFilter.ts` | **NEW** — `parsePaths`, `assertJsonc`, `stripKeys`, `mergeBack` (pure functions over JSONC text) |
| `src/sync.ts` | Wire filter into single-file sync flow (`SyncSession.excludeKeys`, strip on open, merge on confirm) |
| `src/multiSync.ts` | Wire filter into multi-sync (`MultiSyncItem` gains `excludeKeys` + originals + transient `_pendingFinalContent`; parse-error row state) |
| `src/settingsWebview.ts` | Modal Advanced `<details>` section with textarea; profile list meta-line badge; host-side `_handleSaveProfile` accepts `excludeKeys` |
| `README.md` | New "Filtering keys" subsection |
| `test/jsoncFilter.test.ts` | **NEW** — TDD for the four pure functions |
| `test/config.test.ts` | Extend with `excludeKeys` serialize-drop coverage |

---

### Task 1: Add `jsonc-parser` dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install the dependency**

Run from repo root:

```
npm install jsonc-parser@^3.3.1 --save
```

Expected: `package.json` gains an entry under `dependencies`. `package-lock.json` updates. No transitive deps added (jsonc-parser is zero-dep).

- [ ] **Step 2: Verify the install**

Open [package.json](../../package.json) and confirm the new entry under `dependencies`:

```json
"dependencies": {
    "@neondatabase/serverless": "^1.0.2",
    "jsonc-parser": "^3.3.1"
}
```

Run a quick compile to make sure the module resolves:

```
npm run compile
```

Expected: exits 0, no errors.

- [ ] **Step 3: Commit**

```
git add package.json package-lock.json
git commit -m "chore: add jsonc-parser dependency for key filtering"
```

---

### Task 2: Extend `Profile` schema and serialization

**Files:**
- Modify: [src/config.ts](../../src/config.ts) — `Profile` interface + `saveProfiles` serialization rule
- Modify: [test/config.test.ts](../../test/config.test.ts) — add a serialize-drop test

- [ ] **Step 1: Look at existing `Profile` and `saveProfiles`**

Open [src/config.ts](../../src/config.ts). The `Profile` interface lives at the top (lines 5–10). `saveProfiles` lives at lines 147–160 and currently writes the entire `config` object via `atomicWriteJson`.

- [ ] **Step 2: Write a failing test for `excludeKeys` serialize-drop**

Open [test/config.test.ts](../../test/config.test.ts). Read the file to find a free spot. Add at the bottom (mirror the style of existing tests):

```ts
test('saveProfiles drops empty/missing excludeKeys when writing the config file', async () => {
    const { vscode } = resetMocks();
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'neon-sync-cfg-'));
    vscode.__globalStoragePath = tmpDir; // see installModuleMocks support; if not present, use ConfigManager.initialize with a fake context

    const ConfigMod = loadConfigModule();
    const { ConfigManager } = ConfigMod;

    // The repo's ConfigManager.initialize takes a context; reuse the existing test
    // setup pattern from the other config tests in this file. If those tests
    // construct a fake ExtensionContext, copy that pattern.

    await ConfigManager.saveProfiles([
        { name: 'A', filePath: 'a.json', id: 'a1', tableName: 'json_records' },
        { name: 'B', filePath: 'b.json', id: 'b1', tableName: 'json_records', excludeKeys: [] },
        { name: 'C', filePath: 'c.json', id: 'c1', tableName: 'json_records', excludeKeys: ['x.y'] }
    ]);

    const written = JSON.parse(await fs.promises.readFile(path.join(tmpDir, 'neon-sync.json'), 'utf-8'));
    assert.equal(Object.prototype.hasOwnProperty.call(written.profiles[0], 'excludeKeys'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(written.profiles[1], 'excludeKeys'), false);
    assert.deepEqual(written.profiles[2].excludeKeys, ['x.y']);
});
```

*Engineer note:* The exact `ConfigManager.initialize` test seam may already exist in `test/config.test.ts`. Match the pattern used by the existing tests in that file rather than rolling a new one. The assertion content is what matters: empty/missing arrays must not appear in the serialized JSON.

- [ ] **Step 3: Run the test, verify it fails**

```
npm run compile && npm run compile:test && node --test "out-test/test/config.test.js"
```

Expected: the new test fails because `Profile` doesn't have `excludeKeys` yet, or because the field is being serialized even when empty.

- [ ] **Step 4: Update the `Profile` interface**

In [src/config.ts](../../src/config.ts), replace:

```ts
export interface Profile {
    name: string;
    filePath: string;
    id: string;
    tableName: string;
}
```

with:

```ts
export interface Profile {
    name: string;
    filePath: string;
    id: string;
    tableName: string;
    excludeKeys?: string[];
}
```

- [ ] **Step 5: Update `saveProfiles` to drop empty/missing `excludeKeys`**

In [src/config.ts](../../src/config.ts), replace the body of `saveProfiles`:

```ts
static async saveProfiles(profiles: Profile[]): Promise<void> {
    const configPath = this.getConfigPath();
    if (!configPath) {
        vscode.window.showErrorMessage('Extension not initialized correctly.');
        return;
    }

    let config: ConfigFile = { profiles: [] };
    if (fs.existsSync(configPath)) {
        config = this.readConfig() || { profiles: [] };
    }
    config.profiles = profiles.map((p) => this.normalizeProfileForWrite(p));
    this.atomicWriteJson(configPath, config);
}

private static normalizeProfileForWrite(profile: Profile): Profile {
    const cleaned: Profile = {
        name: profile.name,
        filePath: profile.filePath,
        id: profile.id,
        tableName: profile.tableName
    };
    if (Array.isArray(profile.excludeKeys) && profile.excludeKeys.length > 0) {
        cleaned.excludeKeys = [...profile.excludeKeys];
    }
    return cleaned;
}
```

- [ ] **Step 6: Run the test, verify it passes**

```
npm run compile && npm run compile:test && node --test "out-test/test/config.test.js"
```

Expected: all config tests pass, including the new one.

- [ ] **Step 7: Commit**

```
git add src/config.ts test/config.test.ts
git commit -m "feat(config): add excludeKeys to Profile schema with serialize-drop"
```

---

### Task 3: `jsoncFilter.ts` — `parsePaths`

**Files:**
- Create: [src/jsoncFilter.ts](../../src/jsoncFilter.ts)
- Create: [test/jsoncFilter.test.ts](../../test/jsoncFilter.test.ts)

- [ ] **Step 1: Write the failing test**

Create [test/jsoncFilter.test.ts](../../test/jsoncFilter.test.ts):

```ts
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
    // Pure-empty entries are dropped; entries with only whitespace are dropped.
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
```

- [ ] **Step 2: Run the test, verify it fails**

```
npm run compile && npm run compile:test && node --test "out-test/test/jsoncFilter.test.js"
```

Expected: FAIL — module `../src/jsoncFilter` does not exist.

- [ ] **Step 3: Implement `parsePaths`**

Create [src/jsoncFilter.ts](../../src/jsoncFilter.ts):

```ts
import * as jsoncParser from 'jsonc-parser';

export type KeyPath = ReadonlyArray<string>;

/**
 * Normalize raw path strings (one per textarea line / one per JSON array entry)
 * into KeyPath arrays. Trims, splits on '.', drops empty results, dedupes by
 * full-path string equality, preserves first-seen order.
 */
export function parsePaths(raw: ReadonlyArray<string>): KeyPath[] {
    const seen = new Set<string>();
    const out: KeyPath[] = [];
    for (const line of raw) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const segments = trimmed.split('.').map((s) => s.trim()).filter((s) => s.length > 0);
        if (segments.length === 0) continue;
        const key = segments.join('\x00'); // null-byte joiner: safe vs any user input
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(segments);
    }
    return out;
}
```

- [ ] **Step 4: Run the test, verify it passes**

```
npm run compile && npm run compile:test && node --test "out-test/test/jsoncFilter.test.js"
```

Expected: all 4 tests pass.

- [ ] **Step 5: Commit**

```
git add src/jsoncFilter.ts test/jsoncFilter.test.ts
git commit -m "feat(jsoncFilter): add parsePaths"
```

---

### Task 4: `jsoncFilter.ts` — `assertJsonc`

**Files:**
- Modify: [src/jsoncFilter.ts](../../src/jsoncFilter.ts)
- Modify: [test/jsoncFilter.test.ts](../../test/jsoncFilter.test.ts)

- [ ] **Step 1: Write the failing tests**

Append to [test/jsoncFilter.test.ts](../../test/jsoncFilter.test.ts):

```ts
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
```

- [ ] **Step 2: Run the tests, verify they fail**

```
npm run compile && npm run compile:test && node --test "out-test/test/jsoncFilter.test.js"
```

Expected: 5 new tests fail (exports don't exist yet).

- [ ] **Step 3: Implement `assertJsonc` and `JsoncFilterParseError`**

Append to [src/jsoncFilter.ts](../../src/jsoncFilter.ts):

```ts
export class JsoncFilterParseError extends Error {
    constructor(
        public readonly side: 'local' | 'remote',
        public readonly errors: ReadonlyArray<jsoncParser.ParseError>
    ) {
        super(`Failed to parse ${side} as JSONC: ${formatParseErrors(errors)}`);
        this.name = 'JsoncFilterParseError';
    }
}

const PARSE_OPTIONS: jsoncParser.ParseOptions = {
    disallowComments: false,
    allowTrailingComma: true,
    allowEmptyContent: false
};

/**
 * Throws JsoncFilterParseError if `text` is not parseable as JSONC (comments
 * and trailing commas allowed, empty input rejected).
 */
export function assertJsonc(text: string, side: 'local' | 'remote'): void {
    const errors: jsoncParser.ParseError[] = [];
    jsoncParser.parse(text, errors, PARSE_OPTIONS);
    if (errors.length > 0) {
        throw new JsoncFilterParseError(side, errors);
    }
}

function formatParseErrors(errors: ReadonlyArray<jsoncParser.ParseError>): string {
    if (errors.length === 0) return 'unknown error';
    return errors.map((e) => `${parseErrorCodeName(e.error)} at offset ${e.offset}`).join('; ');
}

function parseErrorCodeName(code: jsoncParser.ParseErrorCode): string {
    // jsonc-parser exports ParseErrorCode as a numeric enum. Map the few we care
    // about for nicer messages; fall back to the raw number otherwise.
    const names: Record<number, string> = {
        1: 'InvalidSymbol',
        2: 'InvalidNumberFormat',
        3: 'PropertyNameExpected',
        4: 'ValueExpected',
        5: 'ColonExpected',
        6: 'CommaExpected',
        7: 'CloseBraceExpected',
        8: 'CloseBracketExpected',
        9: 'EndOfFileExpected',
        10: 'InvalidCommentToken',
        11: 'UnexpectedEndOfComment',
        12: 'UnexpectedEndOfString',
        13: 'UnexpectedEndOfNumber',
        14: 'InvalidUnicode',
        15: 'InvalidEscapeCharacter',
        16: 'InvalidCharacter'
    };
    return names[code] ?? `ParseErrorCode(${code})`;
}
```

- [ ] **Step 4: Run the tests, verify they pass**

```
npm run compile && npm run compile:test && node --test "out-test/test/jsoncFilter.test.js"
```

Expected: all `assertJsonc` tests pass; `parsePaths` tests still pass.

- [ ] **Step 5: Commit**

```
git add src/jsoncFilter.ts test/jsoncFilter.test.ts
git commit -m "feat(jsoncFilter): add assertJsonc with comment/trailing-comma tolerance"
```

---

### Task 5: `jsoncFilter.ts` — `stripKeys`

**Files:**
- Modify: [src/jsoncFilter.ts](../../src/jsoncFilter.ts)
- Modify: [test/jsoncFilter.test.ts](../../test/jsoncFilter.test.ts)

- [ ] **Step 1: Write the failing tests**

Append to [test/jsoncFilter.test.ts](../../test/jsoncFilter.test.ts):

```ts
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
```

- [ ] **Step 2: Run the tests, verify they fail**

```
npm run compile && npm run compile:test && node --test "out-test/test/jsoncFilter.test.js"
```

Expected: 7 new tests fail (`stripKeys` doesn't exist).

- [ ] **Step 3: Implement `stripKeys`**

Append to [src/jsoncFilter.ts](../../src/jsoncFilter.ts):

```ts
const MODIFY_OPTIONS: jsoncParser.ModificationOptions = {
    formattingOptions: { tabSize: 4, insertSpaces: true }
};

/**
 * Returns `text` with every key at the given paths removed. Comments and
 * formatting on remaining keys are preserved. No-op when a path does not exist
 * in the input. Paths are processed deepest-first so that removing an outer
 * node does not invalidate positions still pointing inside it.
 */
export function stripKeys(text: string, paths: ReadonlyArray<KeyPath>): string {
    if (paths.length === 0) return text;

    const ordered = [...paths].sort((a, b) => b.length - a.length);
    let current = text;
    for (const path of ordered) {
        const edits = jsoncParser.modify(current, [...path], undefined, MODIFY_OPTIONS);
        if (edits.length === 0) continue;
        current = jsoncParser.applyEdits(current, edits);
    }
    return current;
}
```

- [ ] **Step 4: Run the tests, verify they pass**

```
npm run compile && npm run compile:test && node --test "out-test/test/jsoncFilter.test.js"
```

Expected: all `stripKeys` tests pass; earlier tests still pass.

- [ ] **Step 5: Commit**

```
git add src/jsoncFilter.ts test/jsoncFilter.test.ts
git commit -m "feat(jsoncFilter): add stripKeys with comment preservation"
```

---

### Task 6: `jsoncFilter.ts` — `mergeBack`

**Files:**
- Modify: [src/jsoncFilter.ts](../../src/jsoncFilter.ts)
- Modify: [test/jsoncFilter.test.ts](../../test/jsoncFilter.test.ts)

- [ ] **Step 1: Write the failing tests**

Append to [test/jsoncFilter.test.ts](../../test/jsoncFilter.test.ts):

```ts
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
```

- [ ] **Step 2: Run the tests, verify they fail**

```
npm run compile && npm run compile:test && node --test "out-test/test/jsoncFilter.test.js"
```

Expected: 8 new tests fail.

- [ ] **Step 3: Implement `mergeBack`**

Append to [src/jsoncFilter.ts](../../src/jsoncFilter.ts):

```ts
/**
 * Returns `candidateText` with every path's value reset to whatever
 * `destinationOriginal` holds at that same path:
 *   - destination has path → set candidate at path to destination's value
 *   - destination missing path → remove path from candidate (if present)
 *
 * Comments/formatting elsewhere in candidateText are preserved. Intermediate
 * objects are created in candidate as needed (jsonc-parser modify default).
 *
 * Paths are processed deepest-first to keep edit offsets stable.
 */
export function mergeBack(
    candidateText: string,
    destinationOriginal: string,
    paths: ReadonlyArray<KeyPath>
): string {
    if (paths.length === 0) return candidateText;

    const destTree = jsoncParser.parseTree(destinationOriginal, [], PARSE_OPTIONS);

    const ordered = [...paths].sort((a, b) => b.length - a.length);
    let current = candidateText;
    for (const path of ordered) {
        const destNode = destTree ? jsoncParser.findNodeAtLocation(destTree, [...path]) : undefined;
        const replacement = destNode ? jsoncParser.getNodeValue(destNode) : undefined;
        // `replacement === undefined` deletes the key in candidate via modify().
        const edits = jsoncParser.modify(current, [...path], replacement, MODIFY_OPTIONS);
        if (edits.length === 0) continue;
        current = jsoncParser.applyEdits(current, edits);
    }
    return current;
}
```

- [ ] **Step 4: Run the tests, verify they pass**

```
npm run compile && npm run compile:test && node --test "out-test/test/jsoncFilter.test.js"
```

Expected: all `mergeBack` tests pass, all earlier tests still pass.

- [ ] **Step 5: Commit**

```
git add src/jsoncFilter.ts test/jsoncFilter.test.ts
git commit -m "feat(jsoncFilter): add mergeBack for destination-side preservation"
```

---

### Task 7: Single-file sync integration

**Files:**
- Modify: [src/sync.ts](../../src/sync.ts) — `SyncSession`, `startSync`, `openDiff`, `confirmSync`
- Modify: [test/sync.test.ts](../../test/sync.test.ts) — add coverage for the strip+merge round-trip via the existing `decideSyncDirection`-style pure tests (limited; full flow is manual smoke)

- [ ] **Step 1: Add an `excludeKeys` field to `SyncSession`**

In [src/sync.ts](../../src/sync.ts), find the `SyncSession` interface (currently lines 15–28). Add the new field at the end of the interface:

```ts
interface SyncSession {
    direction: SyncDirection;
    profile: Profile;
    originalLocal: string;
    originalRemote: string;
    candidateUri: vscode.Uri;
    tempFiles: string[];
    editorCloseDisposable?: vscode.Disposable;
    externalResolver?: (outcome: SyncOutcome, candidateContent: string, direction: SyncDirection) => void;
    resolved?: boolean;
    excludeKeys: KeyPath[];
}
```

Add the import at the top of the file:

```ts
import { KeyPath, parsePaths, assertJsonc, stripKeys, mergeBack, JsoncFilterParseError } from './jsoncFilter';
```

- [ ] **Step 2: Update `startSync` to parse + assert + strip when filter is active**

In `SyncManager.startSync`, after reading `localContent` / `remoteContent` and computing `localMtime` / `remoteUpdateTime` (around lines 93–98), and **before** the `!localExists && !remoteExists` early return, insert:

```ts
const excludeKeys = parsePaths(Array.isArray(profile.excludeKeys) ? profile.excludeKeys : []);

let localForCompare = localContent;
let remoteForCompare = remoteContent;
if (excludeKeys.length > 0 && localExists && remoteExists) {
    try {
        assertJsonc(localContent, 'local');
        assertJsonc(remoteContent, 'remote');
    } catch (e) {
        if (e instanceof JsoncFilterParseError) {
            vscode.window.showErrorMessage(
                `Profile "${profile.name}" has excludeKeys but ${e.side} is not valid JSONC: ${e.message}`
            );
            return;
        }
        throw e;
    }
    localForCompare = stripKeys(localContent, excludeKeys);
    remoteForCompare = stripKeys(remoteContent, excludeKeys);
}
```

*Note on `localExists && remoteExists`:* if either side is missing, there is no diff to filter — we fall back to the existing path so a brand-new local/remote can still be created.

- [ ] **Step 3: Update the identical-check and the diff-open call sites**

Replace the existing identical check:

```ts
if (localExists && remoteExists && localContent === remoteContent) {
    vscode.window.showInformationMessage('Content is identical. No sync needed.');
    return;
}
```

with:

```ts
if (localExists && remoteExists && localForCompare === remoteForCompare) {
    const suffix = excludeKeys.length > 0 ? ' after exclude' : '';
    vscode.window.showInformationMessage(`Content is identical${suffix}. No sync needed.`);
    return;
}
```

Replace the `openDiff` call near the end of `startSync`:

```ts
await this.openDiff(profile, direction, localContent, remoteContent);
```

with:

```ts
await this.openDiff(profile, direction, localContent, remoteContent, { excludeKeys });
```

- [ ] **Step 4: Thread `excludeKeys` and the stripped texts through `openDiff`**

Extend the options bag of `openDiff` and the assignment of `this.currentSession`. Replace the existing `openDiff` signature/options:

```ts
private static async openDiff(
    profile: Profile,
    direction: SyncDirection,
    localContent: string,
    remoteContent: string,
    options: {
        externalResolver?: SyncSession['externalResolver'];
        skipDefaultPersist?: boolean;
        suppressInfoMessages?: boolean;
        excludeKeys?: KeyPath[];
    } = {}
): Promise<void> {
```

Inside `openDiff`, just before writing the left/right temp files, compute the stripped texts when filtering is active:

```ts
const excludeKeys = options.excludeKeys ?? [];
let leftContent = direction === 'download' ? localContent : remoteContent;
let rightContent = direction === 'download' ? remoteContent : localContent;
if (excludeKeys.length > 0) {
    // assertJsonc was already run upstream; safe to strip directly.
    leftContent = stripKeys(leftContent, excludeKeys);
    rightContent = stripKeys(rightContent, excludeKeys);
}
```

Then replace the `if (direction === 'download') { ... } else { ... }` block's temp-file writes (around lines 300–312) to use `leftContent` / `rightContent` instead of the raw `localContent` / `remoteContent`:

```ts
if (direction === 'download') {
    leftPath = path.join(os.tmpdir(), `local_${profile.name}_${stamp}${ext}`);
    rightPath = path.join(os.tmpdir(), `remote_${profile.name}_${stamp}${ext}`);
    fs.writeFileSync(leftPath, leftContent);
    fs.writeFileSync(rightPath, rightContent);
    title = `${profile.name}: Local ← Remote`;
} else {
    leftPath = path.join(os.tmpdir(), `remote_${profile.name}_${stamp}${ext}`);
    rightPath = path.join(os.tmpdir(), `local_${profile.name}_${stamp}${ext}`);
    fs.writeFileSync(leftPath, leftContent);
    fs.writeFileSync(rightPath, rightContent);
    title = `${profile.name}: Remote ← Local`;
}
```

When assigning `this.currentSession`, add `excludeKeys`:

```ts
this.currentSession = {
    direction,
    profile,
    originalLocal: localContent,   // STILL raw — that's what mergeBack needs
    originalRemote: remoteContent, // STILL raw
    candidateUri: rightUri,
    tempFiles: [leftPath, rightPath],
    editorCloseDisposable: this.registerEditorCloseListener(),
    externalResolver: options.externalResolver,
    resolved: false,
    excludeKeys
};
```

- [ ] **Step 5: Update `confirmSync` to `mergeBack` before persisting**

In `SyncManager.confirmSync`, locate the block that has just resolved `candidateContent`. Replace:

```ts
if (session.externalResolver) {
    this.resolveSession('confirmed', candidateContent);
} else {
    const localFilePath = this.resolvePath(session.profile.filePath);

    if (session.direction === 'download') {
        fs.writeFileSync(localFilePath, candidateContent);
        vscode.window.showInformationMessage(`Downloaded and saved to ${session.profile.filePath}`);
    } else {
        await DatabaseService.updateRecord(session.profile, candidateContent);
        fs.writeFileSync(localFilePath, candidateContent);
        vscode.window.showInformationMessage(`Uploaded ${session.profile.name} to database and updated local file.`);
    }
}
```

with:

```ts
const finalContent = this.applyMergeBack(session, candidateContent);

if (session.externalResolver) {
    this.resolveSession('confirmed', finalContent);
} else {
    const localFilePath = this.resolvePath(session.profile.filePath);

    if (session.direction === 'download') {
        fs.writeFileSync(localFilePath, finalContent);
        vscode.window.showInformationMessage(`Downloaded and saved to ${session.profile.filePath}`);
    } else {
        await DatabaseService.updateRecord(session.profile, finalContent);
        fs.writeFileSync(localFilePath, finalContent);
        vscode.window.showInformationMessage(`Uploaded ${session.profile.name} to database and updated local file.`);
    }
}
```

Add the helper method to `SyncManager` (place near the other private statics at the bottom of the class):

```ts
private static applyMergeBack(session: SyncSession, candidateContent: string): string {
    if (session.excludeKeys.length === 0) return candidateContent;
    const destinationOriginal = session.direction === 'download'
        ? session.originalLocal
        : session.originalRemote;
    return mergeBack(candidateContent, destinationOriginal, session.excludeKeys);
}
```

- [ ] **Step 6: Handle direction swap (`swapSyncDirection`) — already correct, but confirm**

`swapSyncDirection` cleans up the session and calls `openDiff(profile, newDirection, originalLocal, originalRemote, { ... })`. Add `excludeKeys: session.excludeKeys` to that options object so the re-opened diff also runs in filtered mode:

Locate the call inside `swapSyncDirection`:

```ts
await this.openDiff(profile, newDirection, originalLocal, originalRemote, {
    externalResolver,
    skipDefaultPersist: externalResolver !== undefined,
    suppressInfoMessages: externalResolver !== undefined
});
```

Capture `excludeKeys` before `cleanupSession` clears the session (i.e. read it from `session` before the `try`):

```ts
const { profile, originalLocal, originalRemote, externalResolver, excludeKeys } = session;
```

(That destructure is already there for the first four — extend it.)

Then pass `excludeKeys` into the `openDiff` call:

```ts
await this.openDiff(profile, newDirection, originalLocal, originalRemote, {
    externalResolver,
    skipDefaultPersist: externalResolver !== undefined,
    suppressInfoMessages: externalResolver !== undefined,
    excludeKeys
});
```

- [ ] **Step 7: `openDiffForExternal` is callable from multiSync — accept `excludeKeys` too**

In `SyncManager.openDiffForExternal`, extend the signature so multi-sync can opt in:

```ts
static openDiffForExternal(
    profile: Profile,
    direction: SyncDirection,
    localContent: string,
    remoteContent: string,
    excludeKeys: KeyPath[] = []
): Promise<{ outcome: SyncOutcome; candidateContent: string; direction: SyncDirection }> {
```

Inside, pass `excludeKeys` through to `openDiff`:

```ts
this.openDiff(profile, direction, localContent, remoteContent, {
    externalResolver: resolver,
    skipDefaultPersist: true,
    suppressInfoMessages: true,
    excludeKeys
}).catch(reject);
```

*Note:* `multiSync.ts` (next task) computes its own `mergeBack` after the diff resolves, because it already has the raw originals on hand. The single-sync `confirmSync` skips its own `mergeBack` whenever `session.externalResolver` is set (the external resolver receives the raw candidate, and the caller decides what to do). To enforce this clearly, adjust `applyMergeBack` so it returns the raw `candidateContent` whenever `session.externalResolver` is present:

```ts
private static applyMergeBack(session: SyncSession, candidateContent: string): string {
    if (session.externalResolver) return candidateContent; // caller will mergeBack
    if (session.excludeKeys.length === 0) return candidateContent;
    const destinationOriginal = session.direction === 'download'
        ? session.originalLocal
        : session.originalRemote;
    return mergeBack(candidateContent, destinationOriginal, session.excludeKeys);
}
```

- [ ] **Step 8: Compile and verify type-clean**

```
npm run compile
```

Expected: exits 0. If TS complains about missing fields in `SyncSession` construction sites elsewhere in the file, add `excludeKeys: []` to them.

- [ ] **Step 9: Run the full test suite to confirm no regression**

```
npm test
```

Expected: all existing tests pass. (sync.ts has only pure-logic tests on `decideSyncDirection`/`resolvePath` which are unaffected.)

- [ ] **Step 10: Commit**

```
git add src/sync.ts
git commit -m "feat(sync): integrate jsoncFilter strip+merge into single-file sync"
```

---

### Task 8: Multi-sync integration

**Files:**
- Modify: [src/multiSync.ts](../../src/multiSync.ts) — `MultiSyncItem`, `ItemView`, `buildItems`, `confirmOne`, `applySync`, `openDiffFor`, `confirmAll`, `markRemotePersisted`, `renderRow`

This is the highest-volume task. The structure of the multi-sync flow stays the same; the changes are surgical insertions of strip/mergeBack at the right boundaries.

- [ ] **Step 1: Extend types and imports**

At the top of [src/multiSync.ts](../../src/multiSync.ts), add the import:

```ts
import {
    KeyPath,
    parsePaths,
    assertJsonc,
    stripKeys,
    mergeBack,
    JsoncFilterParseError
} from './jsoncFilter';
```

Update `MultiSyncItem` to:

```ts
interface MultiSyncItem {
    profile: Profile;
    /** Stripped local content when excludeKeys is non-empty, otherwise === localOriginal. */
    localContent: string;
    /** Stripped remote content when excludeKeys is non-empty, otherwise === remoteOriginal. */
    remoteContent: string;
    /** Raw local content (with filtered keys present) — input to mergeBack. */
    localOriginal: string;
    /** Raw remote content (with filtered keys present) — input to mergeBack. */
    remoteOriginal: string;
    excludeKeys: KeyPath[];
    localExists: boolean;
    remoteExists: boolean;
    direction: SyncDirection;
    ambiguous: boolean;
    reason: string;
    added: number;
    removed: number;
    busy: boolean;
    remotePersisted: boolean;
    /** Set when excludeKeys is non-empty and either side fails to parse as JSONC. */
    parseError?: string;
    /**
     * Set during `confirmAll`'s phase 1 to the merged bytes that got committed
     * remotely; phase 2's local write reads it back. Cleared after each
     * `confirmAll` call (success or failure) and never read outside that flow.
     */
    _pendingFinalContent?: string;
}
```

Update `ItemView`:

```ts
interface ItemView {
    name: string;
    filePath: string;
    direction: SyncDirection;
    ambiguous: boolean;
    reason: string;
    added: number;
    removed: number;
    busy: boolean;
    localExists: boolean;
    remoteExists: boolean;
    remotePersisted: boolean;
    parseError?: string;
}
```

- [ ] **Step 2: Update `buildItems` to compute originals, excludeKeys, and parseError**

Replace the `return profiles.map(...)` block inside `buildItems` with:

```ts
return profiles.map((profile, idx) => {
    const { data: remoteData, updateTime: remoteUpdateTime } = remotes[idx];
    const absolutePath = SyncManager.resolvePath(profile.filePath);
    const localExists = fs.existsSync(absolutePath);
    let localOriginal = '';
    let localMtime: Date | null = null;
    if (localExists) {
        localOriginal = fs.readFileSync(absolutePath, 'utf-8');
        localMtime = fs.statSync(absolutePath).mtime;
    }
    const remoteExists = remoteData !== null;
    const remoteOriginal = remoteData ?? '';

    const excludeKeys = parsePaths(Array.isArray(profile.excludeKeys) ? profile.excludeKeys : []);

    let localContent = localOriginal;
    let remoteContent = remoteOriginal;
    let parseError: string | undefined;
    if (excludeKeys.length > 0 && localExists && remoteExists) {
        try {
            assertJsonc(localOriginal, 'local');
            assertJsonc(remoteOriginal, 'remote');
            localContent = stripKeys(localOriginal, excludeKeys);
            remoteContent = stripKeys(remoteOriginal, excludeKeys);
        } catch (e) {
            if (e instanceof JsoncFilterParseError) {
                parseError = `excludeKeys active but ${e.side} is not valid JSONC: ${e.message}`;
            } else {
                throw e;
            }
        }
    }

    const suggestion = SyncManager.decideSyncDirection(
        localExists,
        remoteExists,
        localMtime,
        remoteUpdateTime
    );

    const { added, removed } = this.computeDiffStats(
        localContent,
        remoteContent,
        suggestion.direction
    );

    return {
        profile,
        localContent,
        remoteContent,
        localOriginal,
        remoteOriginal,
        excludeKeys,
        localExists,
        remoteExists,
        direction: suggestion.direction,
        ambiguous: suggestion.ambiguous,
        reason: suggestion.reason,
        added,
        removed,
        busy: false,
        remotePersisted: false,
        parseError
    };
});
```

- [ ] **Step 3: Items with `parseError` must still appear in the panel**

The existing `actionable` filter in `start()` keeps any item that "(localExists || remoteExists) && needsSync(item)". Items with `parseError` should also appear so the user sees them — and `needsSync` should treat them as actionable.

Update `needsSync`:

```ts
private static needsSync(item: MultiSyncItem): boolean {
    if (!item.localExists && !item.remoteExists) return false;
    if (item.parseError) return true; // surface the row with its error
    if (item.localExists && item.remoteExists && item.localContent === item.remoteContent) {
        return false;
    }
    return true;
}
```

- [ ] **Step 4: Render parse-error rows with disabled buttons**

Update the `render()` projection to include `parseError`:

```ts
const view: ItemView[] = this.items.map((item) => ({
    name: item.profile.name,
    filePath: item.profile.filePath,
    direction: item.direction,
    ambiguous: item.ambiguous,
    reason: item.reason,
    added: item.added,
    removed: item.removed,
    busy: item.busy,
    localExists: item.localExists,
    remoteExists: item.remoteExists,
    remotePersisted: item.remotePersisted,
    parseError: item.parseError
}));
```

Replace `renderRow` with:

```ts
private static renderRow(item: ItemView, activeDiffProfile: string | null): string {
    const arrow = item.direction === 'download' ? 'Local ← Remote' : 'Remote ← Local';
    const ambiguousMark = item.ambiguous
        ? `<span class="ambiguous" title="${this.escapeHtml(item.reason)}">⚠</span>`
        : '';
    const persistedMark = item.remotePersisted
        ? `<span class="persisted" title="Remote is already committed; only the local file still needs writing.">remote committed</span>`
        : '';

    const hasError = !!item.parseError;
    const disabled = item.busy || hasError || (activeDiffProfile !== null && activeDiffProfile !== item.name);
    const diffDisabled = item.busy || hasError || activeDiffProfile !== null;
    const attr = (action: string, isDisabled: boolean) =>
        `data-action="${action}" data-profile="${this.escapeHtml(item.name)}" ${isDisabled ? 'disabled' : ''}`;

    const middleCells = hasError
        ? `<div class="parse-error" title="${this.escapeHtml(item.parseError!)}">⚠ ${this.escapeHtml(item.parseError!)}</div><div></div>`
        : `<div class="direction">${this.escapeHtml(arrow)}${ambiguousMark}</div>
           <div class="stats"><span class="added">+${item.added}</span><span class="removed">-${item.removed}</span></div>`;

    return `
<div class="row ${item.busy ? 'busy' : ''} ${hasError ? 'has-error' : ''}">
    <div>
        <div class="name">${this.escapeHtml(item.name)}${persistedMark}</div>
        <div class="path">${this.escapeHtml(item.filePath)}</div>
    </div>
    ${middleCells}
    <div></div>
    <div class="actions">
        <button ${attr('swap', disabled)} title="Flip sync direction">Swap</button>
        <button ${attr('diff', diffDisabled)}>Diff</button>
        <button class="primary" ${attr('confirm', disabled)}>Confirm</button>
    </div>
</div>`;
}
```

*Note on the grid:* the existing `.row` is `grid-template-columns: 1.2fr auto auto 1fr auto;`. The parse-error variant emits a single wide cell spanning what was direction+stats. To keep alignment, change the parse-error cell to span columns 2 and 3:

In the CSS (inside `renderHtml`), append:

```css
.parse-error {
    grid-column: 2 / span 2;
    color: var(--vscode-errorForeground);
    font-size: 0.9em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.row.has-error .direction, .row.has-error .stats { display: none; }
```

And simplify `middleCells` to always emit both pieces but let CSS hide the irrelevant ones:

```ts
const middleCells = `
    ${hasError
        ? `<div class="parse-error" title="${this.escapeHtml(item.parseError!)}">⚠ ${this.escapeHtml(item.parseError!)}</div>`
        : `<div class="direction">${this.escapeHtml(arrow)}${ambiguousMark}</div>
           <div class="stats"><span class="added">+${item.added}</span><span class="removed">-${item.removed}</span></div>`
    }`;
```

The `<div></div>` spacer column stays as-is.

- [ ] **Step 5: `confirmAll` filter out parse-error rows from the upload set**

Replace the existing `uploadsNeedingDb` line:

```ts
const uploadsNeedingDb = snapshot.filter(
    (i) => i.direction === 'upload' && !i.remotePersisted
);
```

with:

```ts
const uploadsNeedingDb = snapshot.filter(
    (i) => i.direction === 'upload' && !i.remotePersisted && !i.parseError
);
```

Also filter `snapshot` for phase 2's per-item local writes — items with `parseError` must not be written:

Replace:

```ts
for (const item of snapshot) {
    const localPath = SyncManager.resolvePath(item.profile.filePath);
    const content = item.direction === 'download' ? item.remoteContent : item.localContent;
    try {
        fs.writeFileSync(localPath, content);
        succeeded.push(item);
    } catch (e: any) {
        failed.push({ item, error: e?.message ?? String(e) });
    }
}
```

with:

```ts
for (const item of snapshot) {
    if (item.parseError) {
        // Stays visible with its error; not counted as success or failure.
        continue;
    }
    const localPath = SyncManager.resolvePath(item.profile.filePath);
    let content: string;
    if (item.direction === 'download') {
        content = item.excludeKeys.length > 0
            ? mergeBack(item.remoteContent, item.localOriginal, item.excludeKeys)
            : item.remoteContent;
    } else {
        // For uploads, phase 1 stashed the exact merged bytes; reuse them
        // so the local file matches what was committed remotely. Fall back
        // to recomputing if _pendingFinalContent is missing (defensive).
        content = item._pendingFinalContent
            ?? (item.excludeKeys.length > 0
                ? mergeBack(item.localContent, item.remoteOriginal, item.excludeKeys)
                : item.localContent);
    }
    try {
        fs.writeFileSync(localPath, content);
        succeeded.push(item);
    } catch (e: any) {
        failed.push({ item, error: e?.message ?? String(e) });
    } finally {
        item._pendingFinalContent = undefined;
    }
}
```

And in phase 1, swap the call to `DatabaseService.updateRecords` to use merged data:

Replace:

```ts
if (uploadsNeedingDb.length > 0) {
    try {
        await DatabaseService.updateRecords(
            uploadsNeedingDb.map((i) => ({ profile: i.profile, data: i.localContent }))
        );
        for (const u of uploadsNeedingDb) {
            this.markRemotePersisted(u, u.localContent);
        }
    } catch (error: any) {
        // ...
    }
}
```

with:

```ts
if (uploadsNeedingDb.length > 0) {
    try {
        const payloads = uploadsNeedingDb.map((i) => {
            const data = i.excludeKeys.length > 0
                ? mergeBack(i.localContent, i.remoteOriginal, i.excludeKeys)
                : i.localContent;
            i._pendingFinalContent = data;
            return { profile: i.profile, data };
        });
        await DatabaseService.updateRecords(payloads);
        for (const u of uploadsNeedingDb) {
            this.markRemotePersisted(u, u._pendingFinalContent!);
        }
    } catch (error: any) {
        for (const u of uploadsNeedingDb) u._pendingFinalContent = undefined;
        for (const it of this.items) it.busy = false;
        this.render();
        vscode.window.showErrorMessage(
            `Failed to commit uploads: ${error.message}. No changes were applied.`
        );
        return;
    }
}
```

Also exclude parse-error items from the disabled-all banner state by filtering when computing `disableAll` in `renderHtml`:

Replace:

```ts
const disableAll = items.some((i) => i.busy);
```

with:

```ts
const disableAll = items.some((i) => i.busy);
const allErrored = items.length > 0 && items.every((i) => i.parseError);
```

And the Confirm All button disabled condition:

Replace:

```ts
<button id="confirmAll" class="primary" ${disableAll || diffLocked || items.length === 0 ? 'disabled' : ''}>Confirm All (${items.length})</button>
```

with:

```ts
<button id="confirmAll" class="primary" ${disableAll || diffLocked || items.length === 0 || allErrored ? 'disabled' : ''}>Confirm All (${items.filter(i => !i.parseError).length})</button>
```

- [ ] **Step 6: `confirmOne` and `applySync` use mergeBack**

Replace `confirmOne`:

```ts
private static async confirmOne(name: string): Promise<void> {
    const item = this.findItem(name);
    if (!item || item.busy || item.parseError) return;

    const candidateStripped = item.direction === 'download' ? item.remoteContent : item.localContent;
    const candidateContent = item.excludeKeys.length > 0
        ? mergeBack(candidateStripped, item.direction === 'download' ? item.localOriginal : item.remoteOriginal, item.excludeKeys)
        : candidateStripped;

    item.busy = true;
    this.render();

    try {
        await this.applySync(item, candidateContent);
        this.removeItem(name);
        this.onItemsChanged(`Synced ${name}.`);
    } catch (error: any) {
        item.busy = false;
        this.render();
        vscode.window.showErrorMessage(`Failed to sync ${name}: ${error.message}`);
    }
}
```

`applySync` now takes already-merged content; no change to its body is required, but update its contract comment:

```ts
/**
 * Persist `candidateContent` for `item`. `candidateContent` is the FINAL
 * bytes (already mergeBack'd if filtering was active). On upload, skips
 * the DB write when remote already holds the same bytes (retry case).
 */
private static async applySync(item: MultiSyncItem, candidateContent: string): Promise<void> {
    // ... existing body unchanged ...
}
```

- [ ] **Step 7: `openDiffFor` passes excludeKeys to `openDiffForExternal` and merges on return**

Replace `openDiffFor`:

```ts
private static async openDiffFor(name: string): Promise<void> {
    const item = this.findItem(name);
    if (!item || item.busy || item.parseError) return;

    if (this.activeDiffProfile) {
        vscode.window.showWarningMessage('Another diff is currently open. Close it before opening another.');
        return;
    }

    this.activeDiffProfile = name;
    item.busy = true;
    this.render();

    try {
        const result = await SyncManager.openDiffForExternal(
            item.profile,
            item.direction,
            item.localContent,   // already stripped if filtering
            item.remoteContent,  // already stripped if filtering
            item.excludeKeys
        );

        this.activeDiffProfile = null;

        if (result.outcome === 'confirmed') {
            item.direction = result.direction;
            // The diff editor returned the stripped, possibly user-edited candidate.
            // mergeBack the destination side's originals to produce final bytes.
            const dest = result.direction === 'download' ? item.localOriginal : item.remoteOriginal;
            const finalContent = item.excludeKeys.length > 0
                ? mergeBack(result.candidateContent, dest, item.excludeKeys)
                : result.candidateContent;
            try {
                await this.applySync(item, finalContent);
                if (!this.panel) {
                    vscode.window.showInformationMessage(`Synced ${name}.`);
                    return;
                }
                this.removeItem(name);
                this.onItemsChanged(`Synced ${name}.`);
                return;
            } catch (error: any) {
                vscode.window.showErrorMessage(`Failed to persist ${name}: ${error.message}`);
            }
        }
    } finally {
        this.activeDiffProfile = null;
        if (this.panel) {
            const stillThere = this.findItem(name);
            if (stillThere) {
                stillThere.busy = false;
                this.render();
            }
        }
    }
}
```

- [ ] **Step 8: `markRemotePersisted` handles filtered mode**

Replace `markRemotePersisted`:

```ts
private static markRemotePersisted(item: MultiSyncItem, finalBytes: string): void {
    item.remoteOriginal = finalBytes;
    item.localOriginal = finalBytes;
    if (item.excludeKeys.length > 0) {
        // Stripped projection is invariant under merge: filtered keys are
        // exactly what was swapped in. Recompute defensively.
        const stripped = stripKeys(finalBytes, item.excludeKeys);
        item.localContent = stripped;
        item.remoteContent = stripped;
    } else {
        item.localContent = finalBytes;
        item.remoteContent = finalBytes;
    }
    item.remotePersisted = true;
    const stats = this.computeDiffStats(item.localContent, item.remoteContent, item.direction);
    item.added = stats.added;
    item.removed = stats.removed;
}
```

- [ ] **Step 9: `swapDirection` recomputes stats from stripped content (unchanged structurally)**

The existing `swapDirection` already calls `computeDiffStats(item.localContent, item.remoteContent, item.direction)`. With the new types, `localContent`/`remoteContent` are stripped, so the stats reflect post-filter differences. No code change required, but verify by re-reading.

- [ ] **Step 10: Compile and run all tests**

```
npm run compile && npm test
```

Expected: all existing tests pass. (The multi-sync tests in `test/multiSync.test.ts` rely on `MultiSyncManager`'s public surface; the new internal fields don't affect the existing test inputs because those profiles have no `excludeKeys`.)

If TS complains about missing `localOriginal` / `remoteOriginal` / `excludeKeys` in test fixtures inside `test/multiSync.test.ts`, those test fixtures construct `MultiSyncItem` shaped objects via the panel's `start()` method (not direct interface construction), so they should compile fine. If any direct construction exists, supplement those literals with the new fields.

- [ ] **Step 11: Commit**

```
git add src/multiSync.ts
git commit -m "feat(multiSync): integrate jsoncFilter strip+merge with parse-error row state"
```

---

### Task 9: Settings webview integration

**Files:**
- Modify: [src/settingsWebview.ts](../../src/settingsWebview.ts) — modal Advanced section, profile list badge, save handler

- [ ] **Step 1: Add the textarea to the modal HTML**

In [src/settingsWebview.ts](../../src/settingsWebview.ts), find `SETTINGS_BODY`. Inside the `<form id="profileModal">` body (`.ns-modal__body`), after the Table Name form-row block and **before** the `<p class="ns-status ns-status--error" id="pmFormError" hidden></p>` line, insert:

```html
<details class="ns-advanced" id="pmAdvancedDetails">
    <summary class="ns-advanced__summary">Advanced</summary>
    <div class="ns-form-row">
        <label class="ns-label" for="pmExcludeKeys">Exclude keys (one per line, JSON/JSONC only)</label>
        <textarea class="ns-input ns-input--textarea" id="pmExcludeKeys" rows="4" autocomplete="off" spellcheck="false" placeholder="editor.fontSize&#10;workbench.colorTheme"></textarea>
        <p class="ns-hint">Paths use dot-separators (e.g. <code>a.b.c</code>). Filtered keys are hidden from the diff and preserved as-is on the target side at confirm time.</p>
        <p class="ns-hint" id="pmExcludeKeysExtWarning" hidden>Exclude keys only apply to JSON/JSONC files. The current path doesn't end in <code>.json</code> or <code>.jsonc</code> — filtering will only run if the file parses as JSONC at sync time.</p>
    </div>
</details>
```

- [ ] **Step 2: Add CSS for the Advanced section and textarea**

In `SETTINGS_CSS`, append:

```css
.ns-advanced { margin-top: 6px; }
.ns-advanced__summary {
    cursor: pointer;
    font-size: 12px;
    font-weight: 600;
    padding: 6px 0;
    color: var(--vscode-descriptionForeground);
    user-select: none;
}
.ns-advanced__summary:hover { color: var(--vscode-foreground); }
.ns-advanced[open] > .ns-advanced__summary { margin-bottom: 6px; }
.ns-input--textarea {
    width: 100%;
    min-height: 80px;
    resize: vertical;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.95em;
    line-height: 1.4;
}
```

- [ ] **Step 3: Wire textarea read/write into the modal script**

In `SETTINGS_SCRIPT`, extend `els` with the new elements (find the `els` object at the top):

```js
const els = {
    // ...existing...
    pmExcludeKeys: $('pmExcludeKeys'),
    pmExcludeKeysExtWarning: $('pmExcludeKeysExtWarning'),
    pmAdvancedDetails: $('pmAdvancedDetails')
};
```

Add a parsing helper near the top of the IIFE (before the connection-field block):

```js
function parseExcludeKeysFromTextarea(raw) {
    const seen = new Set();
    const out = [];
    for (const line of (raw || '').split('\\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (seen.has(trimmed)) continue;
        seen.add(trimmed);
        out.push(trimmed);
    }
    return out;
}

function hasJsoncExtension(p) {
    return /\\.(json|jsonc)$/i.test((p || '').trim());
}

function maybeShowExcludeWarning() {
    const hasKeys = parseExcludeKeysFromTextarea(els.pmExcludeKeys.value).length > 0;
    const looksLikeJson = hasJsoncExtension(els.pmFilePath.value);
    els.pmExcludeKeysExtWarning.hidden = !(hasKeys && !looksLikeJson);
}
```

In `readModalValues`:

```js
function readModalValues() {
    return {
        name: els.pmName.value,
        filePath: els.pmFilePath.value,
        id: els.pmId.value,
        tableName: els.pmTableName.value,
        excludeKeys: parseExcludeKeysFromTextarea(els.pmExcludeKeys.value)
    };
}
```

In `openProfileModal(existing)`:

```js
function openProfileModal(existing) {
    state.editingOriginalName = existing ? existing.name : null;
    state.modalDirty = false;
    els.modalTitle.textContent = existing ? 'Edit profile' : 'Add profile';
    els.pmName.value = existing ? existing.name : '';
    els.pmFilePath.value = existing ? existing.filePath : '';
    els.pmId.value = existing ? existing.id : '';
    els.pmTableName.value = existing ? existing.tableName : 'json_records';
    const existingExcludes = existing && Array.isArray(existing.excludeKeys) ? existing.excludeKeys : [];
    els.pmExcludeKeys.value = existingExcludes.join('\\n');
    els.pmAdvancedDetails.open = existingExcludes.length > 0;
    maybeShowExcludeWarning();
    clearFormErrors();
    els.modalBackdrop.hidden = false;
    setTimeout(() => els.pmName.focus(), 0);
}
```

Mark dirty + re-check warning on textarea input:

```js
for (const input of [els.pmName, els.pmFilePath, els.pmId, els.pmTableName, els.pmExcludeKeys]) {
    input.addEventListener('input', () => { state.modalDirty = true; });
}
els.pmExcludeKeys.addEventListener('input', maybeShowExcludeWarning);
els.pmFilePath.addEventListener('input', maybeShowExcludeWarning);
```

- [ ] **Step 4: Host-side: accept `excludeKeys` in `_handleSaveProfile`**

In the `SettingsPanel` class, update `_handleSaveProfile`. The current implementation builds a `ProfileFormValues` then a `cleaned: Profile` — extend the cleaned object with normalized `excludeKeys`. Replace the entire `_handleSaveProfile` method body:

```ts
private async _handleSaveProfile(message: SaveProfileMessage): Promise<unknown> {
    const profiles = ConfigManager.getProfiles();
    const incoming = message.profile ?? ({} as Partial<Profile>);
    const values: ProfileFormValues = {
        name: typeof incoming.name === 'string' ? incoming.name : '',
        filePath: typeof incoming.filePath === 'string' ? incoming.filePath : '',
        id: typeof incoming.id === 'string' ? incoming.id : '',
        tableName: typeof incoming.tableName === 'string' ? incoming.tableName : ''
    };
    const errors = validateProfileForm(values, {
        existingNames: profiles.map((p) => p.name),
        originalName: message.originalName
    });
    if (hasErrors(errors)) {
        return { command: 'profileSaveError', errors, originalName: message.originalName };
    }
    const rawExcludes = Array.isArray((incoming as any).excludeKeys) ? (incoming as any).excludeKeys : [];
    const excludeKeys = this._normalizeExcludeKeys(rawExcludes);
    const cleaned: Profile = {
        name: values.name.trim(),
        filePath: values.filePath.trim(),
        id: values.id.trim(),
        tableName: values.tableName.trim()
    };
    if (excludeKeys.length > 0) cleaned.excludeKeys = excludeKeys;
    const next: Profile[] = message.originalName !== undefined
        ? profiles.map((p) => (p.name === message.originalName ? cleaned : p))
        : [...profiles, cleaned];
    await ConfigManager.saveProfiles(next);
    return { command: 'profilesSaved', profiles: next };
}

private _normalizeExcludeKeys(raw: unknown[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const entry of raw) {
        if (typeof entry !== 'string') continue;
        const trimmed = entry.trim();
        if (!trimmed) continue;
        if (seen.has(trimmed)) continue;
        seen.add(trimmed);
        out.push(trimmed);
    }
    return out;
}
```

- [ ] **Step 5: Profile list — show `excludes N keys` badge**

In `SETTINGS_SCRIPT`, find `renderProfiles`. Replace the `metaEl.textContent = ...` line:

```js
const excludeCount = Array.isArray(profile.excludeKeys) ? profile.excludeKeys.length : 0;
const excludeBadge = excludeCount > 0
    ? '  ·  excludes ' + excludeCount + (excludeCount === 1 ? ' key' : ' keys')
    : '';
metaEl.textContent = profile.filePath + '  ·  ' + profile.tableName + excludeBadge;
metaEl.title = metaEl.textContent;
```

- [ ] **Step 6: Compile and smoke-launch**

```
npm run compile
```

Expected: exits 0.

Launch the extension dev host:
- Open the project in VS Code.
- Press F5 (Run Extension).
- In the dev host, run `Neon Sync: Open Settings`.
- Click `+ Add` → fill name `Test`, filePath `test.json`, id `t`, tableName `json_records`.
- Expand `Advanced`, paste:
  ```
  editor.fontSize
  workbench.colorTheme
  ```
- Save. Verify the profile card meta line shows `test.json  ·  json_records  ·  excludes 2 keys`.
- Edit the profile and confirm the Advanced section auto-opens with the two paths populated.
- Change filePath to `test.txt`, observe the inline warning under the textarea.

(If the smoke test fails on any of these, fix and re-smoke before committing.)

- [ ] **Step 7: Commit**

```
git add src/settingsWebview.ts
git commit -m "feat(settings): add Advanced excludeKeys textarea and profile list badge"
```

---

### Task 10: README docs + final integration smoke test

**Files:**
- Modify: [README.md](../../README.md)

- [ ] **Step 1: Add a "Filtering keys" subsection under Configuration**

In [README.md](../../README.md), find the `### 3. Editing the JSON directly` section. **After** its example `neon-sync.json` snippet (the closing ```), insert:

```markdown
### 4. Filtering keys (JSON/JSONC only)

For JSON/JSONC profiles you can list keys that should be hidden from the diff and preserved on the target side on confirm. This is useful for machine-specific or transient keys (themes, machine IDs, locally chosen font sizes) that you don't want propagating across machines.

Add `excludeKeys` to a profile (via the settings panel's Add/Edit modal → Advanced, or by editing `neon-sync.json` directly):

```json
{
    "profiles": [
        {
            "name": "VS Code Settings",
            "filePath": ".vscode/settings.json",
            "id": "vscode-settings",
            "tableName": "json_records",
            "excludeKeys": [
                "editor.fontSize",
                "workbench.colorTheme",
                "telemetry.machineId"
            ]
        }
    ]
}
```

Path syntax (v1):

- Dot-separated string. `a.b.c` addresses `{ "a": { "b": { "c": ... } } }`.
- Multiple paths supported; multi-level paths supported.
- Wildcards (`a.*.b`), array indices, and keys containing literal dots are not supported in this release.

Behavior:

- **Diff view**: both sides are shown with the listed keys removed. Comments and formatting on remaining keys are preserved.
- **Identical check**: if the only differences are filtered keys, the sync is treated as "already in sync" and skipped.
- **Confirm**: the target side's current values for the filtered keys are spliced back in before writing. Locally edited values for filtered keys in the diff editor are also overwritten with the target's values (since these keys are "owned" by the target).
- **Parse failure**: if either side does not parse as JSONC (comments and trailing commas allowed), the sync is aborted with an error. The multi-profile panel keeps the row visible with an inline error.
- **No filter**: profiles without `excludeKeys` (or with an empty list) behave exactly as before — pure raw-text sync.
```

- [ ] **Step 2: Final end-to-end smoke test**

Run the dev host (F5) and exercise both flows:

**Single-file sync:**
1. Create a local file `test.jsonc`:
   ```jsonc
   // Settings file
   {
       "editor.fontSize": 14,
       "workbench.colorTheme": "Light+",
       "shared": "local-value"
   }
   ```
2. Create a profile pointing at it, with `excludeKeys` = `["editor.fontSize", "workbench.colorTheme"]`.
3. Manually insert a row into your Postgres database for that profile's ID with:
   ```jsonc
   // Server settings
   {
       "editor.fontSize": 20,
       "workbench.colorTheme": "Dark+",
       "shared": "remote-value"
   }
   ```
4. Run `Neon Sync: Sync File` → pick the profile.
5. Verify the diff shows only `shared` on both sides (`"shared": "local-value"` vs `"shared": "remote-value"`). The two filtered keys must NOT appear.
6. Confirm in the direction that downloads (or uploads, doesn't matter). Re-open the file.
7. Verify the filtered keys retained their local values (if download), or remote retained its values (if upload). The `shared` key flipped to match the candidate.

**Multi-sync:**
1. Add a second profile with no `excludeKeys`. Edit the local file so both have pending diffs.
2. Run `Neon Sync: Sync File` → `Sync Multiple Profiles…` → select both.
3. In the panel, the filtered profile's +added/−removed should reflect only the `shared` key's diff (line counts of 1/1 or 0/0).
4. Click `Confirm All`. Verify the filtered profile's filtered keys are preserved on the target side.

**Parse-error scenario:**
1. Set a profile with `excludeKeys` to point at a non-JSON file like a `.env`.
2. Run single sync → expect the error toast and the sync aborts.
3. Run multi-sync → expect the row to appear with the inline `⚠ excludeKeys active but local is not valid JSONC: …` and disabled buttons.

If any smoke check fails, fix the issue and re-smoke before committing.

- [ ] **Step 3: Run the full test suite once more**

```
npm test
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```
git add README.md
git commit -m "docs: document excludeKeys filtering for JSON/JSONC profiles"
```

- [ ] **Step 5: Final review and CHANGELOG (optional)**

If there's a CHANGELOG.md, add an entry under the next-version heading:

```markdown
### Added
- Per-profile `excludeKeys` for JSON/JSONC profiles. Listed keys are hidden from the diff view and preserved on the target side at confirm time. Edit via the settings panel's Advanced section or directly in `neon-sync.json`.
```

```
git add CHANGELOG.md
git commit -m "docs: changelog entry for excludeKeys"
```

---

## Verification checklist (run after all tasks)

- [ ] `npm test` passes
- [ ] `npm run compile` exits 0 (no TS errors anywhere)
- [ ] Manual smoke: single-sync filter hides keys, confirm preserves target-side values
- [ ] Manual smoke: multi-sync filter same; parse-error row visible with disabled buttons
- [ ] Manual smoke: profile list shows `excludes N keys` badge, Edit modal re-opens with paths
- [ ] Profiles without `excludeKeys` unaffected (regression check on at least one untouched profile)
- [ ] `neon-sync.json` does not gain an empty `excludeKeys: []` field for profiles that never used the feature

## Notes for the implementer

- The `jsonc-parser` library is **synchronous and pure** — no Promises, no I/O. The strip/merge functions are cheap to call repeatedly. Don't bother memoizing inside `jsoncFilter.ts`.
- When `modify()` is asked to delete a path that doesn't exist, it returns an empty edits array. The implementations rely on this — don't pre-check with `findNodeAtLocation` (extra work).
- `getNodeValue()` recursively materializes a Node into a JS value. For very large nested structures this is `O(n)` in node count. Filtered keys are typically scalars or small objects, so this is fine.
- VS Code's `vscode.diff` editor reads the temp files we write. Don't change `tempFiles` lifecycle or close-detection logic — only the *content* of those files changes when filtering is active.
- The `SyncSession.originalLocal` and `originalRemote` fields are *raw* in both filtered and unfiltered mode. This is what makes swap-direction work without re-parsing — `openDiff` always receives raw content and strips on the way in.
- `MultiSyncItem._pendingFinalContent` is the only transient field on the item; clear it at the end of each `confirmAll` regardless of outcome (the `finally` block in phase 2's loop does this). Don't read it outside `confirmAll`.
