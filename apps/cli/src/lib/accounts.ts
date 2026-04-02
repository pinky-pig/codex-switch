import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";

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
  ImportAccountOptions,
  ImportAccountResult,
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
  const importedLabel = getImportedLabel(authFile);
  const importedEmail =
    importedLabel && importedLabel.includes("@") ? importedLabel : undefined;

  const expiresAt =
    claims?.exp !== undefined ? new Date(claims.exp * 1000).toISOString() : undefined;

  return {
    accountId:
      authFile.tokens?.account_id ??
      claims?.chatgptAccountId?.toString() ??
      (typeof authFile.meta?.chatgptAccountId === "string"
        ? authFile.meta.chatgptAccountId
        : undefined) ??
      "unknown",
    email:
      typeof claims?.email === "string" && claims.email.trim().length > 0
        ? claims.email
        : importedEmail,
    name:
      typeof claims?.name === "string" && claims.name.trim().length > 0
        ? claims.name
        : importedLabel,
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

function normalizeBaseName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
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

function parseExportedAtTimestamp(value: number | string | null | undefined): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value * 1000).toISOString();
  }

  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return new Date(parsed * 1000).toISOString();
    }
  }

  return undefined;
}

function getImportedLabel(authFile: AuthFile): string | undefined {
  const label = authFile.meta?.label;
  if (typeof label !== "string") {
    return undefined;
  }

  const trimmed = label.trim();
  return trimmed || undefined;
}

function inferImportedAccountName(authFile: AuthFile, summary: AccountSummary): string {
  const importedLabel = getImportedLabel(authFile);
  if (importedLabel) {
    const preferredBase = importedLabel.includes("@")
      ? importedLabel.split("@")[0] ?? importedLabel
      : importedLabel;
    const normalized = normalizeBaseName(preferredBase);
    if (normalized) {
      return normalized;
    }
  }

  const emailBase = summary.email?.split("@")[0];
  if (emailBase) {
    const normalized = normalizeBaseName(emailBase);
    if (normalized) {
      return normalized;
    }
  }

  if (summary.name) {
    const normalized = normalizeBaseName(summary.name);
    if (normalized) {
      return normalized;
    }
  }

  if (summary.accountId !== "unknown") {
    return summary.accountId.slice(0, 12);
  }

  return "account";
}

function normalizeTokenValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function normalizeImportedAuthFile(authFile: AuthFile): AuthFile {
  const exportedAt = parseExportedAtTimestamp(authFile.meta?.exportedAt);
  const normalized: AuthFile = {
    auth_mode:
      typeof authFile.auth_mode === "string" && authFile.auth_mode.trim().length > 0
        ? authFile.auth_mode
        : "chatgpt",
    OPENAI_API_KEY: Object.prototype.hasOwnProperty.call(authFile, "OPENAI_API_KEY")
      ? authFile.OPENAI_API_KEY
      : null,
    tokens: {
      access_token: normalizeTokenValue(authFile.tokens?.access_token),
      id_token: normalizeTokenValue(authFile.tokens?.id_token),
      refresh_token: normalizeTokenValue(authFile.tokens?.refresh_token),
      account_id:
        normalizeTokenValue(authFile.tokens?.account_id) ??
        normalizeTokenValue(authFile.meta?.chatgptAccountId),
    },
    last_refresh:
      typeof authFile.last_refresh === "string" && authFile.last_refresh.trim().length > 0
        ? authFile.last_refresh
        : exportedAt ?? new Date().toISOString(),
  };

  const hasAnyToken =
    normalized.tokens?.access_token ||
    normalized.tokens?.id_token ||
    normalized.tokens?.refresh_token;

  if (!hasAnyToken) {
    throw new Error("Imported auth.json is missing usable tokens.");
  }

  return normalized;
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

type HttpResult = {
  status: number;
  body: string;
};

type ProxySettings = {
  http?: string;
  https?: string;
  socks?: string;
};

let cachedProxySettings: ProxySettings | undefined;

function matchesCurrentAccount(
  accountSummary: AccountSummary,
  currentSummary?: AccountSummary,
): boolean {
  if (!currentSummary) {
    return false;
  }

  return isSameAccount(accountSummary, currentSummary);
}

function mergeAccountSummary(
  previous: AccountSummary,
  next: AccountSummary,
): AccountSummary {
  return {
    accountId: next.accountId,
    email: next.email ?? previous.email,
    name: next.name ?? previous.name,
    planType: next.planType ?? previous.planType,
    authMode: next.authMode ?? previous.authMode,
    lastRefresh: next.lastRefresh ?? previous.lastRefresh,
    expiresAt: next.expiresAt ?? previous.expiresAt,
  };
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

async function requestWithCurl(options: {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  form?: Record<string, string>;
  timeoutSeconds?: number;
}): Promise<HttpResult> {
  const args: string[] = [
    "-sS",
    "--connect-timeout",
    "15",
    "--max-time",
    String(options.timeoutSeconds ?? 45),
    "-X",
    options.method ?? "GET",
  ];

  for (const [key, value] of Object.entries(options.headers ?? {})) {
    args.push("-H", `${key}: ${value}`);
  }

  if (options.form) {
    for (const [key, value] of Object.entries(options.form)) {
      args.push("--data-urlencode", `${key}=${value}`);
    }
  }

  const proxySettings = await resolveProxySettings();
  const targetProtocol = new URL(options.url).protocol;
  if (targetProtocol === "https:" && (proxySettings.https || proxySettings.http || proxySettings.socks)) {
    args.push("--proxy", proxySettings.https ?? proxySettings.http ?? proxySettings.socks ?? "");
  } else if (targetProtocol === "http:" && (proxySettings.http || proxySettings.socks)) {
    args.push("--proxy", proxySettings.http ?? proxySettings.socks ?? "");
  }

  args.push(options.url, "-w", "\n%{http_code}");

  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      "curl",
      args,
      {
        env: process.env,
        maxBuffer: 5 * 1024 * 1024,
      },
      (error, output, stderr) => {
        if (error) {
          reject(new Error(stderr?.trim() || error.message));
          return;
        }
        resolve(output);
      },
    );
  });

  const trimmed = stdout.trimEnd();
  const newlineIndex = trimmed.lastIndexOf("\n");
  if (newlineIndex < 0) {
    throw new Error("Invalid curl response.");
  }

  const body = trimmed.slice(0, newlineIndex);
  const statusText = trimmed.slice(newlineIndex + 1).trim();
  const status = Number.parseInt(statusText, 10);

  if (!Number.isFinite(status)) {
    throw new Error("Invalid curl HTTP status.");
  }

  return { status, body };
}

async function resolveProxySettings(): Promise<ProxySettings> {
  if (cachedProxySettings) {
    return cachedProxySettings;
  }

  const env = process.env;
  const fromEnv: ProxySettings = {
    https: env.HTTPS_PROXY || env.https_proxy || undefined,
    http: env.HTTP_PROXY || env.http_proxy || undefined,
    socks: env.ALL_PROXY || env.all_proxy || undefined,
  };

  if (fromEnv.https || fromEnv.http || fromEnv.socks) {
    cachedProxySettings = fromEnv;
    return fromEnv;
  }

  const output = await new Promise<string | undefined>((resolve) => {
    execFile("/usr/sbin/scutil", ["--proxy"], { maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) {
        resolve(undefined);
        return;
      }
      resolve(stdout);
    });
  });

  if (!output) {
    cachedProxySettings = {};
    return cachedProxySettings;
  }

  const map = new Map<string, string>();
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes(":")) {
      continue;
    }
    const idx = trimmed.indexOf(":");
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    map.set(key, value);
  }

  const settings: ProxySettings = {};
  if (map.get("HTTPSEnable") === "1") {
    const host = map.get("HTTPSProxy");
    const port = map.get("HTTPSPort");
    if (host && port) {
      settings.https = `http://${host}:${port}`;
    }
  }
  if (map.get("HTTPEnable") === "1") {
    const host = map.get("HTTPProxy");
    const port = map.get("HTTPPort");
    if (host && port) {
      settings.http = `http://${host}:${port}`;
    }
  }
  if (map.get("SOCKSEnable") === "1") {
    const host = map.get("SOCKSProxy");
    const port = map.get("SOCKSPort");
    if (host && port) {
      settings.socks = `socks5://${host}:${port}`;
    }
  }

  cachedProxySettings = settings;
  return settings;
}

