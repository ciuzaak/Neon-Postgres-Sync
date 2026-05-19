# Key Filtering for JSON/JSONC Sync — Design

Date: 2026-05-19
Status: Draft (pending user review)

## Goal

Let users specify per-profile JSON key paths that should be hidden from the diff view and preserved on the target side when syncing JSON/JSONC files, so that machine-specific, transient, or otherwise uninteresting keys (timestamps, locally chosen themes, machine IDs) do not pollute every sync's diff or get propagated across machines.

## Scope

A single new feature spanning config schema, settings UI, sync flow (single + multi), and a small new pure-function module:

1. Add an optional `excludeKeys: string[]` field to each profile in `neon-sync.json`.
2. Surface it in the settings webview's Add/Edit Profile modal as a collapsible "Advanced" textarea.
3. Apply filtering in both single-file sync (`src/sync.ts`) and multi-profile sync (`src/multiSync.ts`):
   - **Diff display**: both sides are shown with filtered keys stripped, comments/formatting otherwise preserved.
   - **Identical check**: compared after stripping.
   - **Write-back on confirm**: the candidate side's edited text is merged with the *target* side's original values for the filtered keys, so those keys are preserved across the sync.
4. New module `src/jsoncFilter.ts` housing pure strip/merge functions built on `jsonc-parser`.
5. New runtime dependency: `jsonc-parser` (MIT, ~50 KB, zero transitive deps, used by VS Code itself).

## Non-goals

- No wildcards, array indices, or escaped-dot syntax in v1. Paths are `a.b.c` style only. Keys containing literal dots are not addressable in v1.
- No automatic detection of which keys to filter (no "ignore changes" heuristic).
- No backwards-compatibility migration: `excludeKeys` is purely additive; profiles without the field behave exactly as today.
- No change to the auto-direction logic, the ambiguous-timestamp prompt, or the swap-direction flow.
- No change to non-JSON sync paths.

---

## Part 1 — Config schema

`Profile` (in `src/config.ts`) gains an optional `excludeKeys`:

```ts
export interface Profile {
    name: string;
    filePath: string;
    id: string;
    tableName: string;
    excludeKeys?: string[];
}
```

Example `neon-sync.json`:

