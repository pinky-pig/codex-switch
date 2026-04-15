import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";

import {
  ACCOUNTS_DIR,
  AUTH_FILE,
  CODEX_HOME,
  CONFIG_FILE,
  LEGACY_LOCAL_ACCOUNTS_DIR,
  STORE_DIR,
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
  SaveCustomApiAccountOptions,
  SaveCustomApiAccountResult,
  StoredAccount,
  StoredAccountKind,
  StoredAccountMeta,
  StoredAccountUsage,
  SessionSyncDatabaseResult,
  SessionSyncResult,
  SwitchAccountResult,
  SwitchAccountOptions,
  TestCustomApiConnectionResult,
} from "../types.js";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const REFRESH_URL = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const SESSION_SYNC_BACKUPS_DIR = path.join(STORE_DIR, "backups", "session-provider-sync");

type ParsedCustomConfig = {
  modelProvider?: string;
  model?: string;
  baseUrl?: string;
  providerName?: string;
  wireApi?: string;
  reasoningEffort?: string;
};

type ThreadProviderStats = {
  totalThreads: number;
  unarchivedThreads: number;
  threadsNeedingSync: number;
  providers: string[];
};

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

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readTomlString(text: string, key: string): string | undefined {
  const pattern = new RegExp(`^\\s*${escapeRegex(key)}\\s*=\\s*\"([^\"]*)\"\\s*$`, "m");
  const match = text.match(pattern);
  const value = match?.[1]?.trim();
  return value || undefined;
}

function readTomlSection(text: string, sectionName: string): string | undefined {
  const lines = text.split("\n");
  let inSection = false;
  const collected: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\[.*\]$/.test(trimmed)) {
      if (trimmed === `[${sectionName}]`) {
        inSection = true;
        continue;
      }

      if (inSection) {
        break;
      }
    }

    if (inSection) {
      collected.push(line);
    }
  }

  if (collected.length === 0) {
    return undefined;
  }

  return collected.join("\n");
}

function parseCustomConfig(configContent?: string): ParsedCustomConfig {
  if (!configContent) {
    return {};
  }

  const modelProvider = readTomlString(configContent, "model_provider") ?? "custom";
  const section = readTomlSection(configContent, `model_providers.${modelProvider}`) ?? "";

  return {
    modelProvider,
    model: readTomlString(configContent, "model"),
    baseUrl: readTomlString(section, "base_url"),
    providerName: readTomlString(section, "name"),
    wireApi: readTomlString(section, "wire_api"),
    reasoningEffort: readTomlString(configContent, "model_reasoning_effort"),
  };
}

function isCustomApiAuthFile(authFile: AuthFile): boolean {
  return (
    typeof authFile.OPENAI_API_KEY === "string" &&
    authFile.OPENAI_API_KEY.trim().length > 0 &&
    !authFile.tokens?.access_token &&
    !authFile.tokens?.id_token &&
    !authFile.tokens?.refresh_token
  );
}

function buildCustomApiFingerprint(apiKey: string, baseUrl?: string): string {
  return createHash("sha256")
    .update(`${baseUrl ?? ""}\n${apiKey}`)
    .digest("hex")
    .slice(0, 16);
}

function buildCustomApiAccountSummary(
  authFile: AuthFile,
  options?: {
    configContent?: string;
    fallbackName?: string;
  },
): AccountSummary {
  const apiKey = typeof authFile.OPENAI_API_KEY === "string" ? authFile.OPENAI_API_KEY.trim() : "";
  const config = parseCustomConfig(options?.configContent);

  let host: string | undefined;
  if (config.baseUrl) {
    try {
      host = new URL(config.baseUrl).host;
    } catch {
      host = undefined;
    }
  }

  return {
    accountId: `custom:${buildCustomApiFingerprint(apiKey, config.baseUrl)}`,
    name:
      options?.fallbackName?.trim() ||
      config.providerName ||
      (host ? `custom @ ${host}` : "custom-api"),
    planType: config.model,
    authMode: "api_key",
    lastRefresh: undefined,
    expiresAt: undefined,
  };
}

