# codex-switch

`codex-switch` 是一个给 Codex 多账号切换准备的本地工具。

- 支持把当前 `~/.codex/auth.json` 保存成账号快照
- 支持在多个 ChatGPT / Codex 账号之间快速切换
- 支持 macOS 原生菜单栏应用和命令行两种入口

## 截图

TUI 首页：

![codex-switch tui](./docs/screenshots/tui-home.png)

macOS 菜单栏：

![codex-switch menubar](./docs/screenshots/menubar.png)

## 安装 menubar app

要求：

- macOS
- Node.js 20+
- 已安装并登录过 `codex`

安装依赖：

```bash
npm install
```

构建菜单栏应用：

```bash
npm run build:menubar
```

启动菜单栏应用：

```bash
open dist/macos/'Codex Switch.app'
```

账号快照默认保存在：

```text
~/.codex-switch/accounts/<name>/
```

每个快照包含：

- `auth.json`
- `meta.json`
- `config.toml`，仅在使用 `--with-config` 保存时存在

## 全局命令

构建 CLI：

```bash
npm run build
```

全局安装到本机：

```bash
npm link
```

安装后可以直接使用：

```bash
codex-switch
```

或者：

```bash
cxs
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

## 常见问题

### 1. 为什么切换账号后当前会话没有马上变？

切换会覆盖当前的 `~/.codex/auth.json`，但已经运行中的 VS Code、Codex 桌面端、终端会话通常不会自动热更新认证状态。

处理方式：

- 切换成功后，重启当前 VS Code / Codex / 终端中的会话
- 重启后再继续使用新的账号

### 2. 为什么我在别的目录运行 `cxs` 看不到之前保存的账号？

现在已经改成全局统一存储，账号不再跟当前目录绑定。默认目录是：

```text
~/.codex-switch/accounts/
```

### 3. 菜单栏应用和 CLI 用的是同一份账号数据吗？

是的。两者都读写同一个全局账号目录：

```text
~/.codex-switch/accounts/
```

### 4. `config.toml` 会一起切换吗？

默认不会。

- 普通切换只恢复 `auth.json`
- 只有在保存时带了 `--with-config`，并且切换时显式使用 `--restore-config`，才会恢复对应的 `config.toml`

### 5. 账号快照安全吗？

需要注意：

- 快照里保存的是高敏感认证信息
- 本工具写入文件时使用的是 owner-only 权限
- 不要把 `~/.codex-switch/` 或项目里的 `./.codex-switch/` 提交到 git

### 6. 如何重新全局生效最新代码？

如果你修改了项目代码，重新执行：

```bash
npm run build
npm run build:menubar
npm link
```

