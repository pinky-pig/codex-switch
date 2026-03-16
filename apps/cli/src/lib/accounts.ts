import fs from "node:fs/promises";
import path from "node:path";

import {
  ACCOUNTS_DIR,
  AUTH_FILE,
  CODEX_HOME,
  CONFIG_FILE,
  LEGACY_LOCAL_ACCOUNTS_DIR,
} from "./constants.js";
import {
  copyFileSecure,
  ensureDir,
  pathExists,
  readJsonFile,
  removeDir,
  safeReadText,
  writeJsonSecure,
  writeTextAtomic,
} from "./fs.js";
import { listCodexProcesses } from "./process.js";
import type {
  AccountSummary,
  AuthFile,
  JwtClaims,
  RateLimitsSummary,
  RateLimitWindow,
  RuntimeStatus,
  SaveAccountOptions,
  StoredAccountUsage,
  StoredAccount,
  StoredAccountMeta,
  SwitchAccountOptions,
} from "../types.js";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const REFRESH_URL = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

function decodeBase64Url(input: string): string {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? 0 : 4 - (normalized.length % 4);

  return Buffer.from(`${normalized}${"=".repeat(padding)}`, "base64").toString("utf8");
}

function decodeJwtClaims(token?: string | null): JwtClaims | undefined {
  if (!token) {
    return undefined;
  }

  const parts = token.split(".");
  if (parts.length < 2) {
    return undefined;
  }

  try {
    const payload = decodeBase64Url(parts[1]);
    return JSON.parse(payload) as JwtClaims;
  } catch {
    return undefined;
  }
}

function buildAccountSummary(authFile: AuthFile): AccountSummary {
  const claims =
    decodeJwtClaims(authFile.tokens?.id_token) ??
    decodeJwtClaims(authFile.tokens?.access_token);

  const expiresAt =
    claims?.exp !== undefined ? new Date(claims.exp * 1000).toISOString() : undefined;

  return {
    accountId:
      authFile.tokens?.account_id ??
      claims?.chatgptAccountId?.toString() ??
      "unknown",
    email: typeof claims?.email === "string" ? claims.email : undefined,
    name: typeof claims?.name === "string" ? claims.name : undefined,
    planType:
      typeof claims?.chatgptPlanType === "string" ? claims.chatgptPlanType : undefined,
    authMode: authFile.auth_mode,
    lastRefresh: authFile.last_refresh,
    expiresAt,
  };
}

async function readAuthSummary(authPath: string): Promise<AccountSummary> {
  const authFile = await readJsonFile<AuthFile>(authPath);
  return buildAccountSummary(authFile);
}

function getAccountDir(name: string): string {
  return path.join(ACCOUNTS_DIR, name);
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

function sanitizeName(name: string): string {
  const normalized = name.trim().toLowerCase();
  if (!normalized) {
    throw new Error("Account name is required.");
  }

  const safe = normalized.replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!safe) {
    throw new Error("Account name became empty after sanitization.");
  }

  return safe;
}

type UsageApiWindow = {
  used_percent?: number;
  reset_at?: number;
  reset_after_seconds?: number;
  limit_window_seconds?: number;
};

type UsageApiResponse = {
  plan_type?: string | null;
  rate_limit?: {
    primary_window?: UsageApiWindow;
    secondary_window?: UsageApiWindow;
  } | null;
};

function matchesCurrentAccount(
  accountSummary: AccountSummary,
  currentSummary?: AccountSummary,
): boolean {
  if (!currentSummary) {
    return false;
  }

  return isSameAccount(accountSummary, currentSummary);
}

function parseIsoDate(value?: string): Date | undefined {
  if (!value) {
    return undefined;
  }

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return undefined;
  }

  return new Date(timestamp);
}

function buildUsageWindow(
  window: UsageApiWindow | undefined,
  nowSeconds: number,
): RateLimitWindow | undefined {
  if (!window) {
    return undefined;
  }

  const resetSeconds =
    typeof window.reset_at === "number"
      ? window.reset_at
      : typeof window.reset_after_seconds === "number"
        ? nowSeconds + window.reset_after_seconds
        : undefined;

  return {
    usedPercent:
      typeof window.used_percent === "number" ? window.used_percent : undefined,
    windowMinutes:
      typeof window.limit_window_seconds === "number"
        ? Math.round(window.limit_window_seconds / 60)
        : undefined,
    resetsAt:
      typeof resetSeconds === "number"
        ? new Date(resetSeconds * 1000).toISOString()
        : undefined,
  };
}

function buildUsageSummary(payload: UsageApiResponse): RateLimitsSummary {
  const nowSeconds = Math.floor(Date.now() / 1000);

  return {
    planType: payload.plan_type ?? undefined,
    primary: buildUsageWindow(payload.rate_limit?.primary_window, nowSeconds),
    secondary: buildUsageWindow(payload.rate_limit?.secondary_window, nowSeconds),
  };
}

