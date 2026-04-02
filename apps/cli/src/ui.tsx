import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useApp, useInput, useStdin } from "ink";

import { addCodexAccount } from "./lib/app.js";
import {
  getRuntimeStatus,
  importAccountFromAuthFile,
  listStoredAccounts,
  removeStoredAccount,
  saveCurrentAccount,
  switchToAccount,
} from "./lib/accounts.js";
import type { RuntimeStatus, StoredAccount } from "./types.js";

type Mode =
  | "menu"
  | "login-running"
  | "import-input"
  | "save-input"
  | "switch-list"
  | "switch-confirm"
  | "delete-list"
  | "delete-confirm";

type BannerTone = "info" | "success" | "danger";

const accent = "#38bdf8";
const muted = "#6b7280";
const success = "#34d399";
const danger = "#fb7185";
const version = "v0.1.0";
const logoFrames = [
  "~\\(=^.^=)/~   ",
  "~\\(^.^)/~     ",
  "~\\(=^.^)/~    ",
  "~\\(^.^=)/~    ",
];

const MENU_ITEMS = [
  "添加 Codex 账号",
  "导入 auth.json 账号",
  "切换账号",
  "保存当前使用的 Codex 账号到工具中",
  "删除 Codex 账号",
] as const;

function truncate(value: string, maxLength = 96): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 1)}…`;
}

function fmt(value?: string): string {
  return value ?? "n/a";
}

function prettyDate(value?: string): string {
  if (!value) {
    return "n/a";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
}

function normalizeBaseName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function inferSuggestedName(status?: RuntimeStatus): string {
  const email = status?.current?.email?.split("@")[0];
  if (email) {
    return normalizeBaseName(email) || "account";
  }

  if (status?.current?.accountId && status.current.accountId !== "unknown") {
    return status.current.accountId.slice(0, 12);
  }

  return "account";
}

function normalizeImportedPath(input: string): string {
  const trimmed = input.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed.replace(/\\ /g, " ");
}

function getWindowedItems<T>(items: T[], selectedIndex: number, windowSize = 8): T[] {
  if (items.length <= windowSize) {
    return items;
  }

  const half = Math.floor(windowSize / 2);
  const start = Math.max(
    0,
    Math.min(selectedIndex - half, items.length - windowSize),
  );

  return items.slice(start, start + windowSize);
}

function TextInput({
  value,
  placeholder,
}: {
  value: string;
  placeholder: string;
}): React.JSX.Element {
  const displayValue = value.length > 0 ? value : placeholder;
  const color = value.length > 0 ? "white" : muted;

  return (
    <Box borderStyle="round" borderColor={accent} paddingX={1}>
      <Text color={color}>{displayValue}</Text>
    </Box>
  );
}

export function SwitchApp(): React.JSX.Element {
  const { exit } = useApp();
  const { isRawModeSupported, setRawMode } = useStdin();

  const [status, setStatus] = useState<RuntimeStatus>();
  const [accounts, setAccounts] = useState<StoredAccount[]>([]);
  const [mode, setMode] = useState<Mode>("menu");
  const [menuIndex, setMenuIndex] = useState(0);
  const [accountIndex, setAccountIndex] = useState(0);
  const [importPath, setImportPath] = useState("");
  const [saveName, setSaveName] = useState("");
  const [includeConfig, setIncludeConfig] = useState(false);
  const [restoreConfig, setRestoreConfig] = useState(false);
  const [emojiIndex, setEmojiIndex] = useState(0);
  const [banner, setBanner] = useState<{ tone: BannerTone; text: string }>({
    tone: "info",
    text: "使用方向键和回车选择操作。",
  });

  async function refresh(): Promise<void> {
    const [nextStatus, nextAccounts] = await Promise.all([
      getRuntimeStatus(),
      listStoredAccounts(),
    ]);

    setStatus(nextStatus);
    setAccounts(nextAccounts);
    setAccountIndex((current) =>
      Math.min(current, Math.max(0, nextAccounts.length - 1)),
    );
    setSaveName((current) => current || inferSuggestedName(nextStatus));
  }

  useEffect(() => {
    refresh().catch((error: unknown) => {
      setBanner({
        tone: "danger",
        text: error instanceof Error ? error.message : "加载数据失败。",
      });
    });
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      setEmojiIndex((current) => (current + 1) % logoFrames.length);
    }, 900);

    return () => clearInterval(timer);
  }, []);

  const currentEmail = status?.current?.email;
  const selectedAccount = accounts[accountIndex];
  const accountWindow = useMemo(
    () => getWindowedItems(accounts, accountIndex),
    [accounts, accountIndex],
  );
  const infoAccounts = useMemo(() => accounts.slice(0, 4), [accounts]);
  const panelDivider = Array.from({ length: 8 }, (_, index) => `divider-${index}`);

  async function runLoginFlow(): Promise<void> {
    try {
      if (isRawModeSupported) {
        setRawMode(false);
      }

      process.stdout.write("\x1Bc");
      const result = await addCodexAccount({ launchMode: "inline" });

      if (isRawModeSupported) {
        setRawMode(true);
      }

      await refresh();
      setMode("menu");
      setBanner({
        tone: "success",
        text: truncate(
          result.message ?? `登录成功，已保存当前生效账号 "${result.current?.account.meta.name ?? ""}"。`,
        ),
      });
    } catch (error: unknown) {
      if (isRawModeSupported) {
        setRawMode(true);
      }

      setMode("menu");
      setBanner({
        tone: "danger",
        text: error instanceof Error ? error.message : "登录流程失败。",
      });
    }
  }

  async function runImportFlow(): Promise<void> {
    try {
      const result = await importAccountFromAuthFile(normalizeImportedPath(importPath));
      await refresh();
      setImportPath("");
      setMode("menu");
      setBanner({
        tone: "success",
        text: truncate(
          result.updated
            ? `已更新已保存账号 "${result.account.meta.name}"。`
            : `已导入账号 "${result.account.meta.name}"。`,
        ),
      });
    } catch (error: unknown) {
      setBanner({
        tone: "danger",
        text: error instanceof Error ? error.message : "导入失败。",
      });
    }
  }

  function goBack(): void {
    if (mode === "menu") {
      return;
    }

    if (mode === "switch-confirm") {
      setMode("switch-list");
      setBanner({
        tone: "info",
        text: "选择一个账号并按回车切换。",
      });
      return;
    }

    if (mode === "delete-confirm") {
      setMode("delete-list");
      setBanner({
        tone: "info",
        text: "选择一个账号并按回车删除。",
      });
      return;
    }

    setMode("menu");
    setBanner({
      tone: "info",
      text: "已返回主菜单。",
    });
  }

  function getBreadcrumb(): string {
    switch (mode) {
      case "menu":
        return "主菜单";
      case "login-running":
        return "主菜单 / 添加 Codex 账号";
      case "import-input":
        return "主菜单 / 导入 auth.json 账号";
      case "save-input":
        return "主菜单 / 保存当前使用的 Codex 账号到工具中";
      case "switch-list":
        return "主菜单 / 切换账号";
      case "switch-confirm":
        return "主菜单 / 切换账号 / 确认";
      case "delete-list":
        return "主菜单 / 删除 Codex 账号";
      case "delete-confirm":
        return "主菜单 / 删除 Codex 账号 / 确认";
      default:
        return "主菜单";
    }
  }

  useInput((input, key) => {
    const isTextInputMode = mode === "save-input" || mode === "import-input";

    if (!isTextInputMode && input.toLowerCase() === "q") {
      exit();
      return;
    }

    if (key.escape) {
      goBack();
      return;
    }

    if (mode === "login-running") {
      return;
    }

    if (!isTextInputMode && input.toLowerCase() === "r") {
      refresh()
        .then(() => {
          setBanner({ tone: "info", text: "已刷新。" });
        })
        .catch((error: unknown) => {
          setBanner({
            tone: "danger",
            text: error instanceof Error ? error.message : "刷新失败。",
          });
        });
      return;
    }

    if (mode === "menu") {
      if (key.upArrow || input.toLowerCase() === "k") {
        setMenuIndex((current) => Math.max(0, current - 1));
        return;
      }

      if (key.downArrow || input.toLowerCase() === "j") {
        setMenuIndex((current) => Math.min(MENU_ITEMS.length - 1, current + 1));
        return;
      }

      if (key.return) {
        if (menuIndex === 0) {
          setMode("login-running");
          setBanner({
            tone: "info",
            text: "正在执行 codex logout + codex login ...",
          });
          void runLoginFlow();
          return;
        }

        if (menuIndex === 1) {
          setMode("import-input");
          setImportPath("");
          setBanner({
            tone: "info",
            text: "粘贴 auth.json 路径后按回车导入。",
          });
          return;
        }

        if (menuIndex === 2) {
          if (accounts.length === 0) {
            setBanner({ tone: "danger", text: "还没有已保存账号。" });
            return;
          }

          setMode("switch-list");
          setBanner({
            tone: "info",
            text: "选择一个账号并按回车切换。",
          });
          return;
        }

        if (menuIndex === 3) {
          setMode("save-input");
          setSaveName(inferSuggestedName(status));
          setBanner({
            tone: "info",
            text: "输入快照名称后按回车保存。",
          });
          return;
        }

        if (accounts.length === 0) {
          setBanner({ tone: "danger", text: "没有可删除的已保存账号。" });
          return;
        }

        setMode("delete-list");
        setBanner({
          tone: "info",
          text: "选择一个账号并按回车删除。",
        });
      }

      return;
    }

    if (mode === "import-input") {
      if (key.backspace || key.delete) {
        setImportPath((current) => current.slice(0, -1));
        return;
      }

      if (key.return) {
        if (!normalizeImportedPath(importPath)) {
          setBanner({ tone: "danger", text: "必须输入 auth.json 路径。" });
          return;
        }

        void runImportFlow();
        return;
      }

      if (!key.ctrl && !key.meta && input.length === 1) {
        setImportPath((current) => current + input);
      }

      return;
    }

    if (mode === "save-input") {
      if (key.backspace || key.delete) {
        setSaveName((current) => current.slice(0, -1));
        return;
      }

      if (input.toLowerCase() === "c") {
        setIncludeConfig((current) => !current);
        setBanner({
          tone: "info",
          text: `配置备份已${includeConfig ? "关闭" : "开启"}。`,
        });
        return;
      }

      if (key.return) {
        const nextName = saveName.trim();
        if (!nextName) {
          setBanner({ tone: "danger", text: "必须输入快照名称。" });
          return;
        }

        const alreadySaved = accounts.some((account) => {
          const currentAccountId = status?.current?.accountId;
          if (
            currentAccountId &&
            currentAccountId !== "unknown" &&
            account.meta.summary.accountId === currentAccountId
          ) {
            return true;
          }

          return Boolean(
            status?.current?.email &&
              account.meta.summary.email === status.current.email,
          );
        });

        saveCurrentAccount(nextName, { includeConfig })
          .then(async (saved) => {
            await refresh();
            setMode("menu");
            setBanner({
              tone: "success",
              text: truncate(
                alreadySaved
                  ? `当前账号已存在于工具中："${saved.meta.name}"。`
                  : `已将当前账号保存为 "${saved.meta.name}"。`,
              ),
            });
          })
          .catch((error: unknown) => {
            setBanner({
              tone: "danger",
              text: error instanceof Error ? error.message : "保存失败。",
            });
          });
        return;
      }

      if (!key.ctrl && !key.meta && input.length === 1) {
        setSaveName((current) => current + input);
      }

      return;
    }

    if (key.upArrow || input.toLowerCase() === "k") {
      setAccountIndex((current) => Math.max(0, current - 1));
      return;
    }

    if (key.downArrow || input.toLowerCase() === "j") {
      setAccountIndex((current) => Math.min(accounts.length - 1, current + 1));
      return;
    }

    if (!selectedAccount) {
      return;
    }

    if (mode === "switch-list" && key.return) {
      setMode("switch-confirm");
      setBanner({
        tone: "info",
        text: truncate(
          `切换到 "${selectedAccount.meta.name}"？回车确认，Esc 取消。`,
        ),
      });
      return;
    }

    if (mode === "switch-confirm") {
      if (input.toLowerCase() === "c") {
        setRestoreConfig((current) => !current);
        setBanner({
          tone: "info",
          text: `恢复配置已${restoreConfig ? "关闭" : "开启"}。按回车确认。`,
        });
        return;
      }

      if (key.return) {
        switchToAccount(selectedAccount.meta.name, { restoreConfig })
          .then(async (account) => {
            await refresh();
            setMode("menu");
            setBanner({
              tone: "success",
              text: truncate(`已切换到 "${account.meta.name}"。`),
            });
          })
          .catch((error: unknown) => {
            setBanner({
              tone: "danger",
              text: error instanceof Error ? error.message : "切换失败。",
            });
          });
      }
      return;
    }

    if (mode === "delete-list" && key.return) {
      setMode("delete-confirm");
      setBanner({
        tone: "info",
        text: truncate(
          `删除 "${selectedAccount.meta.name}"？回车确认，Esc 取消。`,
        ),
      });
      return;
    }

    if (mode === "delete-confirm" && key.return) {
      removeStoredAccount(selectedAccount.meta.name)
        .then(async () => {
            await refresh();
            setMode("menu");
            setBanner({
              tone: "success",
              text: truncate(`已删除 "${selectedAccount.meta.name}"。`),
            });
          })
          .catch((error: unknown) => {
            setBanner({
              tone: "danger",
              text: error instanceof Error ? error.message : "删除失败。",
            });
          });
    }
  });

  const statusColor = useMemo(() => {
    if (banner.tone === "success") {
      return success;
    }

    if (banner.tone === "danger") {
      return danger;
    }

    return accent;
  }, [banner]);

  const renderMenu = (): React.JSX.Element => (
    <Box flexDirection="column">
      {MENU_ITEMS.map((item, index) => (
        <Box key={item} gap={1}>
          <Text color={index === menuIndex ? accent : muted}>
            {index === menuIndex ? ">" : " "}
          </Text>
          <Text color={muted}>{index + 1}.</Text>
          <Text color={index === menuIndex ? "white" : undefined}>{item}</Text>
        </Box>
      ))}
    </Box>
  );

  const renderAccountList = (): React.JSX.Element => {
    if (accounts.length === 0) {
      return <Text color={muted}>没有已保存账号。</Text>;
    }

    const startIndex =
      accounts.length <= 8
        ? 0
        : Math.max(0, Math.min(accountIndex - 4, accounts.length - 8));

    return (
      <Box flexDirection="column">
        {accountWindow.map((account, index) => {
          const absoluteIndex = startIndex + index;
          const isSelected = absoluteIndex === accountIndex;
          const isActive =
            account.meta.summary.accountId !== "unknown" &&
            account.meta.summary.accountId === status?.current?.accountId;

          return (
            <Box key={account.meta.name} gap={1}>
              <Text color={isSelected ? accent : muted}>{isSelected ? ">" : " "}</Text>
              <Text color={muted}>{absoluteIndex + 1}.</Text>
              <Text color={isSelected ? "white" : undefined}>
                {truncate(account.meta.name, 20)}
              </Text>
              <Text color={muted}>{truncate(fmt(account.meta.summary.email), 32)}</Text>
              {isActive ? <Text color={success}>active</Text> : null}
            </Box>
          );
        })}
      </Box>
    );
  };

  const renderBody = (): React.JSX.Element => {
    if (mode === "menu") {
      return renderMenu();
    }

    if (mode === "login-running") {
      return <Text color={muted}>正在等待 Codex 登录完成...</Text>;
    }

    if (mode === "import-input") {
      return (
        <Box flexDirection="column" gap={1}>
          <Text color="white">导入 auth.json</Text>
          <TextInput value={importPath} placeholder="粘贴 auth.json 的完整路径" />
          <Text color={muted}>会自动忽略无关 meta 字段，只保存可用认证信息。</Text>
        </Box>
      );
    }

    if (mode === "save-input") {
      return (
        <Box flexDirection="column" gap={1}>
          <Text color="white">保存当前账号</Text>
          <TextInput value={saveName} placeholder="请输入快照名称" />
          <Text color={muted}>
            配置备份：{includeConfig ? "开启" : "关闭"}，按 C 切换
          </Text>
        </Box>
      );
    }

    return renderAccountList();
  };

  const helperText =
    mode === "menu"
      ? "↑/↓ 移动  Enter 确认  R 刷新  Q 退出"
      : mode === "import-input"
        ? "回车导入  Esc 返回  Q 退出"
      : mode === "save-input"
        ? "回车保存  C 切换配置  Esc 返回  Q 退出"
        : mode === "switch-confirm"
          ? `Enter 确认  C 恢复配置:${restoreConfig ? "开" : "关"}  Esc 返回  Q 退出`
          : "↑/↓ 移动  Enter 确认  Esc 返回  Q 退出";

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text color={muted}>当前位置：{getBreadcrumb()}</Text>
      </Box>

      <Box borderStyle="round" borderColor={accent} paddingX={1}>
        <Box>
          <Box width="44%" flexDirection="column" paddingRight={2}>
            <Text color={accent}>codex switch</Text>
            <Box width={18}>
              <Text color={accent}>{logoFrames[emojiIndex]}</Text>
            </Box>
            <Box marginTop={1} />
            <Text color="white">{truncate(fmt(currentEmail), 36)}</Text>
            <Text color={muted}>expires: {prettyDate(status?.current?.expiresAt)}</Text>
            <Text color={muted}>auth: {truncate(fmt(status?.authPath), 42)}</Text>
            <Text color={muted}>config: {truncate(fmt(status?.configPath), 42)}</Text>
          </Box>

          <Box width={1} marginRight={2} flexDirection="column">
            {panelDivider.map((lineKey) => (
              <Text key={lineKey} color={accent}>│</Text>
            ))}
          </Box>

          <Box width="56%" flexDirection="column">
            <Text color={accent}>已保存账号</Text>
            {infoAccounts.length === 0 ? (
              <Text color={muted}>暂无已保存账号。</Text>
            ) : (
              <Box flexDirection="column">
                {infoAccounts.map((account, index) => {
                  const isActive =
                    account.meta.summary.accountId !== "unknown" &&
                    account.meta.summary.accountId === status?.current?.accountId;

                  return (
                    <Box key={account.meta.name} flexDirection="column" marginBottom={0}>
                      <Text color="white">
                        {index + 1}.{" "}
                        {truncate(
                          fmt(
                            account.meta.summary.email ??
                              account.meta.summary.name ??
                              account.meta.name,
                          ),
                          34,
                        )}
                        {isActive ? "  " : ""}
                        {isActive ? <Text color={success}>active</Text> : null}
                      </Text>
                      <Text color={muted}>
                        {"  "}expires {prettyDate(account.meta.summary.expiresAt)}
                      </Text>
                    </Box>
                  );
                })}
              </Box>
            )}
          </Box>
        </Box>
      </Box>

      <Box marginTop={1}>
        {renderBody()}
      </Box>

      <Box marginTop={1}>
        <Text color={statusColor}>{truncate(banner.text)}</Text>
      </Box>

      <Box marginTop={1} gap={1}>
        <Text backgroundColor="#1f2937" color="#d1d5db">
          {mode === "menu"
            ? " ↑/↓ 移动  Enter 确认  R 刷新 "
            : mode === "save-input"
              ? " 回车保存  C 切换配置  Esc 返回 "
              : mode === "switch-confirm"
                ? ` Enter 确认  C 恢复配置:${restoreConfig ? "开" : "关"}  Esc 返回 `
                : " ↑/↓ 移动  Enter 确认  Esc 返回 "}
        </Text>
        <Text backgroundColor="#7f1d1d" color="#fecaca">
          {" Q 退出 "}
        </Text>
      </Box>
    </Box>
  );
}
