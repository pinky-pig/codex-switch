# Codex Switch Menu Bar App

This directory contains a native macOS menu bar wrapper for `codex-switch`.

## What it does

- Shows the current active Codex account
- Shows `expires`, `auth`, and `config` paths
- Shows the saved account list
- Triggers these existing CLI flows:
  - `cxs use`
  - `cxs remove`
  - `cxs save-current-auto`
  - `cxs add-account`

## Build

From the repo root:

```bash
pnpm build:menubar
```

That creates:

```text
apps/macos-menubar/dist/Codex Switch.app
```

## Notes

- The app is a menu bar agent (`LSUIElement=true`), so it does not show a Dock icon.
- The build step copies a runtime CLI to `~/.codex-switch/bin/codex-switch-runtime.mjs`.
- `添加 Codex 账号` reuses the CLI login flow and opens Terminal for the official `codex login` process when needed.