async function fetchUsageRequest(
  accessToken: string,
  accountId?: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    "Cache-Control": "no-cache, no-store, max-age=0",
    Pragma: "no-cache",
    "User-Agent": "codex-switch/0.1.0",
  };

  if (accountId) {
    headers["ChatGPT-Account-Id"] = accountId;
  }

  const url = new URL(USAGE_URL);
  url.searchParams.set("_ts", Date.now().toString());

  return fetch(url, {
    method: "GET",
    headers,
    cache: "no-store",
  });
}

async function refreshAuthTokens(authFile: AuthFile): Promise<AuthFile> {
  const refreshToken = authFile.tokens?.refresh_token;
  if (!refreshToken) {
    throw new Error("No refresh token available.");
  }

  const response = await fetch(REFRESH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
      scope: "openid profile email",
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || `Refresh failed with status ${response.status}`);
  }

  const payload = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
  };

  if (!payload.access_token) {
    throw new Error("Refresh response missing access_token.");
  }

  return {
    ...authFile,
    last_refresh: new Date().toISOString(),
    tokens: {
      ...authFile.tokens,
      access_token: payload.access_token,
      refresh_token: payload.refresh_token ?? authFile.tokens?.refresh_token ?? null,
      id_token: payload.id_token ?? authFile.tokens?.id_token ?? null,
    },
  };
}

async function fetchUsageSummaryForAuth(authFile: AuthFile): Promise<{
  usage: RateLimitsSummary;
  authFile: AuthFile;
}> {
  const accessToken = authFile.tokens?.access_token;
  const accountId =
    authFile.tokens?.account_id ??
    (() => {
      const summary = buildAccountSummary(authFile);
      return summary.accountId !== "unknown" ? summary.accountId : undefined;
    })();

  if (!accessToken) {
    throw new Error("No access token available.");
  }

  let response = await fetchUsageRequest(accessToken, accountId);
  let activeAuth = authFile;

  if (response.status === 401 || response.status === 403) {
    activeAuth = await refreshAuthTokens(authFile);
    const refreshedAccessToken = activeAuth.tokens?.access_token;
    if (!refreshedAccessToken) {
      throw new Error("Refreshed auth is missing access token.");
    }

    response = await fetchUsageRequest(
      refreshedAccessToken,
      activeAuth.tokens?.account_id ?? undefined,
    );
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || `Usage request failed with status ${response.status}`);
  }

  const payload = (await response.json()) as UsageApiResponse;
  return {
    usage: buildUsageSummary(payload),
    authFile: activeAuth,
  };
}

function mergeUsageError(
  existing: StoredAccountUsage | undefined,
  message: string,
): StoredAccountUsage {
  return {
    fetchedAt: new Date().toISOString(),
    planType: existing?.planType,
    primary: existing?.primary,
    secondary: existing?.secondary,
    error: message,
  };
}

async function persistStoredAccountState(options: {
  account: StoredAccount;
  authFile?: AuthFile;
  usage?: RateLimitsSummary;
  error?: string;
  current?: AccountSummary;
}): Promise<StoredAccount> {
  const accountDir = path.dirname(options.account.authPath);
  const metaPath = path.join(accountDir, "meta.json");
  let nextSummary = options.account.meta.summary;

  if (options.authFile) {
    await writeJsonSecure(options.account.authPath, options.authFile);
    nextSummary = buildAccountSummary(options.authFile);

    if (matchesCurrentAccount(options.account.meta.summary, options.current)) {
      await writeJsonSecure(AUTH_FILE, options.authFile);
    }
  }

  const nextUsage = options.error
    ? mergeUsageError(options.account.meta.usage, options.error)
    : options.usage
      ? {
          fetchedAt: new Date().toISOString(),
          planType: options.usage.planType,
          primary: options.usage.primary,
          secondary: options.usage.secondary,
          error: undefined,
        }
      : options.account.meta.usage;

  const nextMeta: StoredAccountMeta = {
    ...options.account.meta,
    summary: nextSummary,
    usage: nextUsage,
  };

  await writeJsonSecure(metaPath, nextMeta);

  return {
    ...options.account,
    meta: nextMeta,
  };
}

export async function ensureStore(): Promise<void> {
  await ensureDir(ACCOUNTS_DIR);
  await migrateLegacyLocalAccounts();
}

async function migrateLegacyLocalAccounts(): Promise<void> {
  if (!(await pathExists(LEGACY_LOCAL_ACCOUNTS_DIR))) {
    return;
  }

  const entries = await fs.readdir(LEGACY_LOCAL_ACCOUNTS_DIR, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const sourceDir = path.join(LEGACY_LOCAL_ACCOUNTS_DIR, entry.name);
    const targetDir = path.join(ACCOUNTS_DIR, entry.name);

    if (await pathExists(targetDir)) {
      continue;
    }

    await fs.cp(sourceDir, targetDir, { recursive: true });
  }
}

