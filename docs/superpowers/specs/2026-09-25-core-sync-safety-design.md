# Host-Agnostic Core + Sync Safety (Baseline & Optimistic Concurrency) — Design

Date: 2026-09-25
Status: Approved — Part 0 implemented; Parts 1–3 in progress

## Goal

Two things, in order:

1. **Core extraction (done in this change).** Move every piece of sync logic that does not need VS Code into `src/core/`, so a CLI/TUI front-end can reuse it verbatim. The extension becomes an adapter over that core.
2. **Sync safety (this spec, not yet implemented).** Stop the two ways the tool can silently lose data today:
   - **Lost update across machines**: direction is chosen by comparing local `mtime` to remote `update_time`. If *both* sides changed since the last sync, the newer one wins and the other side's edits show up only as red lines in a diff the user may not read carefully.
   - **Blind upload race**: `upsert` overwrites unconditionally. If another machine uploads between our fetch and our confirm, its write is lost without any signal.

The fix is a per-machine **sync baseline** (what both sides looked like at the last successful sync) plus **compare-and-swap uploads** keyed on the remote version we planned against.

## Non-goals

- The CLI itself (separate spec; this one only makes it possible).
- Moving `neon-sync.json` out of VS Code's globalStorage / sharing config between front-ends (belongs to the CLI spec).
- Three-way merge of conflicting edits (the baseline design leaves room for it; see Open Questions).
- Propagating deletes (a missing local file still means "download"; a missing remote row still means "upload").
- Remote version history / restore, EOL normalization, `~` expansion, per-OS paths, encryption. All tracked separately.

---

## Part 0 — Core boundary (implemented)

### Module map

| Module | Responsibility | Host deps |
|---|---|---|
| `core/types.ts` | `Profile`, `ConfigFile`, `SyncDirection`, `FetchedRecord` | none |
| `core/db.ts` | `RecordStore` (fetch / upsert / fetchMany / upsertMany over Neon HTTP), `assertValidTableName` | `@neondatabase/serverless` |
| `core/configFile.ts` | `ConfigFileStore` (read / saveProfiles / removeConnectionString / ensureExists), atomic JSON write, profile normalization | `fs` |
| `core/localFile.ts` | `readLocalFile` → `{exists, content, mtime}`, `resolveProfilePath(filePath, baseDir)` | `fs` |
| `core/plan.ts` | `planSync` (compare + filter + status + direction suggestion), `finalizeCandidate` (mergeBack against destination), `candidateFor`, `decideSyncDirection`, `computeDiffStats` | none |
| `core/jsoncFilter.ts` | unchanged, moved | `jsonc-parser` |
| `core/profileValidation.ts` | unchanged, moved | none |

The VS Code side keeps only host concerns:

- `config.ts` — SecretStorage, legacy-secret migration, toasts, `Open Settings (JSON)`; delegates file IO to `ConfigFileStore`.
- `db.ts` — resolves the connection string (and the "not configured" prompt), caches one `RecordStore` per connection string; public `DatabaseService` API unchanged.
- `sync.ts` / `multiSync.ts` — diff editor, webview, prompts; both now build a `SyncPlan` via `planSync` instead of duplicating strip/compare/decide logic.

### Enforcement

`test/core/boundary.test.ts` fails if any file in `src/core/` imports `vscode` or reaches outside `core/` (`../`). The core ships inside the same package for now; splitting into `packages/core` + `packages/vscode` + `packages/cli` is deferred until the CLI exists and there is a second consumer to validate the seams.

### Behavior

No user-visible change. Tests moved alongside (`test/core/*`); new tests cover `RecordStore`, `ConfigFileStore`, and `planSync` statuses. 77 → 98 tests.

---

## Part 1 — Sync baseline

### Idea

After every successful sync, record — per machine, per profile — a fingerprint of the content both sides agreed on. Next time, each side is compared against that fingerprint instead of against the other side's clock:

| Local vs base | Remote vs base | Result |
|---|---|---|
| same | same | identical (already short-circuited today) |
| same | changed | **download**, not ambiguous |
| changed | same | **upload**, not ambiguous |
| changed | changed | **conflict** — explicit prompt, never auto-picked |
| *no baseline* | | fall back to today's mtime heuristic (`reason` says "no sync history") |

This removes the clock-skew problem for every profile that has synced once, and makes "both changed" detectable at all.

### What is fingerprinted

`baseHash = sha256(projection)`, where *projection* is the content after `stripKeys` — i.e. exactly `SyncPlan.localContent` / `remoteContent`. Consequences:

- Edits confined to `excludeKeys` never count as a change (that's what excluding them means).
- If the profile's `excludeKeys` list changes, every old hash is meaningless. Each entry therefore stores `filterFingerprint = sha256(JSON.stringify(sorted normalized paths))`; mismatch ⇒ treat as no baseline.
- Projections come from `stripKeys`, which removes each excluded property together with its trailing comma and, when the property owns its line, that line including its own same-line `//` comment. All other comments and formatting survive (an earlier `jsonc-parser`-based strip also deleted the *neighbouring* key's comment, which let a comment-only edit hide from change detection; fixed in `9c87b9b`/`6557c99`, and a strip → merge round trip now reproduces the original projection exactly). Consequences: (a) an edit to the excluded key's own same-line comment is invisible — accepted, that comment belongs to the excluded key; (b) the same content can project with slightly different whitespace depending on where an excluded key sat, and a `jsonc-parser` upgrade could shift outputs. (b) can only make a side look *changed* when it isn't — never hide a real change — so the worst case is an extra conflict prompt or a whitespace-only upload the diff already shows.

A **single** hash is enough, defined as *the projection of what the remote holds after the sync*:

- **Upload**: both sides are written with the same final bytes ⇒ base = projection(final).
- **Download**: only local is written; remote unchanged ⇒ base = projection(remote). If the user edited the candidate in the diff before confirming, local's projection ≠ base, so the next sync reports a *local change* and proposes uploading it. That is the honest reading: the edit exists only on this machine.

### Storage

A `sync-state/` directory next to `neon-sync.json` (VS Code: globalStorage) holding **one file per key**, named by a hash of the key. Never synced — it describes *this* machine's view.

```jsonc
// sync-state/3f2a….json
{
  "version": 1,
  "entry": {
    "tableName": "json_records",
    "id": "antigravity-settings",
    "localPath": "/Users/me/Library/.../settings.json", // resolved absolute path
    "baseHash": "9f86d0…",
    "filterFingerprint": "e3b0c4…",
    "remoteVersion": "2cf24dba5fb0a30e…", // content hash, see Part 2
    "syncedAt": "2026-09-25T08:12:44.500Z"
  }
}
```

Key = `(tableName, id, localPath)`, **not** profile name: renaming a profile keeps its history; pointing it at a different file or record correctly starts fresh. The table part is lowercased but kept schema-qualified as written — deliberately *not* Part 2's unqualified rule: there a false match only means "sync separately", but here `prod.records` and `staging.records` sharing a baseline would let syncing one make the other's plan a confident wrong-way download (reproduced in review). A false *miss* (`records` vs `public.records`) only costs a baseline. Id and path are exact. The stored key is re-checked on read, so a filename-hash collision reads as "no baseline".

Why one file per key (originally a single `sync-state.json`, changed after review): with a shared file, two writers doing read-modify-write for *different* profiles could restore the other's *previous* baseline — not merely lose it — and a stale baseline can turn a real local revert into a silent download. Separate files make cross-profile races impossible and confine a bad file to its own profile. Same-profile concurrent writes are last-writer-wins, matching two syncs of that profile racing anyway.

`core/syncState.ts`: `SyncStateStore` with `get(key)`, `put(entry)`, `delete(key)`. Failure handling — the state is a cache, so every read failure means "no baseline":
- missing, corrupt, malformed or key-mismatched file ⇒ reads empty; the next `put` replaces it;
- unreadable file (EACCES, EBUSY…) ⇒ reads empty, but `put` throws rather than overwrite what it couldn't read;
- file with a different `version` ⇒ reads empty and is never overwritten (a newer client owns it).

No automatic pruning in v1: relative profile paths resolve per workspace, so "not matching any current profile" doesn't mean "orphaned". Files are tiny.

### When the baseline is written

| Event | Write? |
|---|---|
| Single sync confirmed (upload or download) | yes, after the local write succeeds |
| Multi-sync `Confirm` / `Confirm All`, per row | yes, after that row's local write succeeds |
| Remote committed but local write failed (`remotePersisted`) | **no** — the old baseline makes the next plan see "remote changed, local unchanged" ⇒ download of the committed bytes, which is exactly the retry we want |
| Plan finds `identical` | yes (refresh). Cheap, local-only, and bootstraps baselines for every already-in-sync profile right after upgrade |
| Cancel / close diff | no |

### Plan changes (`core/plan.ts`)

`planSync(profile, local, remote, baseline?)` gains an optional baseline. `SyncPlan` gains:

```ts
change: 'local' | 'remote' | 'both' | 'unknown';   // 'unknown' = no usable baseline
```

`suggestion` is derived from `change` when known (`both` ⇒ `ambiguous: true`, reason "both sides changed since last sync on <syncedAt>"), otherwise from `decideSyncDirection` as today.

### UX

- **Single sync**: `both` reuses the existing ambiguity modal with a stronger message: *"Both local and remote changed since the last sync (2026-09-20 14:02). Pick which side wins; the other side's changes will be shown as removals in the diff."*
- **Multi-sync panel**: new `⚠ conflict` badge on the row; `Confirm All` skips conflict rows (like parse-error rows) and reports the count, so a bulk confirm can never resolve a conflict implicitly.

---

## Part 2 — Optimistic concurrency on upload

### Version token

The token is a **hash of the row's content, computed server-side**:

```sql
SELECT data, update_time, encode(sha256(convert_to(data::text, current_setting('server_encoding'))), 'hex') AS version FROM <t> WHERE id = $1
```

`FetchedRecord` gains `version: string | null` (null when the row is absent or its data is NULL). It is opaque to the client: only compared and sent back.

Why not `update_time::text` (the original decision, reversed after review — see Decisions): the token must change whenever the content changes, and an `update_time`-based token doesn't guarantee that. It collides for two writes within one tick of the column's precision (`timestamp(0)`: same second ⇒ a stale write is accepted — reproduced); for `timestamptz` its text depends on the session `TimeZone`/`DateStyle`, so a setting change invalidates every stored token (reproduced); and writers that don't bump `update_time`, such as edits in the Neon console, would be invisible. A content hash has none of these problems. The one thing it can't see — content changed and then changed back (ABA) — is harmless: if the remote holds exactly what the user reviewed, overwriting it loses nothing. `sha256` rather than `md5`: `md5()` errors on FIPS-mode servers, and this expression runs on every fetch (including the extension's current read path). Bytes are taken in the server's own encoding (a no-op `convert_to`), not forced to UTF8, which would fail on invalid bytes in e.g. a `SQL_ASCII` database. `::text` also covers `json`/`jsonb` data columns.

### Conditional write

Upload carries an expectation `{ exists, version }` taken from the plan's fetched record. One statement per row, same shape for single and batch:

```sql
-- expected.exists: row must still hold the same content
WITH w AS (
  UPDATE <t> SET data = $2, update_time = CURRENT_TIMESTAMP
  WHERE id = $1 AND <version expr> IS NOT DISTINCT FROM $3
  RETURNING <version expr> AS version
)
SELECT max(version) AS version, 1 / count(*)::int AS cas_ok FROM w;

-- !expected.exists: row must still be absent
WITH w AS (
  INSERT INTO <t> (id, data, create_time, update_time)
  VALUES ($1, $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  ON CONFLICT (id) DO NOTHING
  RETURNING <version expr> AS version
)
SELECT max(version) AS version, 1 / count(*)::int AS cas_ok FROM w;
```

Why the `1 / count(*)` sentinel: `conditionalWriteMany` runs as a **non-interactive** HTTP transaction, which only rolls back if a statement *errors*. A zero-row UPDATE is not an error. The aggregate always yields one row, so a stale row divides by zero (`SQLSTATE 22012`) and aborts the whole batch — keeping `Confirm All` atomic without installing a server-side function. (Verified on real Postgres via PGlite: the CTE runs exactly once and the division can't be constant-folded, since it depends on the aggregate.)

On `22012`, `RecordStore` re-runs `fetchMany` and compares versions to name the stale rows:
- some rows stale ⇒ `StaleRemoteError(profiles)`;
- re-read fails ⇒ `StaleRemoteError([])` (stale is likely but unconfirmed);
- re-read succeeds but nothing is stale ⇒ either a race already undone within one round trip (another writer changed the row and restored it, or created and deleted it) or a `22012` from elsewhere (a user trigger or CHECK). Retry the batch **once**: the race resolves (and writing is correct, since the remote again holds what the user reviewed); the other cause fails again and its original error is rethrown unchanged, never relabeled stale.

A batch in which two items address the same row is rejected before any SQL: both can't be conditional on the same version (the first write changes it), so the second would always look stale. Rows are keyed on the *unqualified*, lowercased table name plus id, since `records` and `public.records` usually name the same table; same-named tables in two schemas are a false positive whose only cost is "sync them separately".

`IS NOT DISTINCT FROM` covers rows whose `data` is `NULL`. Writes return the new `version`, which feeds `remoteVersion` in the baseline.

### Local guard (download side)

Symmetric, cheaper: before writing a local file, re-read it and compare to the plan's `localOriginal`. If it changed (e.g. the user saved it in another editor while the diff was open), abort that row with `StaleLocalError`.

### UX

- **Single**: *"Remote record changed since this diff was opened (another machine synced). Nothing was written."* with a `Re-sync` button that restarts `startSync`.
- **Multi**: `Confirm All` already reports "No changes were applied" on DB failure; the message now names the stale rows and offers `Reload`, which rebuilds the panel from fresh plans.

---

## Part 3 — Core apply API (needed by the CLI; lands with Parts 1–2)

`multiSync.ts` currently owns the two-phase commit (atomic DB phase, then best-effort local writes, `remotePersisted` retry bookkeeping). Parts 1–2 change that flow anyway (versions, guards, baseline writes), so it moves into core at the same time rather than being extracted twice:

```ts
// core/engine.ts
class SyncEngine {
  constructor(deps: { store: RecordStore; state: SyncStateStore; resolvePath: (p: string) => string });
  plan(profiles: Profile[]): Promise<SyncPlan[]>;                 // fetchMany + readLocalFile + baseline lookup
  apply(requests: ApplyRequest[]): Promise<ApplyOutcome[]>;      // phase 1 CAS uploads (atomic), phase 2 guarded local writes, phase 3 baselines
}

interface ApplyRequest { plan: SyncPlan; direction: SyncDirection; finalContent: string; remoteAlreadyCommitted?: boolean }

type ApplyOutcome =
  | { profile: Profile; kind: 'ok'; version: string | null }
  | { profile: Profile; kind: 'stale-remote' | 'stale-local' }
  | { profile: Profile; kind: 'local-write-failed'; remoteCommitted: boolean; error: string };
```

The extension's single and multi flows both call `engine.apply`; the webview keeps only presentation state (`busy`, active diff lock).

**Upload also fixes a v0.7 bug:** today an upload writes the remote-merged bytes (`mergeBack(candidate, remoteOriginal)`) to the *local* file too, so the local machine's own values for excluded keys are replaced by the remote's — the opposite of what excludeKeys is for. `apply` writes each side merged against *its own* original: remote gets `mergeBack(candidate, remoteOriginal)`, local gets `mergeBack(candidate, localOriginal)`. Both have the same projection, so the baseline is unaffected.

---

## Rollout

1. ✅ `version` in fetch + `StaleRemoteError` + CAS statements in `RecordStore` (Part 2). Tests: SQL shape and param order against the mock; semantics against real Postgres via PGlite (`test/core/db.cas.test.ts`).
2. ✅ `SyncStateStore` + `planSync` baseline input + `change` field + `baselineAfterSync` (Part 1). Pure tests for the decision table and the filter-fingerprint reset.
3. `SyncEngine.apply` (Part 3); migrate `sync.ts` and `multiSync.ts`; baseline writes per the table above.
4. UX: conflict badge, stale-remote messages, `Re-sync` / `Reload`.
5. CHANGELOG + README ("Auto-direction rules" section rewritten around the baseline table).

Upgrade path: no baseline exists at first, so behavior is identical to today until each profile's first successful sync (or first `identical` check). No config or schema migration; the table schema is unchanged.

## Test plan

- `plan`: every row of the baseline decision table; `unknown` fallback; `excludeKeys` change ⇒ `unknown`; edits confined to excluded keys ⇒ not a change; edited-download ⇒ next plan is `change: 'local'`.
- `db`: CAS SQL shape for update vs insert-if-absent; `22012` → `StaleRemoteError`; non-CAS errors pass through; returned `version` parsed.
- `engine`: batch with one stale row commits nothing; remote-committed + local-failed row writes no baseline and re-plans as `download`; local guard trips on a modified file.
- `syncState`: keyed by `(table, id, path)` not name; one file per key; corrupt / unreadable / foreign-version files each handled as specified; other keys unaffected.

## Decisions

Resolved 2026-09-25 (previously open questions):

1. **Hash only, not base content.** v1 stores `baseHash`, not a copy of the base projection. The entry shape stays extensible (a future `baseContentFile?` field) so three-way merge and a local last-synced backup can be added without a migration.
2. **Version token is a server-side content hash (`sha256` of `data::text`).** Originally decided as `update_time::text`; reversed the same day after review reproduced three failures on PGlite (same-second collision under `timestamp(0)` accepting a stale write, `timestamptz` tokens changing with session `TimeZone`, console edits that skip `update_time`). See Part 2 → Version token. `xmin` was also rejected (Postgres-internal, 32-bit).
3. **An `identical` plan refreshes the baseline.** It is a local-only write and is what bootstraps baselines for already-in-sync profiles right after upgrade.
