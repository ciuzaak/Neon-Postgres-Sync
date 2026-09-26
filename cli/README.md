# neon-sync

Sync local config files (editor settings, dotfiles, `.env` files…) with rows in a Neon Postgres table — from the terminal. It's the command-line companion to the [Neon Postgres Sync](https://marketplace.visualstudio.com/items?itemName=ciuzaak.neon-postgres-sync) VS Code extension: both use the same profiles and the same sync history, so you can use either (or both) on any machine.

```
$ neon-sync

 neon-sync · 4 profiles · ep-cool-rain-123.neon.tech/neondb · ~/.config/neon-sync/neon-sync.json

  ✓  vscode-settings  ~/.config/Code/User/settings.json    in sync
  ↓  antigravity      ~/.gemini/antigravity/settings.json  remote changed  +12 −3
  ↑  zsh              ~/.zshrc                             local changed   +2 −0
  ⚠  env              ~/projects/app/.env                  both changed    decide

  2 ready to apply · 1 needs a decision
  Run `neon-sync sync` to review and apply.
```

## Install

```bash
npm install -g @ciuzaakwong/neon-sync
```

Node.js 20.12 or newer. The command is `neon-sync`. (Or run it without installing: `npx @ciuzaakwong/neon-sync`.)

## Quick start

```bash
neon-sync config set-url      # paste your postgres:// URL (stored in the OS keychain)
neon-sync init-db             # create the table if you don't have one yet
neon-sync profile add zsh --file ~/.zshrc --id zshrc
neon-sync                     # what's out of sync — then offers to apply it
```

Already using the VS Code extension? Its profiles are picked up automatically once an extension version with shared profiles (the release after 0.7.0) has run on that machine — just set the URL.

## How it decides what to do

After every sync, each machine records what both sides looked like. Next time, each side is compared with that record:

| Since the last sync | What `neon-sync sync` does |
|---|---|
| only the local file changed | uploads it |
| only the remote record changed | downloads it |
| both changed | **asks you** (conflict) |
| no sync history on this machine yet, or the profile's `--exclude` keys changed since | **asks you** (timestamps are only a guess) |
| one side was deleted since the last sync | **asks you** (restore it, or skip — deletions are never synced) |
| a change would delete most of the other side | **asks you** (large deletion) |
| one side doesn't exist yet (first time) | copies the other side over |

Every write is safe against concurrent changes: if another machine changed the remote record, or you saved the local file, after `neon-sync` looked at it, nothing is overwritten — you're told to re-run.

## Commands

| Command | |
|---|---|
| `neon-sync` | Status of every profile; in a terminal, offers to apply. |
| `neon-sync status [names…]` | What's out of sync. `--json` for scripts. |
| `neon-sync sync [names…]` | Apply what's safe and ask about the rest (see the table above). |
| `neon-sync pull <names…\|--all>` | Download (Local ← Remote). |
| `neon-sync push <names…\|--all>` | Upload (Remote ← Local). |
| `neon-sync diff <name>` | Show what would change. `--direction upload\|download`. |
| `neon-sync edit <name>` | Edit what will be written in `$VISUAL` / `$EDITOR`, then confirm. `--direction upload\|download` picks the side; `--tool code` opens a VS Code diff. |
| `neon-sync profile list \| show \| add \| remove \| rename` | Manage profiles. `remove` asks first (`--yes` when not in a terminal). |
| `neon-sync init-db [--table name]` | Create the sync table (default `json_records`). |
| `neon-sync config path \| set-url \| clear-url \| test` | Where things live; the database URL. |

Useful flags for `sync`, `pull` and `push`: `-y`/`--yes` (don't ask; only safe rows are applied), `--dry-run` (show what would be written), `--json`. Also `--prefer local|remote` with `sync` (decide the named profiles' conflicts: `neon-sync sync env --prefer local --yes`) and `--force --yes` with `pull`/`push` (overwrite a side that has its own changes, unattended — in a terminal you're asked per row instead). Everywhere: `--no-color` (or `NO_COLOR`, `TERM=dumb`), `--ascii`.

Profile names must be exact, except interactively — in a terminal, without `--yes` or `--json` — where a unique prefix is enough (`neon-sync diff anti`). `profile remove` and `profile rename` always need the exact name.

### Profiles

```bash
neon-sync profile add app --file ~/.config/app/settings.json --id app-settings \
    --exclude theme --exclude window.zoom
```

`--exclude` hides JSON/JSONC keys from syncing: each machine keeps its own value (themes, zoom levels, machine IDs). A dot means nesting — `window.zoom` is the key `zoom` inside the object `window`. Keys whose own name contains a dot (like VS Code's flat `"editor.fontSize"`) can't be excluded yet.

A relative `--file` is resolved against the current directory (or `--base <dir>`), and paths are stored as `~/…` so the same profile works on every machine with the same layout. Each profile needs its own file and its own record.

## Scripts and cron

Without a terminal, nothing is written unless you pass `--yes` — and even then only rows that are safe (no conflicts, guesses, deletions or large deletions).

```bash
# every hour: apply safe changes, report the rest
neon-sync sync --yes --json > /tmp/neon-sync.json
case $? in
  0) ;;                                        # everything in sync / applied
  1) echo "neon-sync: something needs a decision" ;;
  3) echo "neon-sync: a sync failed (see the log)" ;;
  4) echo "neon-sync: a profile can't sync until fixed" ;;
  *) echo "neon-sync: configuration problem" ;;
esac
```

| Exit code | Meaning |
|---|---|
| 0 | Everything in sync, or everything requested was applied |
| 1 | Something is pending or needs a decision (nothing failed) |
| 2 | Usage or configuration error (nothing was attempted) |
| 3 | A sync failed (changed meanwhile, database or network error) |
| 4 | A profile can't sync until something is fixed (e.g. a relative path, two profiles on one file) |

When several apply: 3 beats 4 beats 1 beats 0. (If a reader such as `head` closes the pipe early, neon-sync stops quietly with 141, like any command killed by SIGPIPE.)

## Where things live

| | macOS / Linux | Windows |
|---|---|---|
| Profiles (shared with the extension) | `~/.config/neon-sync/neon-sync.json` | `%APPDATA%\neon-sync\neon-sync.json` |
| Sync history (this machine only) | `~/.local/state/neon-sync/sync-state/` | `%LOCALAPPDATA%\neon-sync\sync-state\` |
| Database URL | `NEON_SYNC_DATABASE_URL`, else the OS keychain | same |

These locations are fixed on purpose (`XDG_CONFIG_HOME` is ignored), so every tool on a machine reads the same history. The profiles file may be a symlink managed by your dotfiles tool. `--config <file>` points a single run at another profiles file.

The URL is never printed (errors show `postgres://[redacted]@host/db`), never read from the command line (it would end up in your shell history), and never stored in plain text.

The database table needs this shape (`neon-sync init-db` creates it):

```sql
CREATE TABLE json_records (id TEXT PRIMARY KEY, data TEXT, create_time TIMESTAMP, update_time TIMESTAMP);
```

## License

MIT