export async function getCurrentAccount(): Promise<AccountSummary | undefined> {
  if (!(await pathExists(AUTH_FILE))) {
    return undefined;
  }

  return readAuthSummary(AUTH_FILE);
}

export async function saveCurrentAccount(
  name: string,
  options: SaveAccountOptions = {},
): Promise<StoredAccount> {
  if (!(await pathExists(AUTH_FILE))) {
    throw new Error(`Codex auth file not found at ${AUTH_FILE}`);
  }

  await ensureStore();

  const safeName = sanitizeName(name);
  const accountDir = getAccountDir(safeName);
  const authTargetPath = path.join(accountDir, "auth.json");
  const configTargetPath = path.join(accountDir, "config.toml");
  const metaPath = path.join(accountDir, "meta.json");
  const summary = await readAuthSummary(AUTH_FILE);
  const existingAccounts = await listStoredAccounts();
  const duplicate = existingAccounts.find((account) =>
    isSameAccount(account.meta.summary, summary),
  );

  if (duplicate) {
    return duplicate;
  }

  await ensureDir(accountDir);
  await copyFileSecure(AUTH_FILE, authTargetPath);

  let includesConfig = false;
  if (options.includeConfig && (await pathExists(CONFIG_FILE))) {
    await copyFileSecure(CONFIG_FILE, configTargetPath);
    includesConfig = true;
  }

  const meta: StoredAccountMeta = {
    name: safeName,
    savedAt: new Date().toISOString(),
    sourceAuthPath: AUTH_FILE,
    includesConfig,
    summary,
  };

  await writeJsonSecure(metaPath, meta);

  return {
    meta,
    authPath: authTargetPath,
    configPath: includesConfig ? configTargetPath : undefined,
  };
}

export async function listStoredAccounts(): Promise<StoredAccount[]> {
  await ensureStore();
  const entries = await fs.readdir(ACCOUNTS_DIR, { withFileTypes: true });
  const accounts: StoredAccount[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const accountDir = path.join(ACCOUNTS_DIR, entry.name);
    const metaPath = path.join(accountDir, "meta.json");
    const authPath = path.join(accountDir, "auth.json");
    const configPath = path.join(accountDir, "config.toml");

    if (!(await pathExists(metaPath)) || !(await pathExists(authPath))) {
      continue;
    }

    const meta = await readJsonFile<StoredAccountMeta>(metaPath);
    accounts.push({
      meta,
      authPath,
      configPath: (await pathExists(configPath)) ? configPath : undefined,
    });
  }

  return accounts.sort((left, right) =>
    right.meta.savedAt.localeCompare(left.meta.savedAt),
  );
}

export async function getStoredAccount(name: string): Promise<StoredAccount> {
  const safeName = sanitizeName(name);
  const accounts = await listStoredAccounts();
  const account = accounts.find((item) => item.meta.name === safeName);

  if (!account) {
    throw new Error(`Saved account "${safeName}" not found.`);
  }

  return account;
}

export async function switchToAccount(
  name: string,
  options: SwitchAccountOptions = {},
): Promise<StoredAccount> {
  const account = await getStoredAccount(name);
  const authContent = await safeReadText(account.authPath);

  if (!authContent) {
    throw new Error(`Saved auth file missing at ${account.authPath}`);
  }

  await ensureDir(CODEX_HOME);
  await writeTextAtomic(AUTH_FILE, authContent);

  if (options.restoreConfig && account.configPath) {
    const configContent = await safeReadText(account.configPath);
    if (configContent) {
      await writeTextAtomic(CONFIG_FILE, configContent);
    }
  }

  return account;
}

export async function removeStoredAccount(name: string): Promise<void> {
  const safeName = sanitizeName(name);
  await removeDir(getAccountDir(safeName));
}

export async function refreshAllStoredAccountUsage(): Promise<{
  updated: StoredAccount[];
  failed: Array<{ name: string; error: string }>;
}> {
  const current = await getCurrentAccount();
  const accounts = await listStoredAccounts();
  const updated: StoredAccount[] = [];
  const failed: Array<{ name: string; error: string }> = [];

  for (const account of accounts) {
    try {
      const storedAuth = await readJsonFile<AuthFile>(account.authPath);
      const result = await fetchUsageSummaryForAuth(storedAuth);
      const persisted = await persistStoredAccountState({
        account,
        authFile: result.authFile,
        usage: result.usage,
        current,
      });
      updated.push(persisted);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      const persisted = await persistStoredAccountState({
        account,
        error: message,
        current,
      });
      updated.push(persisted);
      failed.push({
        name: account.meta.name,
        error: message,
      });
    }
  }

  return {
    updated,
    failed,
  };
}

export async function getRuntimeStatus(): Promise<RuntimeStatus> {
  const current = await getCurrentAccount();
  const codexProcesses = await listCodexProcesses();

  return {
    codexHome: CODEX_HOME,
    authPath: AUTH_FILE,
    configPath: CONFIG_FILE,
    current,
    codexProcesses,
  };
}