function buildAccountSummary(
  authFile: AuthFile,
  options?: {
    configContent?: string;
    fallbackName?: string;
  },
): AccountSummary {
  if (isCustomApiAuthFile(authFile)) {
    return buildCustomApiAccountSummary(authFile, options);
  }

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

async function readAuthSummary(
  authPath: string,
  options?: {
    configPath?: string;
    fallbackName?: string;
  },
): Promise<AccountSummary> {
  const authFile = await readJsonFile<AuthFile>(authPath);
  const configContent = options?.configPath ? await safeReadText(options.configPath) : undefined;
  return buildAccountSummary(authFile, {
    configContent,
    fallbackName: options?.fallbackName,
  });
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

function buildCustomApiAuthFile(apiKey: string): AuthFile {
  const trimmedApiKey = apiKey.trim();
  if (!trimmedApiKey) {
    throw new Error("API key is required.");
  }

  return {
    OPENAI_API_KEY: trimmedApiKey,
  };
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

function quoteTomlString(value: string): string {
  return JSON.stringify(value);
}

function buildCustomApiConfig(options: {
  baseUrl: string;
  model: string;
  reasoningEffort: string;
}): string {
  return [
    'model_provider = "custom"',
    `model = ${quoteTomlString(options.model)}`,
    "suppress_unstable_features_warning = true",
    `model_reasoning_effort = ${quoteTomlString(options.reasoningEffort)}`,
    "",
    "[model_providers]",
    "[model_providers.custom]",
    'name = "custom"',
    `base_url = ${quoteTomlString(options.baseUrl)}`,
    'wire_api = "responses"',
    "",
  ].join("\n");
}

function removeRootKeyLine(text: string, key: string): string {
  const pattern = new RegExp(`^\\s*${escapeRegex(key)}\\s*=.*(?:\\n|$)`, "gm");
  return text.replace(pattern, "");
}

function removeTomlSection(text: string, sectionName: string): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  let skipping = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\[.*\]$/.test(trimmed)) {
      if (trimmed === `[${sectionName}]`) {
        skipping = true;
        continue;
      }

      if (skipping) {
        skipping = false;
      }
    }

    if (!skipping) {
      kept.push(line);
    }
  }

  return kept.join("\n");
}

function trimTomlDocument(text: string): string {
  return text
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s+/, "")
    .replace(/\s+$/, "");
}

function mergeCustomApiConfig(existingContent: string | undefined, customContent: string): string {
  const existing = existingContent ?? "";
  const custom = parseCustomConfig(customContent);
  const managedKeys = [
    `model_provider = ${quoteTomlString(custom.modelProvider ?? "custom")}`,
    `model = ${quoteTomlString(custom.model ?? "gpt-5.4")}`,
    "suppress_unstable_features_warning = true",
    `model_reasoning_effort = ${quoteTomlString(custom.reasoningEffort ?? "xhigh")}`,
  ].join("\n");
  const providerSection = [
    "[model_providers.custom]",
    `name = ${quoteTomlString(custom.providerName ?? "custom")}`,
    `base_url = ${quoteTomlString(custom.baseUrl ?? "")}`,
    `wire_api = ${quoteTomlString(custom.wireApi ?? "responses")}`,
  ].join("\n");

  let cleaned = existing;
  for (const key of [
    "model_provider",
    "model",
    "suppress_unstable_features_warning",
    "model_reasoning_effort",
  ]) {
    cleaned = removeRootKeyLine(cleaned, key);
  }
  cleaned = removeTomlSection(cleaned, "model_providers.custom");
  cleaned = trimTomlDocument(cleaned);

  const firstSectionIndex = cleaned.search(/^\[/m);
  const rootPart =
    firstSectionIndex >= 0 ? cleaned.slice(0, firstSectionIndex).trim() : cleaned.trim();
  const sectionPart =
    firstSectionIndex >= 0 ? cleaned.slice(firstSectionIndex).trim() : "";
  const hasModelProvidersSection = /^\[model_providers\]\s*$/m.test(sectionPart);

  const rootOutput = trimTomlDocument([rootPart, managedKeys].filter(Boolean).join("\n\n"));
  const sectionPieces = [sectionPart];
  if (!hasModelProvidersSection) {
    sectionPieces.push("[model_providers]");
  }
  sectionPieces.push(providerSection);
  const sectionOutput = trimTomlDocument(sectionPieces.filter(Boolean).join("\n\n"));

  return `${trimTomlDocument([rootOutput, sectionOutput].filter(Boolean).join("\n\n"))}\n`;
}

function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

function buildSessionSyncTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function execFileText(
  command: string,
  args: string[],
  options: {
    maxBuffer?: number;
  } = {},
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    execFile(
      command,
      args,
      {
        env: process.env,
        maxBuffer: options.maxBuffer ?? 20 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr?.trim() || stdout?.trim() || error.message));
          return;
        }

        resolve(stdout);
      },
    );
  });
}

