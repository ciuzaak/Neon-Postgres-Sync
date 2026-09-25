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

A **single** hash is enough, defined as *the projection of what the remote holds after the sync*:

- **Upload**: both sides are written with the same final bytes ⇒ base = projection(final).
- **Download**: only local is written; remote unchanged ⇒ base = projection(remote). If the user edited the candidate in the diff before confirming, local's projection ≠ base, so the next sync reports a *local change* and proposes uploading it. That is the honest reading: the edit exists only on this machine.

### Storage

`sync-state.json` next to `neon-sync.json` (VS Code: globalStorage). Written with the existing `atomicWriteJson`. Never synced — it describes *this* machine's view.

```jsonc
{
  "version": 1,
  "entries": [
    {
      "tableName": "json_records",
      "id": "antigravity-settings",
      "localPath": "/Users/me/Library/.../settings.json", // resolved absolute path
      "baseHash": "9f86d0…",
      "filterFingerprint": "e3b0c4…",
      "remoteVersion": "2026-09-25 08:12:44.123456", // see Part 2
      "syncedAt": "2026-09-25T08:12:44.500Z"
    }
  ]
}
```

Key = `(tableName, id, localPath)`, **not** profile name: renaming a profile keeps its history; pointing it at a different file or record correctly starts fresh.

New core module `core/syncState.ts`: `SyncStateStore` with `get(key)`, `put(entry)`, `prune(validKeys)`. Read-modify-write per `put` (two VS Code windows racing on it lose at worst one baseline, which degrades to the legacy heuristic — acceptable).

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

`update_time` is `TIMESTAMP` (µs precision); JS `Date` is ms. Comparing a round-tripped `Date` for equality would spuriously fail. Instead fetch an opaque token alongside the data:

```sql
SELECT data, update_time, update_time::text AS version FROM <t> WHERE id = $1
```

`FetchedRecord` gains `version: string | null`. It is only ever sent back to the same server, so `DateStyle` formatting is stable.

### Conditional write

Upload carries `expectedVersion` (the plan's `remote.version`, or `null` if the row didn't exist). One statement per row, same shape for single and batch:

```sql
-- expectedVersion !== null
WITH w AS (
  UPDATE <t> SET data = $2, update_time = CURRENT_TIMESTAMP
  WHERE id = $1 AND update_time::text IS NOT DISTINCT FROM $3
  RETURNING update_time::text AS version
)
SELECT max(version) AS version, 1 / count(*)::int AS cas_ok FROM w;

-- expectedVersion === null (row must still be absent)
WITH w AS (
  INSERT INTO <t> (id, data, create_time, update_time)
  VALUES ($1, $2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  ON CONFLICT (id) DO NOTHING
  RETURNING update_time::text AS version
)
SELECT max(version) AS version, 1 / count(*)::int AS cas_ok FROM w;
```

Why the `1 / count(*)` sentinel: `upsertMany` runs as a **non-interactive** HTTP transaction, which only rolls back if a statement *errors*. A zero-row UPDATE is not an error. The aggregate always yields one row, so a stale row divides by zero (`SQLSTATE 22012`) and aborts the whole batch — keeping `Confirm All` atomic without installing a server-side function. `RecordStore` maps `22012` from these statements to `StaleRemoteError`; to name the offending rows it re-runs `fetchMany` and compares versions.

`IS NOT DISTINCT FROM` covers legacy rows whose `update_time` is `NULL`.

`upsert` / `upsertMany` return the new `version`, which feeds `remoteVersion` in the baseline.

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

---

## Rollout

1. `version` column in fetch + `StaleRemoteError` + CAS statements in `RecordStore` (Part 2). Tests against the SQL mock: query shape, param order, `22012` mapping.
2. `SyncStateStore` + `planSync` baseline input + `change` field (Part 1). Pure tests for the decision table and the filter-fingerprint reset.
3. `SyncEngine.apply` (Part 3); migrate `sync.ts` and `multiSync.ts`; baseline writes per the table above.
4. UX: conflict badge, stale-remote messages, `Re-sync` / `Reload`.
5. CHANGELOG + README ("Auto-direction rules" section rewritten around the baseline table).

Upgrade path: no baseline exists at first, so behavior is identical to today until each profile's first successful sync (or first `identical` check). No config or schema migration; the table schema is unchanged.

## Test plan

- `plan`: every row of the baseline decision table; `unknown` fallback; `excludeKeys` change ⇒ `unknown`; edits confined to excluded keys ⇒ not a change; edited-download ⇒ next plan is `change: 'local'`.
- `db`: CAS SQL shape for update vs insert-if-absent; `22012` → `StaleRemoteError`; non-CAS errors pass through; returned `version` parsed.
- `engine`: batch with one stale row commits nothing; remote-committed + local-failed row writes no baseline and re-plans as `download`; local guard trips on a modified file.
- `syncState`: keyed by `(table, id, path)` not name; atomic write; prune.

## Decisions

Resolved 2026-09-25 (previously open questions):

1. **Hash only, not base content.** v1 stores `baseHash`, not a copy of the base projection. The entry shape stays extensible (a future `baseContentFile?` field) so three-way merge and a local last-synced backup can be added without a migration.
2. **Version token is `update_time::text`**, not `xmin`. Every writer we control bumps `update_time`; `xmin` is Postgres-internal and 32-bit.
3. **An `identical` plan refreshes the baseline.** It is a local-only write and is what bootstraps baselines for already-in-sync profiles right after upgrade.
