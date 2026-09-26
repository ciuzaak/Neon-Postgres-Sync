# Change Log

All notable changes to the "neon-postgres-sync" extension will be documented in this file.

## [Unreleased]
### Added
- **`neon-sync` CLI** (new npm package, [cli/README.md](cli/README.md)): the same sync from the terminal — `status`, `sync`, `pull`, `push`, `diff`, `edit`, profile management, `init-db` — sharing profiles and sync history with the extension. Applies only changes whose direction is known to be safe (conflicts, syncs without history where both sides exist, deletions and large deletions are always asked about), `--yes`/`--json` for scripts, and exit codes for cron.
- **Change Detection by Sync History**: Each machine records what both sides looked like after its last sync of a profile. The next sync compares each side against that record instead of against the other side's clock: only local changed → upload, only remote changed → download, both changed → an explicit conflict prompt. Profiles with no history yet fall back to the timestamp rule.
- **Conflict Rows (Multi-Sync)**: Rows where both sides changed get a `⚠ conflict` badge and are left out of `Confirm All` until handled individually.
- **Safe Uploads**: Uploads are conditional on the remote still holding exactly what was reviewed. If another machine synced (or someone edited the row in the Neon console) in the meantime, nothing is written and a `Re-sync` / `Reload` is offered. A batch with any stale row writes nothing.
- **Local File Guard**: A local file edited after the diff or batch page loaded is not overwritten — checked again right before writing. Local writes are atomic (a failure midway can no longer leave a truncated file), follow symlinks instead of replacing them, and keep the file's permissions.
- **Shared-File Check**: Profiles that point at the same local file are refused at sync time; they would corrupt each other's sync history.

### Changed
- **Shared Profile Location**: Profiles now live in `~/.config/neon-sync/neon-sync.json` (`%APPDATA%\neon-sync` on Windows), shared by every editor with the extension and by the new `neon-sync` CLI; sync history is per machine in `~/.local/state/neon-sync` (`%LOCALAPPDATA%` on Windows). Each editor migrates its previous profiles on first launch (same-name profiles keep the shared version; a notification lists what was added) and keeps its old file as a backup. Downgrading afterwards reads the old backup.
- **Safer Profile Edits**: Profile changes are applied under a lock to the latest file content, so edits from another editor (or the CLI) aren't overwritten; editing a profile that was renamed or removed elsewhere is reported. A corrupt `neon-sync.json` is never overwritten anymore — fix it (the error names the file) instead of losing every profile on the next save.
- **Portable File Paths**: `~/…` is supported in profile paths, and `Browse…` stores `~/…` (or absolute) paths instead of workspace-relative ones.
- **One Sync at a Time**: `Sync File` and `Sync Multiple Profiles…` are refused while a sync diff is still open (finish or cancel it first). Previously a second sync silently replaced the open diff and left its temp files behind.

### Fixed
- **Upload Overwrote This Machine's Filtered Keys**: With `excludeKeys`, uploading also wrote the *remote's* values for the filtered keys into the local file, so e.g. a machine-specific theme was replaced on every upload. Each side now keeps its own values.
- **`json` Data Columns Rewritten on Fetch**: When the table's `data` column was `json`/`jsonb` rather than the documented `TEXT`, fetched content was parsed and re-serialized (`1.0` became `1`, formatting and key order changed), so a round trip altered the file. Content is now read as the column's text: verbatim for `json`, Postgres's canonical form for `jsonb` (use `TEXT` to preserve comments and formatting).
- **Reserved Words as Table Names**: A table named e.g. `user` or `order` passed validation but every query failed with a syntax error. Table names are now quoted (in lower case, so `MyTable` still means the same table as before).
- **Key Filtering Lost Neighbouring Comments**: With `excludeKeys` active, removing a filtered key also deleted the comment trailing the previous key (e.g. `"fontSize": 14, // why 14`) and any comment lines just above the filtered key. The comment vanished from the diff and, once confirmed, from the written file on both sides. Only the filtered key and its own same-line comment are removed now.
- **Key Filtering Moved Comments When Restoring Keys**: Splicing a filtered key back in placed the separating comma after the previous key's trailing comment, moving that comment onto the restored key's line (where the next sync would strip it). Restored keys are now appended on their own line, and the target's value is copied verbatim, so formatting and comments inside it (and number spellings like `1.0`) are preserved. Also covered: comments right after `{`, comments between a value and a comma on a later line, bare-CR line endings, duplicate keys (resolved like `JSON.parse`, last wins; all copies of a filtered key are hidden), and trailing-comma style.

## [0.7.0] - 2026-05-19
### Added
- **Per-Profile Key Filtering (JSON/JSONC only)**: New `excludeKeys` field on each profile lists dot-separated key paths that should be hidden from the diff view and preserved on the target side at confirm time. Useful for machine-specific or transient keys (themes, machine IDs, locally chosen font sizes) that shouldn't propagate across machines. Edit via the settings panel's Advanced section in the Add/Edit Profile modal, or directly in `neon-sync.json`. Comments and formatting on non-filtered keys are preserved (powered by `jsonc-parser`).
- **Parse-Error Row State (Multi-Sync)**: When `excludeKeys` is active and either side fails to parse as JSONC, the multi-profile panel keeps the row visible with an inline `⚠ excludeKeys active but <side> is not valid JSONC: …` message and disables its action buttons. `Confirm All` excludes these rows and reports the skipped count.
- **Concurrent `Confirm All` Guard**: `Confirm All` now no-ops if already in flight, preventing a double-click from issuing two DB commits or corrupting the `_pendingFinalContent` retry cache.