async function runSqlite(
  databasePath: string,
  sql: string,
  options: {
    separator?: string;
  } = {},
): Promise<string> {
  const args = ["-batch"];

  if (options.separator) {
    args.push("-noheader", "-separator", options.separator);
  }

  args.push(databasePath, sql);
  return await execFileText("sqlite3", args);
}

async function listCodexStateDatabasePaths(): Promise<string[]> {
  if (!(await pathExists(CODEX_HOME))) {
    return [];
  }

  const entries = await fs.readdir(CODEX_HOME, { withFileTypes: true });
  const candidates = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && /^state(?:_\d+)?\.sqlite$/i.test(entry.name))
      .map(async (entry) => {
        const databasePath = path.join(CODEX_HOME, entry.name);
        const stats = await fs.stat(databasePath);
        return {
          databasePath,
          modifiedAt: stats.mtimeMs,
        };
      }),
  );

  return candidates
    .sort((left, right) => right.modifiedAt - left.modifiedAt)
    .map((candidate) => candidate.databasePath);
}

async function hasThreadsTable(databasePath: string): Promise<boolean> {
  const output = await runSqlite(
    databasePath,
    "select name from sqlite_master where type='table' and name='threads';",
  );

  return output.trim() === "threads";
}

async function readThreadProviderStats(
  databasePath: string,
  targetProvider: string,
): Promise<ThreadProviderStats> {
  const escapedProvider = escapeSqlString(targetProvider);
  const sql = [
    "select 'total' || char(9) || count(*) from threads;",
    "select 'unarchived' || char(9) || count(*) from threads where archived = 0;",
    `select 'needs_sync' || char(9) || count(*) from threads where model_provider <> '${escapedProvider}';`,
    "select 'provider' || char(9) || model_provider || char(9) || count(*) from threads group by model_provider order by count(*) desc, model_provider asc;",
  ].join(" ");
  const output = await runSqlite(databasePath, sql, { separator: "\t" });

  const stats: ThreadProviderStats = {
    totalThreads: 0,
    unarchivedThreads: 0,
    threadsNeedingSync: 0,
    providers: [],
  };

  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const [kind, value] = trimmed.split("\t");
    if (kind === "total") {
      stats.totalThreads = Number.parseInt(value ?? "0", 10) || 0;
      continue;
    }

    if (kind === "unarchived") {
      stats.unarchivedThreads = Number.parseInt(value ?? "0", 10) || 0;
      continue;
    }

    if (kind === "needs_sync") {
      stats.threadsNeedingSync = Number.parseInt(value ?? "0", 10) || 0;
      continue;
    }

    if (kind === "provider" && value) {
      stats.providers.push(value);
    }
  }

  return stats;
}

async function backupStateDatabase(databasePath: string, backupPath: string): Promise<void> {
  await ensureDir(path.dirname(backupPath));

  try {
    await runSqlite(databasePath, `VACUUM INTO '${escapeSqlString(backupPath)}';`);
  } catch {
    await copyFileSecure(databasePath, backupPath);
  }
}

async function exportThreadManifest(databasePath: string, manifestPath: string): Promise<void> {
  const sql = [
    "select id || char(9) || model_provider || char(9) || archived || char(9) || replace(replace(title, char(9), ' '), char(10), ' ')",
    "from threads",
    "order by updated_at desc, id desc;",
  ].join(" ");
  const output = await runSqlite(databasePath, sql, { separator: "\t" });
  const header = "id\tmodel_provider\tarchived\ttitle\n";
  const body = output.trim().length > 0 ? `${output.trimEnd()}\n` : "";
  await writeTextAtomic(manifestPath, `${header}${body}`);
}

async function getConfiguredModelProvider(): Promise<string> {
  const configContent = await safeReadText(CONFIG_FILE);
  return readTomlString(configContent ?? "", "model_provider") ?? "openai";
}