```jsonc
{
    "profiles": [
        {
            "name": "Antigravity",
            "filePath": "settings.json",
            "id": "antigravity-settings",
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

Serialization rule in `ConfigManager.saveProfiles`: when persisting, drop the `excludeKeys` field entirely if it is missing, `undefined`, or an empty array. This keeps `neon-sync.json` clean for users who never use the feature.

### Path syntax (v1)

- Dot-separated string. `"a.b.c"` represents the path `["a", "b", "c"]`.
- Trimmed before use; empty strings are ignored.
- Duplicates are deduplicated.
- A path may target a value of any JSON type (object, array, string, number, boolean, null). For nested paths, intermediate segments must address objects; addressing through an array element by numeric key is not supported in v1.
- Keys that contain a literal dot cannot be represented in v1. We will document this limitation and reserve `\.` as future escape syntax / `[ ... ]` JSON-array form as future "long-form".

---

## Part 2 — Settings webview UI

The Add/Edit Profile modal in `src/settingsWebview.ts` (`SETTINGS_BODY` → `profileModal`) gains one new collapsible section, placed **after** the existing four fields and **before** the form-error line.

### Layout

```
┌─ Modal: Add/Edit profile ──────────────────────────┐
│ Name *           [ ......................... ]     │
│ Local File Path* [ ......................... ] [Browse…] │
│ Record ID *      [ ......................... ]     │
│ Table Name *     [ json_records ............ ]     │
│                                                     │
│ ▸ Advanced (collapsed by default)                  │
│                                                     │
│ — when expanded: —                                 │
│ ▾ Advanced                                          │
│   Exclude keys (one per line, JSON/JSONC only)      │
│   ┌─────────────────────────────────────────────┐  │
│   │ editor.fontSize                             │  │
│   │ workbench.colorTheme                        │  │
│   │ telemetry.machineId                         │  │
│   │                                             │  │
│   │                                             │  │
│   └─────────────────────────────────────────────┘  │
│   Paths use dot-separators (e.g. a.b.c). Filtered  │
│   keys are hidden from diff and kept as-is on the  │
│   target side on confirm.                          │
│                                                     │
│         [ Cancel ]              [ Save ]            │
└─────────────────────────────────────────────────────┘
```

The collapsible uses a native `<details>` / `<summary>` pair so no extra JS state is required; CSS styles `summary` to match the existing modal typography.

### Profile list card

When a profile has a non-empty `excludeKeys`, its row in the Profiles list (the `.ns-profile-card__meta` line) gains a small inline badge:

```
Antigravity
settings.json  ·  json_records  ·  excludes 3 keys
```

The badge is plain text (no separate DOM styling) so it inherits `.ns-profile-card__meta` color. Singular/plural: `excludes 1 key` / `excludes N keys`.

### Form wiring

- New textarea id: `pmExcludeKeys`. Lives inside `<details id="pmAdvancedDetails">` so it stays in the DOM (we read its value on submit even when collapsed).
- `readModalValues()` adds `excludeKeys: parseLines(els.pmExcludeKeys.value)`, where `parseLines` is the webview-local helper: split on `\n`, trim each, drop empties, dedupe. The textarea is sent as a normalized array; the host side does not need to re-parse newlines.
- `openProfileModal(existing)` populates the textarea by joining `existing.excludeKeys` with `\n`. Auto-expands the `<details>` if the list is non-empty so users see it immediately when editing an existing filter.
- `state.modalDirty` covers the textarea via the same `input` handler.
- No inline validation rule on individual lines beyond trim/dedupe — invalid path segments are surfaced at sync time (Part 4) rather than at edit time, because validity depends on the actual JSON on each side.

### Soft warning on extension mismatch

When the modal is submitted with a non-empty `excludeKeys` but `filePath` doesn't end in `.json` / `.jsonc` (case-insensitive), a non-blocking inline hint appears under the textarea:

> `Exclude keys only apply to JSON/JSONC files. The current path doesn't end in .json or .jsonc — filtering will only run if the file parses as JSONC at sync time.`

The save still goes through. The user might have configured a custom VS Code file association, and the runtime check in Part 4 is the source of truth.

---

## Part 3 — `src/jsoncFilter.ts` (new module)

Pure-function module. No `vscode` imports. Easily unit-testable.

### API

```ts
import * as jsoncParser from 'jsonc-parser';

export type KeyPath = ReadonlyArray<string>;

export class JsoncFilterParseError extends Error {
    constructor(public readonly side: 'local' | 'remote', public readonly errors: jsoncParser.ParseError[]) {
        super(`Failed to parse ${side} as JSONC: ${formatErrors(errors)}`);
    }
}

/** Convert raw textarea lines / JSON-array config to internal KeyPath[]. Trims, drops empty, dedupes. */
export function parsePaths(raw: string[]): KeyPath[];

/** Throws JsoncFilterParseError if text isn't valid JSONC (with comments + trailing commas allowed). */
export function assertJsonc(text: string, side: 'local' | 'remote'): void;

/** Returns text with the given key paths removed. Preserves comments/format on remaining keys. */
export function stripKeys(text: string, paths: KeyPath[]): string;

/**
 * Returns `candidateText` with every `path` set to the value `destinationOriginal` holds at that path:
 *   - destination has path → set candidate at path to destination's value
 *   - destination missing path → remove path from candidate (if present)
 * Preserves formatting/comments in candidateText elsewhere.
 */
export function mergeBack(candidateText: string, destinationOriginal: string, paths: KeyPath[]): string;
```

### Implementation notes

