# neon-sync CLI — Design

Date: 2026-09-26
Status: Approved for implementation after review rounds 1–3 (decisions below confirmed by the user)

## Goal

A command-line front-end, `neon-sync`, over the host-agnostic core (`src/core`, see `2026-09-25-core-sync-safety-design.md`), so syncing doesn't require opening an editor — with exactly the extension's safety guarantees (baseline-based direction, conditional uploads, local guard, atomic writes).

It should feel **quick, legible and scriptable**: one short command shows what's out of sync; one more applies it; every command has a non-interactive form with JSON output and meaningful exit codes.

## Confirmed decisions (user)

1. **Shared config.** Profiles and sync history live in per-user locations that the extension and the CLI both use. The extension migrates its per-editor `globalStorage` config there.
2. **Secrets.** The CLI reads the connection string from `NEON_SYNC_DATABASE_URL`, else the OS keychain (`@napi-rs/keyring`). The extension keeps VS Code SecretStorage (a native module in the extension would force per-platform VSIX builds), so the URL is set once per tool.
3. **Distribution.** An npm package `neon-sync` (name available), from `cli/` in this repo, bundled with esbuild into one file that includes `src/core`. `npm i -g neon-sync` / `npx neon-sync`. Node ≥ 20.

## Non-goals (v1)

- Full-screen TUI. Output is plain lines plus inline prompts (`@clack/prompts`).
- Standalone binaries (no-Node executables).
- Remote history / restore, encryption, per-OS path overrides, EOL normalization.
- Publishing to npm — prepared (`npm pack` dry run), published only on the user's go-ahead.

## Safety rule for applying (applies to every command)

A row is applied **without an explicit per-row decision** only when the direction is *known* not to discard unreviewed changes:

| Plan | Auto-applicable (`sync --yes`; pre-selected interactively) |
|---|---|
| `change: 'local'` → upload, `change: 'remote'` → download | yes — unless it is a **large deletion** (below) |
| one side missing and **no baseline** for the profile (first-time setup: copy the other side over) | yes |
| one side missing **with** a baseline (it was deleted since the last sync) | **no** — restoring it may undo a deliberate deletion |
| `change: 'both'` (conflict) | **no** |
| `change: 'unknown'` (no usable history — never synced here, or excludeKeys changed), even with a clear timestamp gap | **no** |

**Large deletion:** the candidate is empty, or it removes more than half of the destination's lines (and at least 10). A crashed app or a bad script truncating a file then gets a human look instead of an unattended upload. The engine exposes `SyncPlan.baselineExists` so hosts can apply the missing-side rule.

"No" rows are resolved only by an explicit decision:
- interactively, a per-row prompt ("Keep which side?"), which states what will be overwritten;
- non-interactively, `--prefer local|remote` **together with explicit profile names** (`sync env --prefer local --yes`). Naming the profile is the decision; `--prefer` without names is a usage error, so no blanket "resolve every conflict one way" exists.

**Forcing a direction** with `pull`/`push` over a destination that changed since the last sync, or whose status is unknown, is a destructive override: confirmed per row interactively (naming what is lost), and requiring `--force` with `--yes`. Overwriting an unchanged side needs nothing extra. (`sync` has no `--force`.)

---

## Part 1 — Shared locations

### Where

`core/paths.ts`:

