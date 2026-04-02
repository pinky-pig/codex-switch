export interface AuthTokens {
  id_token?: string | null;
  access_token?: string | null;
  refresh_token?: string | null;
  account_id?: string | null;
}

export interface ImportedAuthMeta {
  label?: string | null;
  issuer?: string | null;
  note?: string | null;
  tags?: string[] | null;
  status?: string | null;
  workspaceId?: string | null;
  chatgptAccountId?: string | null;
  exportedAt?: number | string | null;
  [key: string]: unknown;
}

export interface AuthFile {
  auth_mode?: string;
  OPENAI_API_KEY?: unknown;
  tokens?: AuthTokens;
  last_refresh?: string;
  meta?: ImportedAuthMeta;
}

export interface JwtClaims {
  email?: string;
  name?: string;
  picture?: string;
  exp?: number;
  iat?: number;
  chatgptAccountId?: string;
  chatgptPlanType?: string;
  [key: string]: unknown;
}

export interface AccountSummary {
  accountId: string;
  email?: string;
  name?: string;
  planType?: string;
  authMode?: string;
  lastRefresh?: string;
  expiresAt?: string;
}

export interface StoredAccountMeta {
  name: string;
  savedAt: string;
  sourceAuthPath: string;
  includesConfig: boolean;
  summary: AccountSummary;
  usage?: StoredAccountUsage;
}

export interface StoredAccount {
  meta: StoredAccountMeta;
  authPath: string;
  configPath?: string;
}

export interface SaveAccountOptions {
  includeConfig?: boolean;
}

export interface ImportAccountOptions {
  name?: string;
}

export interface SwitchAccountOptions {
  restoreConfig?: boolean;
}

export interface RuntimeStatus {
  codexHome: string;
  authPath: string;
  configPath: string;
  current?: AccountSummary;
  codexProcesses: string[];
}

export interface RateLimitWindow {
  usedPercent?: number;
  windowMinutes?: number;
  resetsAt?: string;
}

export interface RateLimitsSummary {
  planType?: string;
  primary?: RateLimitWindow;
  secondary?: RateLimitWindow;
}

export interface StoredAccountUsage {
  fetchedAt: string;
  planType?: string;
  primary?: RateLimitWindow;
  secondary?: RateLimitWindow;
  error?: string;
}

export interface RefreshUsageResult {
  updated: Array<{
    name: string;
    summary: AccountSummary;
    usage?: StoredAccountUsage;
  }>;
  failed: Array<{
    name: string;
    error: string;
  }>;
}

export interface SaveCurrentAccountAutoResult {
  created: boolean;
  account: StoredAccount;
}

export interface ImportAccountResult {
  created: boolean;
  updated: boolean;
  account: StoredAccount;
}

export interface AddAccountFlowResult {
  ok: true;
  phase: "completed" | "terminal-launched";
  previous?: SaveCurrentAccountAutoResult;
  current?: SaveCurrentAccountAutoResult;
  message?: string;
}
