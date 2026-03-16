# codex-switch

`codex-switch` 是一个给 Codex 多账号切换准备的本地工具。

- 支持保存和切换多个 ChatGPT / Codex 账号快照
- 支持 macOS 原生菜单栏应用
- 支持 Node.js CLI / TUI
- 仓库已整理为 `pnpm monorepo`，包含 `apps/cli` 和 `apps/macos-menubar`

## 截图

TUI 首页：

![codex-switch tui](./docs/screenshots/tui-home.png)

macOS 菜单栏：

![codex-switch menubar](./docs/screenshots/menubar.png)

## 快速启动

### 方式 1：直接下载 Release 产物

打开最新 release：

[https://github.com/pinky-pig/codex-switch/releases/latest](https://github.com/pinky-pig/codex-switch/releases/latest)

下载 macOS 产物后：

1. 解压 `Codex-Switch-macOS.zip`
2. 双击 `Codex Switch.app`
3. 顶部菜单栏会出现 `codex-switch` 图标
4. 点击菜单栏图标即可使用

建议：

1. 把 `Codex Switch.app` 拖到 `Applications`
2. 再拖到 Dock，后续就和普通软件一样打开

### 方式 2：本地构建

```bash
pnpm install
pnpm build
pnpm open:app
```

如果你还想全局使用 CLI：

```bash
pnpm install:local
```

安装后可以直接使用：

```bash
codex-switch
```

或者：

```bash
cxs
```

## 安装 menubar app

要求：

- macOS
- Node.js 20+
- 已安装并登录过 `codex`

本地构建菜单栏应用：

```bash
pnpm install
pnpm build:menubar
open apps/macos-menubar/dist/'Codex Switch.app'
```

构建产物位置：

[`apps/macos-menubar/dist/Codex Switch.app`](/Users/wangwenbo/Desktop/demo/codex-switch/apps/macos-menubar/dist/Codex%20Switch.app)

菜单栏关闭后，重新打开方式：

- 双击 `Codex Switch.app`
- 或执行 `pnpm open:app`
- 或把它拖到 `Applications` / Dock 后再点击打开

## 全局命令

构建 CLI：

```bash
pnpm build:cli
```

CLI 包位置：

```bash
apps/cli
```

常用命令：

```bash
cxs tui
cxs save my-main
cxs save work --with-config
cxs list
cxs current
cxs use work
cxs use work --restore-config
cxs doctor
cxs remove work
cxs app-state
cxs save-current-auto
cxs add-account
```

## 技术栈

当前项目分两层：

### Workspace 结构

- `apps/cli`
- `apps/macos-menubar`
- `assets`
- `docs`

### CLI / TUI

- Node.js
- TypeScript
- Commander
- React
- Ink
- tsup

### macOS 菜单栏应用

- Swift
- AppKit / `NSStatusItem`
- 原生 macOS `.app` 打包

### 历史实现

仓库里仍然保留了早期 AppleScript 方案，用于记录原型演进：

- [`apps/macos-menubar/macos/menubar-app/CodexSwitch.applescript`](/Users/wangwenbo/Desktop/demo/codex-switch/apps/macos-menubar/macos/menubar-app/CodexSwitch.applescript)

当前真正在线使用的是 Swift menubar 版本：

- [`apps/macos-menubar/macos/menubar-swift/main.swift`](/Users/wangwenbo/Desktop/demo/codex-switch/apps/macos-menubar/macos/menubar-swift/main.swift)

## 存储说明

账号快照默认保存在：

```text
~/.codex-switch/accounts/<name>/
```

每个快照包含：

- `auth.json`
- `meta.json`
- `config.toml`，仅在使用 `--with-config` 保存时存在

## 常见问题

### 1. 为什么切换账号后当前会话没有马上变？

切换会覆盖当前的 `~/.codex/auth.json`，但已经运行中的 VS Code、Codex 桌面端、终端会话通常不会自动热更新认证状态。

处理方式：

1. 切换成功后，重启当前 VS Code / Codex / 终端中的会话
2. 重启后再继续使用新的账号

### 2. 菜单栏应用和 CLI 用的是同一份账号数据吗？

是的。两者都读写同一个全局账号目录：

```text
~/.codex-switch/accounts/
```

### 3. `config.toml` 会一起切换吗？

默认不会。

- 普通切换只恢复 `auth.json`
- 只有在保存时带了 `--with-config`，并且切换时显式使用 `--restore-config`，才会恢复对应的 `config.toml`

### 4. 账号快照安全吗？

需要注意：

- 快照里保存的是高敏感认证信息
- 本工具写入文件时使用的是 owner-only 权限
- 不要把 `~/.codex-switch/` 或项目里的 `./.codex-switch/` 提交到 git

### 5. 如何重新全局生效最新代码？

如果你修改了项目代码，重新执行：

```bash
pnpm build
pnpm install:local
```

## Release 文档

release 说明统一放在：

- [`docs/releases/README.md`](/Users/wangwenbo/Desktop/demo/codex-switch/docs/releases/README.md)
- [`docs/releases/v0.1.0.md`](/Users/wangwenbo/Desktop/demo/codex-switch/docs/releases/v0.1.0.md)