| | Config (`neon-sync.json`) | Sync state (`sync-state/`, per machine) |
|---|---|---|
| macOS / Linux | `~/.config/neon-sync/` | `~/.local/state/neon-sync/` |
| Windows | `%APPDATA%\neon-sync\` | `%LOCALAPPDATA%\neon-sync\` |

- **Fixed paths, no environment overrides** (no `XDG_CONFIG_HOME`, no `NEON_SYNC_HOME`): the extension host doesn't reliably see shell variables (Dock launches, Flatpak VS Code sets its own `XDG_CONFIG_HOME`), and two tools silently using different directories would judge against different baselines — the one failure mode that can mislead the direction logic. Tests inject a home directory into the path functions instead.
- **Sync state is machine-local** (`~/.local/state`, `%LOCALAPPDATA%`): baselines describe *this* machine. `~/.config` is often synced through dotfiles and `%APPDATA%` roams on domain accounts — fine for profiles, wrong for baselines.
- Directories are created `0700`. `neon-sync.json` is written atomically **through the same symlink-following write as local files** (`core/localFile.writeFileAtomic`), so a config managed by stow/chezmoi/home-manager stays a link; a read-only config (e.g. home-manager in the Nix store) is supported for reading, and writes fail with a clear message.
- **Every writer takes the config lock** (`neon-sync.json.lock`, created with `mkdir`, stale after 10 s) and applies its change to a **fresh read**: `ConfigFileStore.update(fn)`. The settings panel's add/edit/delete, CLI `profile add/remove/rename`, the legacy-secret cleanup and the migration all go through it — so concurrent edits from two hosts merge instead of the last full-list write winning.
- `update` **refuses a corrupt or unreadable config** (error naming the file) instead of treating it as empty — a hand-editing typo plus one save must never wipe every profile. (Previously `saveProfiles` overwrote a corrupt file.)
- An edit keyed by a profile's original name that no longer exists on the fresh read (renamed/removed by the other host meanwhile) is reported, not re-added.
- Not configurable by design: a relocated `XDG_CONFIG_HOME` is ignored (documented). `--config <file>` lets a single CLI run use another profiles file (scripts, experiments); sync state stays machine-local either way.
- **Remote-SSH / devcontainers:** the extension then runs on the remote machine, with that machine's config and state — correct (different machines), but its profile list differs from the local CLI's; documented.
- **WSL:** a CLI inside WSL and Windows VS Code can reach the same file (`/mnt/c/…` vs `C:\…`) yet keep separate state stores. Under WSL (`WSL_DISTRO_NAME` set), profiles whose **resolved real path** (symlinks followed, so `~/win → /mnt/c/…` is caught) is under `/mnt/<drive>/` are a per-row error ("sync this file from Windows, or keep a WSL-side copy") — never judged against a second, possibly stale history. The reverse — Windows VS Code syncing a `\\wsl$\…` / `\\wsl.localhost\…` path that a WSL CLI also syncs — is refused the same way by the extension on Windows.
- Both hosts show the resolved config path: the CLI in `status` (`config path` too), the extension in the settings panel header.

### Extension migration

Runs once per `globalStorage` location, on activation, before anything reads profiles:

1. **Secrets first.** The existing legacy step runs first: a plaintext `connectionString` in the old file is moved into SecretStorage and removed from that file. Migration copies **only normalized `profiles`** — never secrets.
2. **Marker file, not `globalState`.** Completion is recorded as `neon-sync.json.migrated` (target path + time) next to the old file. `globalState` lives on the client, so with Remote-SSH/WSL a flag set on one host would wrongly skip another.
3. **Create or merge, under the config lock** (see *Where*):
   - shared file missing → write the old profiles;
   - shared file present and valid → merge by name: add profiles it lacks, skipping any whose file resolves to the same file as an existing profile (they would clash); for a name in both with different fields, keep the shared one;
   - shared file present but unreadable/corrupt → **abort** migration (no marker), show an error with the path; the extension keeps working from the old file until fixed.
4. **Tell the user what changed:** one notification naming profiles added from this editor (`vscode.env.appName`), kept-shared conflicts, and skipped clashes. (A late-migrating editor can re-add a profile deleted elsewhere — surfacing the added names makes that visible.)
5. The old file stays as a backup (secret-free after step 1) and is never read again.

Downgrading the extension afterwards reads the stale backup; edits made there are not merged back. Documented in the CHANGELOG.

The baseline feature is unreleased, so there is no sync-state to migrate. MRU ordering stays in each editor's `globalState` (UI preference). `Open Settings (JSON)` opens the shared file; its generated example uses `~/example.json`.

Concurrency: both hosts re-read `neon-sync.json` on every use; all writes go through `ConfigFileStore.update` under the config lock (see *Where*).

## Part 2 — Paths in profiles

- **`~` expansion**: `~`, `~/…` and, on Windows, `~\…` expand to the home directory in `core/localFile.resolveProfilePath` for both hosts. `~user` is not expanded (left literal).
- **Relative paths** keep their extension meaning (first workspace folder). The CLI has no workspace, and resolving against the current directory would make the same profile hit different files depending on where it runs — so in the CLI a relative-path profile is **a per-row error** (`✗ relative path — use ~/… or an absolute path, or pass --base <dir>`), not a global failure. `--base <dir>` resolves them for one invocation.
- **Settings panel "Browse…"** stores `~/…` for files under the home directory and absolute paths otherwise (it used to store workspace-relative paths). `_resolveDefaultUri` expands `~` too. Profiles can no longer be made workspace-relative through Browse (typing a relative path still works in the extension); noted in the CHANGELOG.

## Part 3 — Secrets

`cli/src/secrets.ts`, behind an interface (tests use an in-memory store):

- `NEON_SYNC_DATABASE_URL` wins when set (scripts, CI).
- Otherwise the keychain (service `neon-sync`, account `database-url`). `@napi-rs/keyring` is **loaded lazily**, only when the env var is unset; a failure to load (no prebuilt binary for the platform) or to reach the keychain (Linux without Secret Service) is reported as "keychain unavailable — set NEON_SYNC_DATABASE_URL". Never a plaintext fallback.
- The URL is never printed. `set-url` reads it from a hidden prompt or stdin, never argv (shell history). `config test` prints only host and database.

## Part 4 — Commands

```
neon-sync                               = neon-sync status (all profiles)
neon-sync status [names…] [--json]
neon-sync sync   [names…] [--yes] [--prefer local|remote (needs names)] [--dry-run] [--json]
neon-sync pull   <names…|--all> [--yes] [--force] [--dry-run] [--json]    force download (Local ← Remote)
neon-sync push   <names…|--all> [--yes] [--force] [--dry-run] [--json]    force upload (Remote ← Local)
neon-sync diff   <name> [--direction upload|download]
neon-sync edit   <name> [--direction upload|download] [--tool code]
neon-sync profile list | show <name> | add | remove <name> | rename <old> <new>
neon-sync config path | set-url | clear-url | test
neon-sync init-db [--table <name>]