- **Parse tolerance**: use `jsoncParser.parse(text, errors, { allowTrailingComma: true, disallowComments: false })`. Filter the `errors` array to only fatal entries (anything that isn't an "InvalidCommentToken" / "TrailingComma" in strict mode — but with both flags above, jsonc-parser already suppresses those). Treat any remaining entry as fatal.
- **Strip**: for each path, call `jsoncParser.modify(text, path, undefined, { formattingOptions })` (passing `undefined` deletes the node), then `applyEdits` and feed the result into the next iteration. Order paths by depth descending to avoid invalidating positions when an outer node is removed first; for paths at the same depth, original input order is fine.
- **Merge**: for each path, call `jsoncParser.findNodeAtLocation(jsoncParser.parseTree(destinationOriginal), [...path])`. If found, pass `node`-derived JS value to `modify(candidateText, path, value, ...)`. If not found, call `modify(candidateText, path, undefined, ...)` to delete from candidate. Apply edits sequentially.
- **Formatting options**: pass `{ tabSize: 4, insertSpaces: true }`. Even if the file uses tabs, jsonc-parser only uses this for *newly inserted* lines (which only happens in `mergeBack` when destination has a key the candidate's edited text lacks). The vast majority of edits are value-only and preserve the surrounding whitespace verbatim.
- **Edge: nested re-construction**: if `destinationOriginal` has `a.b.c = 1` but `candidateText` doesn't have `a`, `modify(candidateText, ["a","b","c"], 1, ...)` will (per jsonc-parser docs) create intermediate objects. We rely on this behavior and document it.
- **Edge: filter key targets a non-object intermediate**: if any intermediate segment in `candidateText` (or `destinationOriginal`) addresses through a non-object (e.g. user filtered `a.b` but `a` is a string), `jsoncParser.findNodeAtLocation` returns `undefined`. We treat it as "not present" — the merge step deletes from candidate (if it was somehow there). No error is raised; this is the natural extension of the "path missing" case.

---

## Part 4 — Sync flow integration

### `src/sync.ts` — single-file sync

`SyncSession` gains two fields:

```ts
interface SyncSession {
    // ...existing fields...
    excludeKeys: KeyPath[];          // empty when feature inactive
    originalLocal: string;            // ALREADY EXISTS — keep semantics: raw file
    originalRemote: string;           // ALREADY EXISTS — keep semantics: raw DB
    // candidate file (rightUri) now contains *stripped* content when excludeKeys is non-empty
}
```

`startSync` flow changes (the only structural changes; everything else stays):

1. After fetching `remoteContent` and reading `localContent`, compute `excludeKeys = parsePaths(profile.excludeKeys ?? [])`.
2. If `excludeKeys.length > 0`:
   - Call `assertJsonc(localContent, 'local')` and `assertJsonc(remoteContent, 'remote')`. On `JsoncFilterParseError`, show the error message via `vscode.window.showErrorMessage` and `return`.
   - Compute `localStripped = stripKeys(localContent, excludeKeys)` and `remoteStripped = stripKeys(remoteContent, excludeKeys)`.
3. Identical check uses `localStripped === remoteStripped` when filtering is active; otherwise the current `localContent === remoteContent`.
4. `decideSyncDirection` continues to use `localMtime` and `remoteUpdateTime` (mtime/update_time stay raw — they reflect the actual file/row, not the stripped view).
5. `openDiff` writes `localStripped` / `remoteStripped` to its temp files (left/right) when filtering is active, otherwise the raw content. `SyncSession.originalLocal` and `originalRemote` always hold the raw content; this is what `mergeBack` needs at confirm time.

`swapSyncDirection` — `originalLocal` / `originalRemote` already hold raw content, so the re-open just runs the same stripping over them again. No special swap handling needed.

`confirmSync` flow:

1. Read `candidateContent` from the right-side editor / disk as today (this is *stripped* text when filtering is active).
2. If `session.excludeKeys.length > 0`:
   - `destinationOriginal = session.direction === 'download' ? session.originalLocal : session.originalRemote`.
   - `finalContent = mergeBack(candidateContent, destinationOriginal, session.excludeKeys)`.
3. Otherwise `finalContent = candidateContent` (current behavior).
4. Pass `finalContent` to the existing persistence branches (`fs.writeFileSync` for download, `DatabaseService.updateRecord` + local write for upload).

Identical-after-filter UX: when step 3 in `startSync` short-circuits, the existing `vscode.window.showInformationMessage('Content is identical. No sync needed.')` is replaced with `'Content is identical after exclude. No sync needed.'` when `excludeKeys.length > 0`.

### `src/multiSync.ts` — multi-profile sync

`MultiSyncItem` gains:

```ts
interface MultiSyncItem {
    // ...existing fields...
    excludeKeys: KeyPath[];
    // localContent / remoteContent now hold STRIPPED text when excludeKeys is non-empty
    localOriginal: string;     // NEW: raw local content (used by mergeBack)
    remoteOriginal: string;    // NEW: raw remote content (used by mergeBack)
    parseError?: string;       // NEW: if filtering activated but a side fails to parse
}
```

`buildItems` changes per profile:

1. Compute `excludeKeys = parsePaths(profile.excludeKeys ?? [])`.
2. If `excludeKeys.length > 0`:
   - Try `assertJsonc` on both sides. On failure, record `parseError` and leave `localContent` / `remoteContent` equal to their originals (so the row can render an error state, see below).
   - On success, set `localContent = stripKeys(localOriginal, excludeKeys)` and similarly for remote.
3. If `excludeKeys.length === 0`, `localContent === localOriginal` and `remoteContent === remoteOriginal`.

After-build filtering:

- `needsSync(item)` continues to compare `item.localContent` vs `item.remoteContent` (now stripped). Items where filtering hides the only differences are correctly skipped by the existing "already in sync" path.
- Items with `parseError` set are not silently skipped: they appear in the actionable list with a `⚠ JSONC parse error: <msg>` line in place of the `+added/-removed` stats, and their `Confirm` / `Diff` buttons are disabled. `Swap` is also disabled. `Confirm All` excludes them and reports the count.
- `computeDiffStats` runs on stripped content unchanged.

`swapDirection` unchanged (stripped content doesn't depend on direction).

`openDiffFor` — pass `item.localContent` / `item.remoteContent` (stripped) to `SyncManager.openDiffForExternal`. The diff session is constructed with these stripped strings as its `originalLocal`/`originalRemote`, *not* the raw originals. This means `SyncManager` does not need to know `excludeKeys` for the external case; instead, `multiSync.ts` does its own `mergeBack` at confirm time.

Specifically: `openDiffForExternal` returns `candidateContent` (stripped, potentially edited by user). `multiSync.ts` then runs:

```ts
if (item.excludeKeys.length > 0) {
    const dest = result.direction === 'download' ? item.localOriginal : item.remoteOriginal;
    finalContent = mergeBack(result.candidateContent, dest, item.excludeKeys);
} else {
    finalContent = result.candidateContent;
}
await this.applySync(item, finalContent);
```

`applySync(item, candidateContent)` is repurposed: `candidateContent` is the already-merged text ready for persistence. Internal logic unchanged otherwise.

`confirmOne` mirrors this: the candidate is `direction === 'download' ? item.remoteContent : item.localContent` (stripped), and if `excludeKeys.length > 0` we run `mergeBack` against the appropriate `*Original` before calling `applySync`.

`confirmAll` phase 1 (DB batch upload):

- Filter `uploadsNeedingDb` further: items with `parseError` are excluded (already excluded from the panel's actionable list, but defensive).
- For each upload item with non-empty `excludeKeys`, compute its `finalUploadContent = mergeBack(item.localContent, item.remoteOriginal, item.excludeKeys)` *before* calling `DatabaseService.updateRecords`. Pass `finalUploadContent` as the `data` field. Items without filtering pass `item.localContent` as today.
- Stash `finalUploadContent` on the item as a transient `_pendingFinalContent: string` for phase 2 to pick up. (Items without filtering: `_pendingFinalContent = item.localContent`.) Field is cleared at the end of `confirmAll` regardless of outcome.
- After successful commit, call `markRemotePersisted(item, finalUploadContent)` (see below for the filtered-mode extension).

Phase 2 (per-item local writes): for each item, the bytes written to the local file are:

- Download: `mergeBack(item.remoteContent, item.localOriginal, item.excludeKeys)` if filtering active, else `item.remoteContent`. (Downloads aren't in `uploadsNeedingDb`, so they don't have `_pendingFinalContent`; we compute on demand here.)
- Upload: `item._pendingFinalContent` from phase 1.

Failure handling unchanged.

### `markRemotePersisted` semantics under filtering

The current implementation mirrors the committed bytes into `item.remoteContent` AND `item.localContent`, plus recomputes diff stats — this keeps the panel honest if the row stays visible after a partial failure.

Under filtering, `*Content` fields hold *stripped* text, while the actual committed bytes are *merged* text. The transition rules become:

```
// Before commit:    *Content = stripped, *Original = pre-commit raw
// We just committed `finalBytes` (merged) to remote.

item.remoteOriginal = finalBytes;     // remote now literally holds these bytes
item.localOriginal  = finalBytes;     // intent: local file should hold these bytes too
                                       // (mirroring matches the existing invariant
                                       //  that successful-commit-but-failed-local-write
                                       //  should retry the local write with these bytes)
if (item.excludeKeys.length > 0) {
    // The stripped projection is invariant under merge: filtered keys are exactly
    // what merge swapped in, and strip removes them again. So localContent/remoteContent
    // should stay identical to what they were before commit. Recompute defensively:
    item.localContent  = stripKeys(finalBytes, item.excludeKeys);
    item.remoteContent = item.localContent;
} else {
    item.localContent  = finalBytes;
    item.remoteContent = finalBytes;
}
item.remotePersisted = true;
// Stats: pre-commit they reflected localContent vs remoteContent (both stripped, identical
// in upload direction since localContent was the candidate). Post-commit they remain
// identical → added=0, removed=0. The row stays visible only when phase 2 fails, and
// the user's mental model is "remote already has it, just need to write local."
```

This lives inside `markRemotePersisted` itself; the caller signature stays `(item, content)`, only the field-update logic forks on `excludeKeys`.

### Diff stats

For both single and multi sync, the `+added / -removed` counts come from stripped content. This is desirable — the user explicitly said these keys shouldn't show in the diff, so they shouldn't inflate the change counts either.

---

## Part 5 — Edge cases & invariants

| Scenario | Behavior |
|---|---|
| `excludeKeys` empty or missing | Code paths short-circuit to current raw-text behavior. No new dep code runs. Zero regression risk. |
| `excludeKeys` set, file extension not `.json`/`.jsonc` | Sync still attempts JSONC parse. If it succeeds (custom association), filtering proceeds. If it fails, treat as a parse error per next row. |
| JSONC parse fails on either side | Single sync: show `Error: Profile "<name>" has excludeKeys but <side> is not valid JSONC: <message>` and abort. Multi sync: row stays in the panel with an inline error and disabled buttons; `Confirm All` skips it and reports `Skipped N profile(s) due to parse errors`. |
| After stripping, both sides identical | Treat as already synced. Single sync: info message `Content is identical after exclude. No sync needed.` Multi sync: row never enters the actionable list (existing "identical" filter). |
| User edits a filtered key in the diff right-side | The right-side text is the *stripped* version. Edits to non-filtered keys flow through. If the user manually adds a key with the same name as a filtered path, `mergeBack` will overwrite it with the target side's value (or delete it if the target lacks it). Documented as a known semantic. |
| Filter path's parent missing in candidate but present in destination | `mergeBack` uses `jsonc-parser`'s `modify` which auto-constructs intermediate objects. The candidate's final text will contain a synthesized `{"a": {"b": <value>}}` insertion at the end of the appropriate parent. |
| Filter path's segment addresses through a non-object on either side | Treated as path missing on that side. Merge step deletes from candidate (no-op if also missing there). |
| Direction swap (`Alt+S`) mid-diff | `originalLocal`/`originalRemote` stay raw. Re-stripping happens on the new direction. Filtered keys remain hidden. |
| `confirmAll` partial failure where remote committed but local failed | The cached `_pendingFinalContent` is what got committed remotely; subsequent local-only retry rewrites the local file from that same content. `markRemotePersisted` mirrors it into `localContent`/`remoteContent`. |
| Profile schema validation (settings webview save) | `excludeKeys`, if present, must be a string array. Non-string entries are filtered out by the webview-local normalization before send; if a malformed JSON file is hand-edited and read back, `ConfigManager.getProfiles` does no extra validation today — the runtime path tolerates `excludeKeys` being absent / non-array by treating it as empty (defensive `Array.isArray` check at the start of each sync). |

---

## Part 6 — Module impact

| File | Change |
|---|---|
| `src/config.ts` | `Profile.excludeKeys?: string[]`; `saveProfiles` strips empty/missing field on write. |
| `src/profileValidation.ts` | No structural changes. `validateProfileForm` continues to validate only the four required text fields. `excludeKeys` is normalized (not validated) in `_handleSaveProfile`: defensive `Array.isArray` check, filter non-string entries, trim, drop empties, dedupe — then included in the `cleaned: Profile` object if non-empty. |
| `src/jsoncFilter.ts` | **New** — `parsePaths`, `assertJsonc`, `stripKeys`, `mergeBack`, `JsoncFilterParseError`. |
| `src/sync.ts` | `SyncSession.excludeKeys`; gating logic in `startSync`, `openDiff`, `confirmSync`; identical-message tweak. |
| `src/multiSync.ts` | `MultiSyncItem.excludeKeys / localOriginal / remoteOriginal / parseError / _pendingFinalContent`; updates to `buildItems`, `needsSync` (defensive only — stripped content already differs), `openDiffFor`, `confirmOne`, `confirmAll`, `applySync`, `renderRow` (parse-error row state, disabled buttons), banner copy. |
| `src/settingsWebview.ts` | Modal: `<details>` Advanced section, textarea `pmExcludeKeys`, `parseLines`, hint text; profile list: badge in meta line; submit reads `excludeKeys`. |
| `package.json` | Add `"jsonc-parser": "^3.x"` to `dependencies`. |
| `README.md` | New "Filtering keys" subsection under Configuration; one example JSON snippet showing `excludeKeys`. |
| `test/` | New `test/jsoncFilter.test.ts` covering: parse error propagation, strip single/nested/multiple paths, merge restore from destination, merge delete when destination lacks path, merge with nested re-construction, dedupe + empty handling in `parsePaths`, JSONC with comments preserved across strip/merge, JSONC with trailing commas. |

---

## Part 7 — Dependency note: `jsonc-parser`

- Package: [`jsonc-parser`](https://www.npmjs.com/package/jsonc-parser) by Microsoft, MIT, currently `~3.3.x`.
- Size: roughly 50 KB, zero transitive dependencies, pure TypeScript/JavaScript.
- Stability: it is the same library VS Code uses internally for editing `settings.json` — extremely stable, well-tested, and aligned with how this extension already detects JSONC language mode.
- Bundling: VS Code extensions ship `node_modules` (or a webpack/esbuild bundle). The current build is plain `tsc`, no bundler; the package will be carried in the `.vsix` via the `dependencies` field. Adding it bumps the packed size by ~50 KB — well within VS Code Marketplace norms.

## Part 8 — Open questions / future work (out of scope)

- Wildcards (`a.*.b`), array indices (`a.0.b`), and escaped dots (`a\.b`).
- A "preview" panel inside the settings modal that shows the user's current local file with filtered keys highlighted, to give immediate feedback on whether their paths are well-formed.
- Optional "show filtered keys collapsed" view in the diff (a Code Folding-style indicator), trading hide-completely for hide-but-discoverable.
- Per-profile toggle for "filtered keys are also excluded from `+added/-removed` counts" if anyone wants the counts to reflect raw differences.
