# codex-switch

Modern Node.js TUI for saving and switching Codex ChatGPT account snapshots.

## Features

- Save the current `~/.codex/auth.json` into global named snapshots
- Switch the active Codex account by restoring a saved snapshot
- Optionally backup and restore `~/.codex/config.toml`
- Detect running Codex processes before you switch
- Use either an interactive TUI or JSON-friendly subcommands
- Build a native macOS menu bar app on top of the same backend

## Install

```bash
npm install
npm run build
```

## Run

Interactive:

```bash
npm run dev
```

Build and run:

```bash
npm run build
node dist/cli.js
```

Build the macOS menu bar app:

```bash
npm run build:menubar
open dist/macos/'Codex Switch.app'
```

## Commands

```bash
codex-switch tui
codex-switch save my-main
codex-switch save work --with-config
codex-switch list
codex-switch current
codex-switch use work
codex-switch use work --restore-config
codex-switch doctor
codex-switch remove work
codex-switch app-state
codex-switch save-current-auto
codex-switch add-account
```

## Storage

Saved snapshots are stored in:

```text
~/.codex-switch/accounts/<name>/
```

Each snapshot contains:

- `auth.json`
- `meta.json`
- `config.toml` when saved with `--with-config`

Snapshot files are written with owner-only permissions.