Global: --base <dir>  --config <file>  --no-color  --ascii  --help  --version
```

- Bare `neon-sync` takes no profile names — names always follow a subcommand, so a profile called `push` can never be mistaken for the command.
- **Name matching:** exact names always work. Unambiguous case-insensitive prefixes are accepted **only interactively** (TTY, no `--yes`, no `--json`); scripts must use exact names (after deleting `env`, `push env --yes` must not hit `env-prod`).
- Vocabulary: directions are `upload`/`download` (arrows `↑`/`↓`); sides are `local`/`remote` (`--prefer local` = keep local = upload).

### `status`

One batch fetch (`SyncEngine.plan`), one line per profile, config path in the header:

```
 neon-sync · 5 profiles · ep-cool-rain-123.neon.tech/neondb · ~/.config/neon-sync

  ✓  vscode-settings   ~/Library/…/settings.json      in sync
  ↓  antigravity       ~/.gemini/…/settings.json      remote changed          +12 −3
  ↑  zsh-aliases       ~/.zsh_aliases                 local changed           +2 −0
  ⚠  env               ~/proj/.env                    both changed            decide
  ?  karabiner         ~/.config/karabiner/…json      no history · newer ↑    decide
  ✗  notes             notes.md                       relative path
```

`✓` identical · `↑`/`↓` known direction · `⚠` conflict or deleted-since-sync · `?` no history (timestamp guess shown, never auto-applied) · `✗` error (parse error, missing both, shared file, relative path, WSL Windows-drive path). Large deletions show `decide` like conflicts. `--ascii` (automatic when the terminal can't render UTF-8, e.g. legacy Windows consoles) uses `=`, `^`, `v`, `!`, `?`, `x`.

`--json`: `{ configPath, profiles: [{ name, filePath, status, change, direction, ambiguous, autoApplicable, reason, added, removed, error }] }`.

`status` may refresh baselines for identical profiles (the engine's `plan()` does); that's a local-only bookkeeping write, documented.

### Applying: `sync`, `pull`, `push`

All three plan fresh, build `ApplyRequest`s, call `SyncEngine.apply` **once** (one atomic remote batch) and print one line per outcome.

- `sync`: suggested directions, subject to the safety rule. `--yes` applies auto-applicable rows and skips the rest (listed with why). `--prefer` (with explicit names) resolves those named rows.
- `pull` / `push`: forced direction; rows where it overwrites a changed or unknown destination need a per-row confirmation, or `--force` with `--yes`.
- Without a TTY and without `--yes`, nothing is applied: the plan is printed, exit code 1.
- `--json` is non-interactive: it requires `--yes` or `--dry-run` (else usage error), and prints `{ outcomes: [{ name, kind, direction, remoteCommitted, error }] }`.
- `--dry-run` prints what would be written, writes nothing to either side.
- Outcome lines mirror the extension: `stale-remote` / `not-applied` / `stale-local` → "changed meanwhile, re-run"; `local-write-failed` + `remoteCommitted` → "remote saved; re-run only rewrites the local file".

Interactive flow (TTY):

```
◆  Apply which?  (space toggles, enter confirms)
│  ◼ ↓ antigravity      remote changed     +12 −3
│  ◼ ↑ zsh-aliases      local changed      +2 −0
│  ◻ ⚠ env              both changed — you'll pick a side
│  ◻ ? karabiner        no sync history — you'll pick a side
└
◆  env: both changed since 2026-09-20 14:02. Keep which side?
│  ○ Local (upload — overwrites remote changes)
│  ○ Remote (download — overwrites local changes)
│  ○ Show diff    ○ Skip
```

Only auto-applicable rows start selected. Picking a side for a `⚠`/`?` row is itself the per-row confirmation.

### `diff`

Colored unified diff of candidate vs destination in the plan's (or given) direction, excluded keys stripped — the extension's diff view. Paged through `$PAGER` (default `less -R`; none on Windows unless `$PAGER` is set) when stdout is a TTY and the diff is taller than the terminal.

### `edit`

The counterpart of editing the diff editor's right side:

1. Direction: the plan's if auto-applicable, else asked (or `--direction`).
2. Write the stripped candidate to a `0600` file in a private temp dir, **keeping the profile's file extension** (editor syntax highlighting); for `--tool code`, the source side too.
3. Run `$VISUAL` / `$EDITOR` (split into command + args, e.g. `code --wait`), or `code --wait --diff <source> <candidate>`; on Windows `code` is spawned through the shell (`code.cmd`).
4. On exit: if it returned within ~1 s and the file is unchanged, warn that the editor probably didn't wait (`--wait`) and abort; unchanged → ask whether to apply as is; changed → show the diff of the edit and confirm; empty → abort. For rows that are not auto-applicable (conflict, unknown, deleted-since-sync, large deletion) the confirmation shows **the edited file against the destination** — i.e. what the destination loses — not just the edit.
5. Apply through `SyncEngine.apply` with the edited candidate. Temp files are always removed.

### `profile`, `config`, `init-db`

- `profile list` (name, path with `~`, table/id, excluded keys) · `show` · `add` (prompts, or `--file --id --table --exclude`; validated with `core/profileValidation`; file stored as `~/…`/absolute) · `remove` · `rename` (safe: baselines aren't keyed by name).
- `config path` · `set-url` · `clear-url` · `test` (connect + one query).
- `init-db`: `CREATE TABLE IF NOT EXISTS` with the documented schema (default `json_records`).

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Nothing pending / everything requested was applied |
| 1 | Rows pending or needing a decision (nothing failed, nothing stuck) |
| 2 | Usage or configuration error — nothing was attempted (bad args, no URL, unknown/ambiguous name, `--json` without `--yes`/`--dry-run`, `--prefer` without names) |
| 3 | Apply or runtime failure: stale / not-applied / failed rows, database or network errors |
| 4 | Rows that can't sync until something is fixed (parse error, missing both, shared file, relative path, WSL Windows-drive path) |

When several apply, the highest-priority one wins: **3 > 4 > 1 > 0** (2 always stops before any work). So cron can tell "needs a decision" (1) from "stuck until fixed" (4) from "something went wrong" (3).

### Output

`picocolors`; honors `NO_COLOR`, `--no-color`, non-TTY stdout. No colors/spinners with `--json` or when piped. Errors on stderr.

## Part 5 — Code layout and build

```
cli/
  package.json     publish manifest only: name "neon-sync", bin → dist/neon-sync.cjs, engines node >= 20,
                   dependencies: { "@napi-rs/keyring" } (the only runtime dependency — everything else is bundled)
  src/main.ts      argument parsing (node:util parseArgs), dispatch, exit codes
  src/host.ts      paths, secrets, engine construction, --base resolution
  src/commands/*.ts
  src/ui/*.ts      table, diff rendering, prompts (behind an interface for tests)
  build.mjs        esbuild → dist/neon-sync.cjs (platform node, format cjs, mainFields ['module','main']
                   so jsonc-parser resolves to its ESM build; external @napi-rs/keyring)
test/cli/*.test.ts (run by the root test runner)
```

- The bundle gets a `#!/usr/bin/env node` banner; `cli/package.json` has a `prepack` script running the root build; its `@napi-rs/keyring` version is kept equal to the root devDependency (checked by a test).
- **One toolchain, one `node_modules`.** CLI build/dev dependencies (`@clack/prompts`, `picocolors`, `diff`, `esbuild`, `@napi-rs/keyring`) go in the **root `devDependencies`** — `vsce` excludes devDependencies, and core imports (`@neondatabase/serverless`, `jsonc-parser`) then resolve to the same copies in tests and in the bundle. `cli/package.json` exists only to publish.
- Root `tsconfig.test.json` includes `cli/src` and `test/cli`; the extension's `tsconfig.json` does not. A second boundary test keeps `cli/src` from importing `src/*.ts` outside `src/core` (and never `vscode`).
- `.vscodeignore` gains `cli/**`; the CI package check asserts no `cli/` file is in the VSIX.
- CI: the existing test job covers CLI tests; a new step builds the bundle and runs `node cli/dist/neon-sync.cjs --help` and `status --json` against PGlite-free inputs (config errors) on all three OSes.

## Part 6 — Extension changes

- `ConfigManager`: shared config path + migration (Part 1); all writes via `ConfigFileStore.update` (the settings panel's add/edit/delete become operations on a fresh read); settings panel shows the path.
- `hostEngine`: `SyncStateStore` at the machine-local state path.
- `core/localFile`: `~` expansion. Settings panel: Browse and default-URI handling (Part 2). Example profile path `~/example.json`.
- README: locations, migration and downgrade notes, CLI section. CHANGELOG entries.

## Testing

- Core: path functions per platform with injected home/env; `~` expansion (incl. `~\` on Windows, `~user` literal).
- Extension migration: fresh copy; merge with name conflicts; same-file clashes skipped; corrupt shared file aborts without marker; legacy secret moved and never copied; marker file per location; lock contention (two migrations at once lose nothing).
- CLI: every command against PGlite via the existing module mock; secrets and prompts injected. The safety rule (`--yes` never applies `both` / `unknown` / deleted-since-sync / large-deletion rows; `--prefer` only with names; `pull`/`push` need confirmation or `--force` over changed/unknown sides), config lock with concurrent writers, symlinked config preserved, WSL `/mnt/` rows, exit codes 0–4 and their precedence, `--json` shapes and its non-interactive requirement, non-TTY refusal, exact-name matching in scripts, relative-path rows and `--base`, `edit` with fake `$EDITOR` scripts (incl. one that exits immediately), `set-url` never reading argv, lazy keyring load failure.
- Bundle: built `dist/neon-sync.cjs` runs in CI on three OSes.

## Rollout

1. Core `paths.ts` + `~` expansion; `ConfigFileStore.update` under a lock with symlink-following writes; `SyncPlan.baselineExists`; extension moves to shared locations with migration and routes all config writes through `update`; Browse/default-URI/example path changes.
2. CLI skeleton: build, `main`, host, secrets, `config`, `profile list/show`, `status` (+ `--json`, exit codes, `--ascii`).
3. `sync` / `pull` / `push` with the safety rule (interactive and non-interactive), `diff`.
4. `edit`, `profile add/remove/rename`, `init-db`.
5. CI bundle job, README, `npm pack` dry run; publish only on the user's go-ahead.

Each step is reviewed (multiple rounds until clean) before the next.