async function fetchUsageRequest(
  accessToken: string,
  accountId?: string,
): Promise<HttpResult> {
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
  return requestWithCurl({
    url: url.toString(),
    method: "GET",
    headers,
  });
}

async function refreshAuthTokens(authFile: AuthFile): Promise<AuthFile> {
  const refreshToken = authFile.tokens?.refresh_token;
  if (!refreshToken) {
    throw new Error("No refresh token available.");
  }

  const response = await requestWithCurl({
    url: REFRESH_URL,
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": "codex-switch/0.1.0",
    },
    form: {
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
      scope: "openid profile email",
    },
  });

  if (response.status < 200 || response.status >= 300) {
    const preview = response.body.slice(0, 400);
    throw new Error(preview || `Refresh failed with status ${response.status}`);
  }

  const payload = JSON.parse(response.body) as {
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

  if (response.status < 200 || response.status >= 300) {
    const preview = response.body.slice(0, 400);
    throw new Error(preview || `Usage request failed with status ${response.status}`);
  }

  const payload = JSON.parse(response.body) as UsageApiResponse;
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
    nextSummary = mergeAccountSummary(
      options.account.meta.summary,
      buildAccountSummary(options.authFile),
    );

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

export async function importAccountFromAuthFile(
  authPath: string,
  options: ImportAccountOptions = {},
): Promise<ImportAccountResult> {
  const resolvedAuthPath = path.resolve(authPath);
  if (!(await pathExists(resolvedAuthPath))) {
    throw new Error(`Auth file not found at ${resolvedAuthPath}`);
  }

  await ensureStore();

  const importedAuth = await readJsonFile<AuthFile>(resolvedAuthPath);
  const normalizedAuth = normalizeImportedAuthFile(importedAuth);
  const summary = buildAccountSummary({
    ...normalizedAuth,
    meta: importedAuth.meta,
  });
  const existingAccounts = await listStoredAccounts();
  const duplicate = existingAccounts.find((account) =>
    isSameAccount(account.meta.summary, summary),
  );

  if (duplicate) {
    const nextMeta: StoredAccountMeta = {
      ...duplicate.meta,
      savedAt: new Date().toISOString(),
      sourceAuthPath: resolvedAuthPath,
      summary,
    };

    await writeJsonSecure(duplicate.authPath, normalizedAuth);
    await writeJsonSecure(path.join(path.dirname(duplicate.authPath), "meta.json"), nextMeta);

    return {
      created: false,
      updated: true,
      account: {
        ...duplicate,
        meta: nextMeta,
      },
    };
  }

  const nextName = makeUniqueName(
    options.name?.trim() || inferImportedAccountName(importedAuth, summary),
    existingAccounts.map((account) => account.meta.name),
  );
  const accountDir = getAccountDir(nextName);
  const authTargetPath = path.join(accountDir, "auth.json");
  const metaPath = path.join(accountDir, "meta.json");

  await ensureDir(accountDir);
  await writeJsonSecure(authTargetPath, normalizedAuth);

  const meta: StoredAccountMeta = {
    name: nextName,
    savedAt: new Date().toISOString(),
    sourceAuthPath: resolvedAuthPath,
    includesConfig: false,
    summary,
  };

  await writeJsonSecure(metaPath, meta);

  return {
    created: true,
    updated: false,
    account: {
      meta,
      authPath: authTargetPath,
    },
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
