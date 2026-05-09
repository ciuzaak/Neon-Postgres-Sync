# Config UI Rework — Design

Date: 2026-05-09
Status: Approved (pending implementation plan)

## Goal

Streamline the connection URL workflow, unify the two "open config" commands, and modernize the settings webview so configuration feels native, theme-aware, and forgiving.

## Scope

Three coordinated changes, all within the existing extension surface (no new packages, no schema changes to `neon-sync.json`):

1. Remove the explicit `Configure Connection URL` command; surface URL configuration only through (a) a contextual error prompt when the URL is missing, and (b) a field in the settings webview.
2. Rename the two settings commands so they mirror VS Code's own `Preferences: Open User Settings` / `… (JSON)` pattern.
3. Redesign the settings webview: macOS-inspired, theme-aware, with profile add/edit moved into a validated modal and a native file picker for `filePath`.

## Non-goals

- No changes to sync logic, multi-sync, or DB layer beyond the single error path in `db.ts`.
- No migration of `neon-sync.json` shape.
- No changes to keybindings or context keys.

---

## Part 1 — Connection URL flow

### Command surface

`package.json` `contributes.commands`:

- **Remove** `neonSync.configureUrl`. Drop both the registration and the `commandPalette` exposure.
- Also remove its handler in `extension.ts` (the `configureUrlDisposable` block).

### Error-driven entry point

In `src/db.ts`, `getConnectionString()` currently throws `'PostgreSQL connection string is not configured. Please run "Neon Sync: Configure Connection URL".'` on miss.

New behavior:

- Centralize the missing-URL handling in `ConfigManager` (so both `db.ts` and any future caller share one prompt). Add `ConfigManager.promptMissingConnectionString()`:
  - Calls `vscode.window.showErrorMessage('PostgreSQL connection string is not configured.', 'Open Settings')`.
  - If the user clicks `Open Settings`, run `vscode.commands.executeCommand('neonSync.openSettings', { focus: 'connection' })`.
  - Returns nothing; it is fire-and-forget.
- `db.ts` still `throw`s (so the calling sync flow halts), but invokes `ConfigManager.promptMissingConnectionString()` immediately before throwing, and the thrown `Error` message is shortened to `'PostgreSQL connection string is not configured.'` (no command instruction, since the toast already has the button).

### Webview focus hint

`SettingsPanel.createOrShow(extensionUri, options?)` accepts an optional `{ focus?: 'connection' }`. When set, after the panel finishes its initial `loadSettings` exchange it posts `{ command: 'focusField', field: 'connection' }` to the webview, which scrolls to and focuses the connection input.

The `neonSync.openSettings` command handler forwards its first argument as the options object.

---

## Part 2 — Command naming

`package.json` titles:

| Command ID (unchanged) | Old title | New title |
|---|---|---|
| `neonSync.openSettings` | `Neon Sync: Open Settings` | `Neon Sync: Open Settings` |
| `neonSync.openConfigFile` | `Neon Sync: Open Config File` | `Neon Sync: Open Settings (JSON)` |

Command IDs are preserved to avoid breaking any user keybindings or external callers. Only the user-visible titles change.

The error message at `db.ts` originally referenced `Neon Sync: Configure Connection URL`. The new behavior replaces that reference with the toast button (Part 1), so no stale title remains.

`README.md` is updated to reflect the renames (one short find-and-replace).

---

## Part 3 — Settings webview redesign

The webview is rebuilt in `src/settingsWebview.ts`. Single file, single string of HTML/CSS/JS as today (no bundler change). Code is organized into clearly separated sections inside that file.

### Visual style

- **macOS-inspired**: rounded corners (8–10px), generous padding, soft 1px borders, subtle elevation on modals (`box-shadow: 0 10px 30px rgba(0,0,0,0.18)`).
- **Theme-aware**: every color drawn from `var(--vscode-*)` tokens. The same stylesheet works under light and dark themes without conditional CSS.
  - Surfaces: `--vscode-editor-background`, `--vscode-sideBar-background`
  - Borders: `--vscode-panel-border`, `--vscode-input-border`
  - Text: `--vscode-foreground`, `--vscode-descriptionForeground` (for hint text)
  - Primary action: `--vscode-button-background` / `--vscode-button-foreground`
  - Destructive: `--vscode-errorForeground`
  - Focus ring: `--vscode-focusBorder`
- Typography: `var(--vscode-font-family)`, with a slight size hierarchy (16px section titles, 13px body, 12px hint).
- Modal entry: fade-in backdrop (200ms), modal scales from 0.96 → 1.0. Respects `prefers-reduced-motion`.

### Layout