## [0.6.0] - 2026-05-09
### Changed
- **Settings Panel**: Rebuilt with a theme-aware macOS-style design. Profile add and edit now happen in a modal dialog with required-field validation; the file path field includes a `Browse…` button that uses VS Code's native open dialog and returns a workspace-relative path when the choice lives inside the workspace
- **Connection URL Flow**: Removed the standalone `Neon Sync: Configure Connection URL` command. The connection URL is now configured in the settings panel (auto-saves on blur into Secret Storage). When a sync runs without a connection string, the error toast offers an `Open Settings` button that focuses the Connection field
- **Command Naming**: Renamed `Neon Sync: Open Config File` to `Neon Sync: Open Settings (JSON)` to match VS Code's `Preferences: Open User Settings (JSON)` convention

## [0.5.1] - 2026-04-23
### Fixed
- **Multi-Profile Sync**: After confirming a diff, the "Diff open for <name>" banner and the disabled state on the remaining profile rows stayed stuck on the panel because the lock was cleared after the post-confirm render. The lock is now released before the follow-up render

### Changed
- **MRU Ordering**: Profiles chosen inside the multi-select picker no longer get promoted in the main picker's MRU order. Only the `Sync Multiple Profiles…` entry itself is MRU-tracked, so triggering a multi-sync no longer reshuffles the individual profiles above it

## [0.5.0] - 2026-04-22
### Added
- **Multi-Profile Sync**: New `Sync Multiple Profiles…` entry in the picker opens a batch page showing each profile's direction, added/removed line counts, and per-row Swap / Diff / Confirm controls. The entry's position in the picker is ordered by usage frequency alongside the profiles
- **Select All Shortcut**: In the multi-profile picker, `Alt+A` or the title-bar Select All button toggles every profile on/off (scoped to the current search filter); placeholder text surfaces the hint
- **Batched Connection**: The batch page fetches all selected profiles in a single HTTP transaction via `@neondatabase/serverless` and commits `Confirm All` uploads in one atomic transaction, replacing the previous one-request-per-profile round-trips
- **Partial-Failure Recovery**: When a `Confirm All` upload batch commits remotely but a later local write fails, the affected rows stay visible with a `remote committed` badge so a retry only re-runs the local write — no duplicate DB commits, no stale candidate bytes
- **Skip / Summary Notifications**: Identical profiles are skipped with a notification instead of opening the page; missing-both profiles are called out separately; when the last pending row is confirmed the page auto-closes with a summary

### Changed
- `SyncManager` now supports an external caller (the multi-sync page) that drives diff sessions and applies persistence itself, while the single-profile flow keeps its existing behavior

## [0.4.0] - 2026-04-21
### Added
- **Unified Sync Command**: Single `Neon Sync: Sync File` command compares local file `mtime` with remote `update_time` and auto-picks a direction when the gap is clearly ≥ 5 seconds
- **Explicit Prompt for Ambiguous Cases**: When the two timestamps differ by less than 5 seconds (including ties) or either side is missing a timestamp, a modal pauses and asks you to pick `Download (Local ← Remote)` or `Upload (Remote ← Local)` instead of auto-resolving. Missing local file / missing remote record still auto-pick the obvious direction.
- **Swap Direction in Diff**: `⇄` icon in the diff title bar (or `Alt+S`) flips sync direction mid-review; warns before discarding candidate-side edits (detects both unsaved *and* saved changes)

### Removed
- `Neon Sync: Download File` and `Neon Sync: Upload File` — both cases are now covered by `Sync File` + swap
- Dead `DatabaseService.fetchRecord` helper (superseded by `fetchRecordWithMeta`)

## [0.3.2] - 2026-03-02
### Added
- **Keyboard Shortcut**: Press `Alt+Enter` in the diff view to quickly confirm sync

## [0.3.1] - 2026-02-25
### Improved
- Reduced VSIX package size by tightening `.vscodeignore` exclusions (removed unnecessary maps/types/docs/tests from packaged dependencies)
- Compressed extension icon asset to further reduce package size

## [0.3.0] - 2026-02-25
### Added
- Persisted MRU profile ordering across window reloads using global state

### Changed
- Switched to HTTP transport only (`@neondatabase/serverless`); TCP/pg mode removed
- Updated record timestamps to database-generated `CURRENT_TIMESTAMP`

### Fixed
- Cleared cached SQL client instances when connection string is updated
- Hardened HTTP query result handling with runtime response-shape validation

## [0.2.1] - 2025-12-05
### Fixed
- Fixed confirm/cancel buttons not showing during sync (race condition in editor close listener)

## [0.2.0] - 2025-12-05
### Security
- Added table name validation to prevent SQL injection attacks

### Added
- **MRU Profile Ordering**: Most recently used profile appears first in the selection list
- **Single Profile Auto-Select**: Skip profile selection when only one profile is configured
- **Loading Progress**: Show progress notification during sync operations
- **Auto Cleanup**: Temp files are now automatically deleted when closing the diff editor

### Improved
- **Diff Title**: Simplified to `Profile: Local ← Remote` / `Profile: Remote ← Local`
- Changed default content for new files from `{}` to empty string
- Fixed `saveProfiles()` to create config file if it doesn't exist

### Code Quality
- Changed `let` to `const` for immutable variables
- Added JSDoc comments for key methods

## [0.1.0] - 2025-12-04
- **Improved Diff View**: Temp files now inherit the original file's language mode (e.g., JSONC), preventing false syntax error highlights in the diff editor.

## [0.0.1] - 2025-11-24
- Initial release
- Text-based sync support
- Secure connection string storage
- Interactive diff workflow
