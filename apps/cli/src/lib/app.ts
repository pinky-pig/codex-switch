import { spawnSync } from "node:child_process";
import path from "node:path";

import { AUTH_FILE, CODEX_HOME, CONFIG_FILE, STORE_DIR } from "./constants.js";
import {
  getCurrentAccount,
  listStoredAccounts,
  saveCurrentAccount,
} from "./accounts.js";
import type {
  AccountSummary,
  AddAccountFlowResult,
  SaveCurrentAccountAutoResult,
} from "../types.js";

function normalizeBaseName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function inferSuggestedName(summary?: AccountSummary): string {
  const email = summary?.email?.split("@")[0];
  if (email) {
    return normalizeBaseName(email) || "account";
  }

  if (summary?.accountId && summary.accountId !== "unknown") {
    return summary.accountId.slice(0, 12);
  }

  return "account";
}

function makeUniqueName(base: string, existingNames: string[]): string {
  const safeBase = normalizeBaseName(base) || "account";
  const existing = new Set(existingNames);

  if (!existing.has(safeBase)) {
    return safeBase;
  }

  let index = 2;
  while (existing.has(`${safeBase}-${index}`)) {
    index += 1;
  }

  return `${safeBase}-${index}`;
}

function isSameAccount(left: AccountSummary, right: AccountSummary): boolean {
  if (
    left.accountId !== "unknown" &&
    right.accountId !== "unknown" &&
    left.accountId === right.accountId
  ) {
    return true;
  }

  return Boolean(left.email && right.email && left.email === right.email);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function appleScriptQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function buildSelfCliCommand(): string {
  const scriptPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
  if (!scriptPath) {
    return "cxs";
  }

  return `${shellQuote(process.execPath)} ${shellQuote(scriptPath)}`;
}

export async function saveCurrentAccountAuto(options?: {
  includeConfig?: boolean;
}): Promise<SaveCurrentAccountAutoResult> {
  const current = await getCurrentAccount();
  if (!current) {
    throw new Error("No active Codex account found.");
  }

  const existingAccounts = await listStoredAccounts();
  const duplicate = existingAccounts.find((account) =>
    isSameAccount(account.meta.summary, current),
  );

  if (duplicate) {
    return {
      created: false,
      account: duplicate,
    };
  }

  const nextName = makeUniqueName(
    inferSuggestedName(current),
    existingAccounts.map((account) => account.meta.name),
  );

  const account = await saveCurrentAccount(nextName, options);
  return {
    created: true,
    account,
  };
}

export async function completeLoggedInAccount(): Promise<SaveCurrentAccountAutoResult> {
  return saveCurrentAccountAuto();
}

function runInteractiveLogin(): number {
  spawnSync("codex", ["logout"], { stdio: "inherit" });
  const result = spawnSync("codex", ["login"], { stdio: "inherit" });
  return result.status ?? 1;
}

function launchTerminalLogin(): void {
  const cliCommand = buildSelfCliCommand();
  const shellCommand = [
    "export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/sbin:/usr/sbin:/sbin:$PATH",
    "clear",
    "printf '\\n[codex-switch] adding Codex account...\\n\\n'",
    "codex logout",
    "codex login",
    "status=$?",
    "if [ \"$status\" -eq 0 ]; then",
    `  ${cliCommand} complete-login`,
    "else",
    "  printf '\\n[codex-switch] login failed or was canceled.\\n'",
    "fi",
    "printf '\\nPress Enter to close this window...'",
    "read",
    "exit 0",
  ].join("; ");

  const terminalCommand = `zsh -lc ${shellQuote(shellCommand)}`;
  const osa = [
    'tell application "Terminal"',
    "activate",
    `do script ${appleScriptQuote(terminalCommand)}`,
    "end tell",
  ];

  const result = spawnSync("osascript", osa.flatMap((line) => ["-e", line]), {
    stdio: "inherit",
  });

  if ((result.status ?? 1) !== 0) {
    throw new Error("Failed to open Terminal for Codex login.");
  }
}

export async function addCodexAccount(options?: {
  launchMode?: "auto" | "inline" | "terminal";
}): Promise<AddAccountFlowResult> {
  const launchMode =
    options?.launchMode ??
    (process.stdin.isTTY && process.stdout.isTTY ? "inline" : "terminal");

  const previous = (await getCurrentAccount()) ? await saveCurrentAccountAuto() : undefined;

  if (launchMode === "terminal") {
    launchTerminalLogin();
    return {
      ok: true,
      phase: "terminal-launched",
      previous,
      message: "Opened Terminal for Codex login.",
    };
  }

  const loginStatus = runInteractiveLogin();
  if (loginStatus !== 0) {
    throw new Error("Codex login did not complete successfully.");
  }

  const current = await completeLoggedInAccount();
  return {
    ok: true,
    phase: "completed",
    previous,
    current,
    message: current.created
      ? `Saved the new account as "${current.account.meta.name}".`
      : `The logged-in account already exists as "${current.account.meta.name}".`,
  };
}

export async function getAppState(): Promise<{
  storeDir: string;
  runtime: {
    codexHome: string;
    authPath: string;
    configPath: string;
    current?: AccountSummary;
  };
  accounts: Array<{
    name: string;
    savedAt: string;
    includesConfig: boolean;
    active: boolean;
    summary: AccountSummary;
    }>;
}> {
  const current = await getCurrentAccount();
  const accounts = await listStoredAccounts();

  return {
    storeDir: STORE_DIR,
    runtime: {
      codexHome: CODEX_HOME,
      authPath: AUTH_FILE,
      configPath: CONFIG_FILE,
      current,
    },
    accounts: accounts.map((account) => ({
      name: account.meta.name,
      savedAt: account.meta.savedAt,
      includesConfig: account.meta.includesConfig,
      active:
        account.meta.summary.accountId !== "unknown" &&
        account.meta.summary.accountId === current?.accountId,
      summary: account.meta.summary,
    })),
  };
}