```
┌─────────────────────────────────────────────────┐
│  Neon Sync Settings                             │
├─────────────────────────────────────────────────┤
│  ┌─ Connection ─────────────────────────────┐   │
│  │  PostgreSQL Connection URL               │   │
│  │  [••••••••••••••••••••••••]  [👁 Show]   │   │
│  │  Stored in VS Code Secret Storage.       │   │
│  └──────────────────────────────────────────┘   │
│                                                 │
│  ┌─ Profiles ───────────────────[+ Add]─────┐   │
│  │  ┌──────────────────────────────────┐    │   │
│  │  │ my-profile                       │    │   │
│  │  │ data.json · json_records         │    │   │
│  │  │              [Edit]   [Delete]   │    │   │
│  │  └──────────────────────────────────┘    │   │
│  │  ┌──────────────────────────────────┐    │   │
│  │  │ another                          │    │   │
│  │  │ ~/notes.md · my_table            │    │   │
│  │  │              [Edit]   [Delete]   │    │   │
│  │  └──────────────────────────────────┘    │   │
│  └──────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘
```

No bottom "Save Settings" button. See **Save model** below.

### Connection URL field

- `<input type="password">` by default; toggle button switches to `type="text"` and back. Toggle label updates between `Show` and `Hide`.
- **Save on blur** (or Enter): when the field loses focus and the value differs from the loaded value AND the new value is non-empty, post `saveConnectionString` to the host. The host calls `ConfigManager.setConnectionString(url)`. A small inline status indicator below the field shows `Saved` for ~1.5s on success, or an error line if storage fails.
- Blurring with an empty input when a value was previously stored does **not** auto-clear (would silently wipe the secret on accidental Ctrl+A / Delete). Instead, the webview shows an inline confirmation row under the field: `Clear stored URL? [Clear] [Keep]`. The user must explicitly click `Clear` to remove the secret. Picking `Keep` (or refocusing the input and typing) cancels.
- Hint text under the field: `Stored securely in VS Code Secret Storage.`

### Profile list

Each profile is a card. The card's right side has `Edit` and `Delete` buttons.

- **Add**: top-right `+ Add` opens the profile modal in "create" mode.
- **Edit**: opens the modal pre-filled with the profile's current values.
- **Delete**: opens a small confirm modal (`Delete profile "<name>"? This cannot be undone.` — `Cancel` / `Delete` red). On confirm, profile is removed from the list and saved.

Empty state (no profiles): the Profiles card shows centered helper text — `No profiles yet. Click + Add to create one.`

### Profile modal

Shared component for Create and Edit. Fields:

| Field | Required | Validation |
|---|---|---|
| Name | yes | Non-empty; unique among existing profiles (excluding self when editing) |
| Local File Path | yes | Non-empty. `Browse…` button opens VS Code's `showOpenDialog`. |
| Record ID | yes | Non-empty |
| Table Name | yes | Matches `^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)?$` (mirrors `DatabaseService.validateTableName` in `db.ts`) |

Validation behavior:

- Errors are **not** shown while typing. They appear on Save attempt.
- On Save, all fields are validated together; every invalid field gets a red border and an inline error message below it.
- The Save button is always enabled; clicking it with invalid fields just surfaces errors. (Avoids the "why is this button disabled?" trap.)
- Save with all-valid fields posts `saveProfile` to the host; the host updates `neon-sync.json` via `ConfigManager.saveProfiles()` and replies with the new profile list. The webview re-renders, closes the modal, and shows a brief `Saved` status.

Browse flow (file path):

- Webview posts `pickFilePath` with the current text value.
- Host calls `vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: false, defaultUri: <derived> })` where `defaultUri` is, in order of preference: the existing path (resolved via `SyncManager.resolvePath`), the first workspace folder, or undefined.
- On selection, host computes the path to write back: if the chosen file is inside the first workspace folder, return the workspace-relative path; otherwise return the absolute path. This matches the existing `resolvePath` logic in `sync.ts:444` so existing profiles' relative-vs-absolute behavior is preserved.
- Cancellation returns nothing; the field is left as-is.

Modal interactions:

- Esc closes the modal (with unsaved changes confirmation only if the user typed something).
- Click on backdrop closes the modal (same confirmation rule).
- Enter inside any input triggers Save.
- Tab order: Name → File Path → Browse → Record ID → Table Name → Cancel → Save.

### Save model

Per user direction ("更现代"):

- **Profile changes** persist immediately on modal Save (or on Delete confirm). No batched bottom-of-page Save button.
- **Connection URL** persists on blur or Enter. Avoids leaking each keystroke into SecretStorage and avoids needing a separate button.
- The webview never holds dirty state across panel reload. If the user closes the panel mid-edit in the modal, those modal-only edits are discarded — same as if they hit Cancel.

