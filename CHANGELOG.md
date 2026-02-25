# Change Log

All notable changes to the "neon-postgres-sync" extension will be documented in this file.

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
