import os from "node:os";
import path from "node:path";

export const HOME_DIR = os.homedir();
export const CODEX_HOME = process.env.CODEX_HOME
  ? path.resolve(process.env.CODEX_HOME)
  : path.join(HOME_DIR, ".codex");

export const AUTH_FILE = path.join(CODEX_HOME, "auth.json");
export const CONFIG_FILE = path.join(CODEX_HOME, "config.toml");
export const STORE_DIR = path.join(HOME_DIR, ".codex-switch");
export const ACCOUNTS_DIR = path.join(STORE_DIR, "accounts");
export const LEGACY_LOCAL_STORE_DIR = path.resolve(process.cwd(), ".codex-switch");
export const LEGACY_LOCAL_ACCOUNTS_DIR = path.join(LEGACY_LOCAL_STORE_DIR, "accounts");

export const FILE_MODE_OWNER_ONLY = 0o600;