### Message protocol (host ⇄ webview)

Existing messages `getSettings`, `loadSettings` are kept. New messages:

| Direction | Command | Payload | Effect |
|---|---|---|---|
| webview → host | `saveConnectionString` | `{ url: string }` | Host calls `setConnectionString`, replies with `connectionStringSaved` (success) or `connectionStringError` (message) |
| webview → host | `clearConnectionString` | `{}` | Host calls a new `ConfigManager.clearConnectionString()` (secrets.delete + clear file fallback), replies with `connectionStringSaved { url: '' }` |
| webview → host | `saveProfile` | `{ profile: Profile, originalName?: string }` | Host updates the profile list (`originalName` lets us rename without dup-key check colliding), replies with `profilesSaved` carrying the new list |
| webview → host | `deleteProfile` | `{ name: string }` | Host removes the profile, replies with `profilesSaved` |
| webview → host | `pickFilePath` | `{ currentValue?: string }` | Host opens dialog, replies with `filePathPicked` carrying the resulting string or null |
| host → webview | `focusField` | `{ field: 'connection' }` | Triggered by the Open Settings entrypoint when invoked from the missing-URL toast |

The legacy bulk `saveSettings` message is **removed** because there is no bulk-save path anymore.

### File organization inside `settingsWebview.ts`

The file currently inlines HTML+CSS+JS in one template literal. We keep it single-file but split the template literal into three string constants — `SETTINGS_CSS`, `SETTINGS_HTML`, `SETTINGS_SCRIPT` — composed in `_getHtmlForWebview`. This keeps the file scannable and makes the script section easier to edit/test, without introducing a build step.

If the file grows past ~600 lines after the rework, split into `webview/settings.html.ts`, `webview/settings.css.ts`, `webview/settings.script.ts` siblings. Threshold check applies after implementation.

---

## Error handling

- All host-side message handlers `try/catch` and reply with an explicit error message; webview surfaces those inline (status line under the relevant card or modal).
- `setConnectionString` failure → `connectionStringError` with a string; webview shows it under the URL field in red, and does NOT update the loaded value (so blur-save will retry on next blur).
- `saveProfiles` write failure → similar pattern, modal stays open with an error banner at the top.
- `pickFilePath` host-side rejection (rare) is silent; the dialog just doesn't open.

## Testing

This project uses `node --test` (see `package.json` scripts). Tests run against compiled JS.

Unit-testable surface:

- `ConfigManager.promptMissingConnectionString` — verify it calls `showErrorMessage` with the right button and dispatches the focus payload on click. Stub `vscode.window.showErrorMessage` and `vscode.commands.executeCommand`.
- Profile validation logic — extract validators (`validateName`, `validateTableName`, `validateFilePath`) into a small pure module `src/profileValidation.ts` so they can be unit-tested without spinning up a webview. The host-side `saveProfile` handler uses this module as the authoritative check. The webview script can't import TS modules (it runs as a string-injected script in the webview context), so it inlines the same regex constants and validator logic; both sides therefore validate, with the host as source of truth. The validator module is small enough that the duplication cost is trivial. A test asserts the regex constants match between the module and the webview script string (loaded via the same string constant export from `settingsWebview.ts`).
- File-path resolution for the Browse return value — extract the "is inside workspace? return relative" decision as a pure function and test it.

Webview UI itself is not unit-tested. Manual testing checklist (recorded in PR description, not in repo):

- Light theme: all text legible, borders visible, focus ring shows on tab.
- Dark theme: same.
- High-contrast theme: borders sufficient, no invisible elements.
- Adding/editing/deleting profiles — verify `neon-sync.json` updates correctly.
- Browse picker — verify relative vs absolute path return for both inside-workspace and outside-workspace selections.
- Open Settings from missing-URL error toast — verify connection field gets focus.
- Reduced motion: modal still opens but without scale animation.

## Migration / compatibility

- Users who currently have `neonSync.configureUrl` bound to a custom shortcut will lose that shortcut silently. The keybinding will simply not resolve. Acceptable risk: the command was undocumented enough that this should affect very few users; the replacement (Open Settings → focus URL) is two extra clicks. Document the removal in `CHANGELOG.md`.
- `neon-sync.json` shape is unchanged. Existing profiles load as-is.
- SecretStorage entry under `neonSync.connectionString` is unchanged.

## Out-of-scope follow-ups (not part of this work)

- No multi-workspace file picker logic (we always use `workspaceFolders[0]`, matching `sync.ts`).
- No bulk import/export of profiles.
- No connection string validation beyond non-empty (the existing "test connection" UX is a separate feature).
