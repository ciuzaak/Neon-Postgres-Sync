# Change Log

All notable changes to the "neon-postgres-sync" extension will be documented in this file.

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