export async function syncSessionsToCurrentProvider(
  targetProviderOverride?: string,
): Promise<SessionSyncResult> {
  const targetProvider = targetProviderOverride?.trim() || (await getConfiguredModelProvider());
  const databasePaths = await listCodexStateDatabasePaths();
  const databases: SessionSyncDatabaseResult[] = [];
  let backupDir: string | undefined;

  for (const databasePath of databasePaths) {
    if (!(await hasThreadsTable(databasePath))) {
      continue;
    }

    const before = await readThreadProviderStats(databasePath, targetProvider);
    const databaseResult: SessionSyncDatabaseResult = {
      databasePath,
      totalThreads: before.totalThreads,
      unarchivedThreads: before.unarchivedThreads,
      updatedThreads: 0,
      providersBefore: before.providers,
      providersAfter: before.providers,
    };

    if (before.threadsNeedingSync > 0) {
      if (!backupDir) {
        backupDir = path.join(
          SESSION_SYNC_BACKUPS_DIR,
          `provider-sync-${buildSessionSyncTimestamp()}`,
        );
        await ensureDir(backupDir);
      }

      const fileStem = path.basename(databasePath, ".sqlite");
      const backupPath = path.join(backupDir, `${fileStem}.before-sync.sqlite`);
      const manifestPath = path.join(backupDir, `${fileStem}.threads.tsv`);

      await backupStateDatabase(databasePath, backupPath);
      await exportThreadManifest(databasePath, manifestPath);
      await runSqlite(
        databasePath,
        [
          "begin immediate;",
          `update threads set model_provider = '${escapeSqlString(targetProvider)}' where model_provider <> '${escapeSqlString(targetProvider)}';`,
          "commit;",
        ].join(" "),
      );

      const after = await readThreadProviderStats(databasePath, targetProvider);
      databaseResult.backupPath = backupPath;
      databaseResult.manifestPath = manifestPath;
      databaseResult.updatedThreads = before.threadsNeedingSync;
      databaseResult.totalThreads = after.totalThreads;
      databaseResult.unarchivedThreads = after.unarchivedThreads;
      databaseResult.providersAfter = after.providers;
    }

    databases.push(databaseResult);
  }

  return {
    targetProvider,
    changed: databases.some((database) => database.updatedThreads > 0),
    backupDir,
    databases,
  };
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

function inferStoredAccountKind(account: StoredAccount): StoredAccountKind {
  return account.meta.kind ?? (account.meta.requiresConfig ? "custom-api" : "chatgpt");
}

function shouldRestoreConfigForAccount(
  account: StoredAccount,
  options: SwitchAccountOptions,
): boolean {
  return Boolean(options.restoreConfig || account.meta.requiresConfig);
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

  return readAuthSummary(AUTH_FILE, {
    configPath: CONFIG_FILE,
  });
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
  const summary = await readAuthSummary(AUTH_FILE, {
    configPath: CONFIG_FILE,
    fallbackName: safeName,
  });
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
    kind: "chatgpt",
    requiresConfig: false,
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
      kind: "chatgpt",
      requiresConfig: false,
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
    kind: "chatgpt",
    requiresConfig: false,
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

export async function saveCustomApiAccount(
  options: SaveCustomApiAccountOptions,
): Promise<SaveCustomApiAccountResult> {
  const safeName = sanitizeName(options.name);
  const trimmedBaseUrl = normalizeBaseUrl(options.baseUrl);
  if (!trimmedBaseUrl) {
    throw new Error("Base URL is required.");
  }

  const authFile = buildCustomApiAuthFile(options.apiKey);
  const configContent = buildCustomApiConfig({
    baseUrl: trimmedBaseUrl,
    model: options.model?.trim() || "gpt-5.4",
    reasoningEffort: options.reasoningEffort?.trim() || "xhigh",
  });
  const summary = buildAccountSummary(authFile, {
    configContent,
    fallbackName: safeName,
  });

  await ensureStore();

  const existingAccounts = await listStoredAccounts();
  const existingByName = existingAccounts.find((account) => account.meta.name === safeName);
  const duplicate = existingAccounts.find((account) =>
    isSameAccount(account.meta.summary, summary),
  );
  const accountToUpdate = existingByName ?? duplicate;
  const targetName = accountToUpdate?.meta.name ?? safeName;
  const accountDir = getAccountDir(targetName);
  const authTargetPath = path.join(accountDir, "auth.json");
  const configTargetPath = path.join(accountDir, "config.toml");
  const metaPath = path.join(accountDir, "meta.json");

  await ensureDir(accountDir);
  await writeJsonSecure(authTargetPath, authFile);
  await writeTextAtomic(configTargetPath, configContent);

  const meta: StoredAccountMeta = {
    name: targetName,
    savedAt: new Date().toISOString(),
    sourceAuthPath: authTargetPath,
    includesConfig: true,
    kind: "custom-api",
    requiresConfig: true,
    summary,
    usage: accountToUpdate?.meta.usage,
  };

  await writeJsonSecure(metaPath, meta);

  return {
    created: !accountToUpdate,
    updated: Boolean(accountToUpdate),
    account: {
      meta,
      authPath: authTargetPath,
      configPath: configTargetPath,
    },
  };
}

export async function testCustomApiConnection(options: {
  apiKey: string;
  baseUrl: string;
}): Promise<TestCustomApiConnectionResult> {
  const apiKey = options.apiKey.trim();
  if (!apiKey) {
    throw new Error("API key is required.");
  }

  const baseUrl = normalizeBaseUrl(options.baseUrl);
  if (!baseUrl) {
    throw new Error("Base URL is required.");
  }

  const targetUrl = `${baseUrl}/models`;
  const response = await requestWithCurl({
    url: targetUrl,
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      "User-Agent": "codex-switch/0.1.0",
    },
    timeoutSeconds: 20,
  });

  if (response.status < 200 || response.status >= 300) {
    const preview = response.body.trim().slice(0, 240);
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        status: response.status,
        message: preview || `Authentication failed (${response.status}).`,
      };
    }

    return {
      ok: false,
      status: response.status,
      message: preview || `Connection failed with status ${response.status}.`,
    };
  }

  let message = `Connected successfully (${response.status}).`;

  try {
    const payload = JSON.parse(response.body) as {
      data?: Array<{ id?: string }>;
    };
    const modelCount = payload.data?.length;
    const firstModel = payload.data?.find((item) => typeof item.id === "string")?.id;

    if (modelCount !== undefined && firstModel) {
      message = `Connected successfully. Found ${modelCount} model(s). First: ${firstModel}`;
    } else if (modelCount !== undefined) {
      message = `Connected successfully. Found ${modelCount} model(s).`;
    }
  } catch {
    // Keep the generic success message when the endpoint returns non-JSON content.
  }

  return {
    ok: true,
    status: response.status,
    message,
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
): Promise<SwitchAccountResult> {
  const account = await getStoredAccount(name);
  const authContent = await safeReadText(account.authPath);

  if (!authContent) {
    throw new Error(`Saved auth file missing at ${account.authPath}`);
  }

  await ensureDir(CODEX_HOME);
  await writeTextAtomic(AUTH_FILE, authContent);

  if (shouldRestoreConfigForAccount(account, options) && account.configPath) {
    const configContent = await safeReadText(account.configPath);
    if (configContent) {
      if (inferStoredAccountKind(account) === "custom-api") {
        const liveConfig = await safeReadText(CONFIG_FILE);
        const mergedConfig = mergeCustomApiConfig(liveConfig, configContent);
        await writeTextAtomic(CONFIG_FILE, mergedConfig);
      } else {
        await writeTextAtomic(CONFIG_FILE, configContent);
      }
    }
  }

  const restoreConfig = shouldRestoreConfigForAccount(account, options);
  let sessionSync: SessionSyncResult | undefined;

  if (options.syncSessions !== false) {
    try {
      sessionSync = await syncSessionsToCurrentProvider();
    } catch (error) {
      sessionSync = {
        targetProvider: await getConfiguredModelProvider(),
        changed: false,
        databases: [],
        error: error instanceof Error ? error.message : "Unknown session sync error.",
      };
    }
  }

  return {
    account,
    restoreConfig,
    sessionSync,
  };
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
      if (isCustomApiAuthFile(storedAuth) || inferStoredAccountKind(account) === "custom-api") {
        updated.push(account);
        continue;
      }
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
