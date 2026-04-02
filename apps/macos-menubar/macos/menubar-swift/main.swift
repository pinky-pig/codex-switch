import AppKit
import Foundation
import UniformTypeIdentifiers

struct GeneratedConfig {
  static let runtimePath = "__RUNTIME_PATH__"
  static let appIconName = "AppIcon.icns"
  static let statusIconName = "cxs-menubar-template-hires.png"
}

struct AppState: Decodable {
  struct UsageWindow: Decodable {
    let usedPercent: Int?
    let windowMinutes: Int?
    let resetsAt: String?
  }

  struct StoredUsage: Decodable {
    let fetchedAt: String
    let planType: String?
    let primary: UsageWindow?
    let secondary: UsageWindow?
    let error: String?
  }

  struct Runtime: Decodable {
    let codexHome: String
    let authPath: String
    let configPath: String
    let current: AccountSummary?
  }

  struct Account: Decodable {
    let name: String
    let savedAt: String
    let includesConfig: Bool
    let active: Bool
    let summary: AccountSummary
    let usage: StoredUsage?
  }

  let storeDir: String
  let runtime: Runtime
  let accounts: [Account]
}

struct AccountSummary: Decodable {
  let accountId: String
  let email: String?
  let name: String?
  let authMode: String?
  let lastRefresh: String?
  let expiresAt: String?
}

enum CLIError: Error {
  case commandFailed(String)
  case invalidOutput(String)
}

final class AppDelegate: NSObject, NSApplicationDelegate {
  private static let suppressSwitchAlertKey = "suppressSwitchSuccessAlert"
  private static let autoRefreshInterval: TimeInterval = 600
  private var statusItem: NSStatusItem?
  private var state: AppState?
  private var refreshTimer: Timer?
  private let isoFormatterWithFractional: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
  }()
  private let isoFormatter: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime]
    return formatter
  }()
  private let maxLineLength = 42

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.accessory)
    ensureCliShims()
    setupStatusItem()
    refreshMenu()
    refreshUsageInBackground()
    scheduleAutoRefresh()
  }

  func applicationWillTerminate(_ notification: Notification) {
    refreshTimer?.invalidate()
    refreshTimer = nil
  }

  private func setupStatusItem() {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    self.statusItem = item

    if let button = item.button {
      button.toolTip = "codex-switch"

      if let icon = loadStatusIcon() {
        button.image = icon
        button.imagePosition = .imageOnly
        button.imageScaling = .scaleProportionallyDown
      } else {
        button.title = "cxs"
      }
    }
  }

  private func loadStatusIcon() -> NSImage? {
    guard let resourceURL = Bundle.main.resourceURL else {
      return nil
    }

    let iconURL = resourceURL.appendingPathComponent(GeneratedConfig.statusIconName)
    guard let image = NSImage(contentsOf: iconURL) else {
      return nil
    }

    image.isTemplate = true
    image.size = NSSize(width: 16, height: 16)
    return image
  }

  private func scheduleAutoRefresh() {
    refreshTimer?.invalidate()
    refreshTimer = Timer.scheduledTimer(
      withTimeInterval: Self.autoRefreshInterval,
      repeats: true
    ) { [weak self] _ in
      self?.refreshUsageInBackground()
    }
  }

  private func refreshUsageInBackground() {
    runAsync {
      _ = try self.runCLI(arguments: ["refresh-usage"])
    }
  }

  private func refreshMenu() {
    do {
      state = try fetchState()
      statusItem?.menu = buildMenu()
    } catch {
      statusItem?.menu = buildErrorMenu(message: error.localizedDescription)
    }
  }

  private func buildMenu() -> NSMenu {
    let menu = NSMenu()
    addDisabledItem(title: "快速切换账号", to: menu)
    appendQuickSwitchItems(to: menu)

    menu.addItem(.separator())
    let refreshQuotaItem = NSMenuItem(title: "刷新额度", action: #selector(refreshUsageMenu), keyEquivalent: "")
    refreshQuotaItem.target = self
    menu.addItem(refreshQuotaItem)

    let deleteAccountsItem = NSMenuItem(title: "删除账号", action: nil, keyEquivalent: "")
    deleteAccountsItem.submenu = buildDeleteAccountsSubmenu()
    menu.addItem(deleteAccountsItem)

    let addAccountItem = NSMenuItem(title: "添加 Codex 账号", action: nil, keyEquivalent: "")
    addAccountItem.submenu = buildAddAccountSubmenu()
    menu.addItem(addAccountItem)

    menu.addItem(.separator())
    addDisabledItem(title: "auth config", to: menu)
    appendConfigItems(to: menu)

    menu.addItem(.separator())

    let quitItem = NSMenuItem(title: "退出", action: #selector(quitApp), keyEquivalent: "q")
    quitItem.target = self
    menu.addItem(quitItem)

    return menu
  }

  private func appendQuickSwitchItems(to menu: NSMenu) {
    let accounts = state?.accounts ?? []

    if accounts.isEmpty {
      addDisabledItem(title: "暂无已保存账号", to: menu)
      return
    }

    for account in accounts {
      let item = NSMenuItem(title: account.name, action: #selector(switchAccount(_:)), keyEquivalent: "")
      item.target = self
      item.representedObject = account.name
      item.state = account.active ? .on : .off
      item.attributedTitle = buildQuickSwitchTitle(name: account.name, usage: account.usage)
      menu.addItem(item)
    }
  }

  private func buildDeleteAccountsSubmenu() -> NSMenu {
    let submenu = NSMenu()
    let accounts = state?.accounts ?? []

    if accounts.isEmpty {
      addDisabledItem(title: "暂无已保存账号", to: submenu)
      return submenu
    }

    for account in accounts {
      let title = truncate(account.name)
      let deleteItem = NSMenuItem(title: title, action: #selector(deleteAccount(_:)), keyEquivalent: "")
      deleteItem.target = self
      deleteItem.representedObject = account.name
      submenu.addItem(deleteItem)
    }

    return submenu
  }

  private func buildAddAccountSubmenu() -> NSMenu {
    let submenu = NSMenu()

    let loginItem = NSMenuItem(title: "登录 ChatGPT 账号", action: #selector(addAccount), keyEquivalent: "")
    loginItem.target = self
    submenu.addItem(loginItem)

    let importItem = NSMenuItem(title: "导入 auth.json", action: #selector(importAuthAccount), keyEquivalent: "")
    importItem.target = self
    submenu.addItem(importItem)

    let saveItem = NSMenuItem(
      title: "保存当前使用的 Codex 账号到工具",
      action: #selector(saveCurrentAccount),
      keyEquivalent: ""
    )
    saveItem.target = self
    submenu.addItem(saveItem)

    return submenu
  }

  private func appendConfigItems(to menu: NSMenu) {
    guard let runtime = state?.runtime else {
      addDisabledItem(title: "n/a", to: menu)
      return
    }

    let authItem = NSMenuItem(title: truncate("打开 auth.json"), action: #selector(openAuthInFinder), keyEquivalent: "")
    authItem.target = self
    authItem.representedObject = runtime.authPath
    menu.addItem(authItem)

    let configItem = NSMenuItem(title: truncate("打开 config.toml"), action: #selector(openConfigInFinder), keyEquivalent: "")
    configItem.target = self
    configItem.representedObject = runtime.configPath
    menu.addItem(configItem)
  }

  private func buildErrorMenu(message: String) -> NSMenu {
    let menu = NSMenu()
    addDisabledItem(title: "读取状态失败", to: menu)
    addDisabledItem(title: message, to: menu)
    menu.addItem(.separator())

    let quitItem = NSMenuItem(title: "退出", action: #selector(quitApp), keyEquivalent: "q")
    quitItem.target = self
    menu.addItem(quitItem)

    return menu
  }

  private func addDisabledItem(title: String, to menu: NSMenu) {
    let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
    item.isEnabled = false
    menu.addItem(item)
  }

  private func truncate(_ value: String, maxLength: Int? = nil) -> String {
    let limit = maxLength ?? maxLineLength
    guard value.count > limit else {
      return value
    }

    let endIndex = value.index(value.startIndex, offsetBy: max(0, limit - 1))
    return "\(value[..<endIndex])…"
  }

  private func formatDate(_ value: String?) -> String {
    guard let date = parseISODate(value) else {
      return "n/a"
    }

    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "zh_CN")
    formatter.dateFormat = "yyyy-MM-dd HH:mm"
    return formatter.string(from: date)
  }

  private func formatShortDate(_ value: String?) -> String {
    guard let date = parseISODate(value) else {
      return "n/a"
    }

    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.dateFormat = "MM/dd HH:mm"
    return formatter.string(from: date)
  }

  private func formatTimeOnly(_ value: String?) -> String {
    guard let date = parseISODate(value) else {
      return "n/a"
    }

    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.dateFormat = "HH:mm"
    return formatter.string(from: date)
  }

  private func formatMonthDayTime(_ value: String?) -> String {
    guard let date = parseISODate(value) else {
      return "n/a"
    }

    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.dateFormat = "MM/dd HH:mm"
    return formatter.string(from: date)
  }

  private func remainingPercent(_ usedPercent: Int?) -> Int? {
    guard let usedPercent else {
      return nil
    }

    return max(0, min(100, 100 - usedPercent))
  }

  private func formatQuotaSummary(_ usage: AppState.StoredUsage?) -> String {
    guard let usage else {
      return "quota n/a"
    }

    if usage.error != nil {
      return "quota n/a"
    }

    guard
      let primaryRemaining = remainingPercent(usage.primary?.usedPercent),
      let secondaryRemaining = remainingPercent(usage.secondary?.usedPercent)
    else {
      return "quota n/a"
    }

    let primaryReset = formatTimeOnly(usage.primary?.resetsAt)
    let secondaryReset = formatMonthDayTime(usage.secondary?.resetsAt)
    return "5h \(primaryRemaining)% (\(primaryReset)) · weekly \(secondaryRemaining)% (\(secondaryReset))"
  }

  private func buildQuickSwitchTitle(
    name: String,
    usage: AppState.StoredUsage?,
  ) -> NSAttributedString {
    let title = NSMutableAttributedString(
      string: truncate(name, maxLength: 22),
      attributes: [
        .font: NSFont.menuFont(ofSize: NSFont.systemFontSize),
        .foregroundColor: NSColor.labelColor,
      ]
    )

    let quotaText = formatQuotaSummary(usage)
    title.append(
      NSAttributedString(
        string: "\n    \(quotaText)",
        attributes: [
          .font: NSFont.systemFont(ofSize: NSFont.smallSystemFontSize),
          .foregroundColor: NSColor.secondaryLabelColor,
        ]
      )
    )

    return title
  }

  private func parseISODate(_ value: String?) -> Date? {
    guard let value else {
      return nil
    }

    return isoFormatterWithFractional.date(from: value) ?? isoFormatter.date(from: value)
  }

  private func fetchState() throws -> AppState {
    let output = try runCLI(arguments: ["app-state"])
    guard let data = output.data(using: .utf8) else {
      throw CLIError.invalidOutput("CLI returned non-UTF8 output.")
    }

    return try JSONDecoder().decode(AppState.self, from: data)
  }

  private func standardNodeSearchPaths(homeDir: String) -> [String] {
    [
      "/opt/homebrew/bin/node",
      "/usr/local/bin/node",
      "\(homeDir)/.nvm/current/bin/node",
    ]
  }

  private func parseSemver(_ value: String) -> [Int] {
    let normalized = value.hasPrefix("v") ? String(value.dropFirst()) : value
    return normalized.split(separator: ".").map { Int($0) ?? 0 }
  }

  private func nvmNodeCandidates(homeDir: String) -> [String] {
    let baseURL = URL(fileURLWithPath: "\(homeDir)/.nvm/versions/node", isDirectory: true)
    guard
      let directories = try? FileManager.default.contentsOfDirectory(
        at: baseURL,
        includingPropertiesForKeys: [.isDirectoryKey],
        options: [.skipsHiddenFiles]
      )
    else {
      return []
    }

    let sortedDirectories = directories.sorted { lhs, rhs in
      let leftVersion = parseSemver(lhs.lastPathComponent)
      let rightVersion = parseSemver(rhs.lastPathComponent)
      return leftVersion.lexicographicallyPrecedes(rightVersion) == false
    }

    return sortedDirectories.map { $0.appendingPathComponent("bin/node").path }
  }

  private func augmentedPath(homeDir: String) -> String {
    var entries = (ProcessInfo.processInfo.environment["PATH"] ?? "")
      .split(separator: ":")
      .map(String.init)

    entries.append(contentsOf: [
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/opt/homebrew/sbin",
      "/usr/sbin",
      "/sbin",
      "\(homeDir)/.nvm/current/bin",
    ])

    for candidate in nvmNodeCandidates(homeDir: homeDir) {
      let binDir = URL(fileURLWithPath: candidate).deletingLastPathComponent().path
      entries.append(binDir)
    }

    var seen = Set<String>()
    return entries.filter { entry in
      guard !entry.isEmpty else {
        return false
      }
      return seen.insert(entry).inserted
    }.joined(separator: ":")
  }

  private func resolveNodeFromPath(path: String) -> String? {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/which")
    process.arguments = ["node"]
    process.environment = ["PATH": path]

    let outputPipe = Pipe()
    process.standardOutput = outputPipe
    process.standardError = Pipe()

    do {
      try process.run()
      process.waitUntilExit()
    } catch {
      return nil
    }

    guard process.terminationStatus == 0 else {
      return nil
    }

    let output = String(
      data: outputPipe.fileHandleForReading.readDataToEndOfFile(),
      encoding: .utf8
    )?.trimmingCharacters(in: .whitespacesAndNewlines)

    guard let output, !output.isEmpty else {
      return nil
    }

    return output
  }

  private func resolveNodeBinary() -> String? {
    let homeDir = FileManager.default.homeDirectoryForCurrentUser.path
    let searchPath = augmentedPath(homeDir: homeDir)

    if let nodeFromPath = resolveNodeFromPath(path: searchPath),
       FileManager.default.isExecutableFile(atPath: nodeFromPath) {
      return nodeFromPath
    }

    let explicitCandidates = standardNodeSearchPaths(homeDir: homeDir) + nvmNodeCandidates(homeDir: homeDir)
    for candidate in explicitCandidates {
      if FileManager.default.isExecutableFile(atPath: candidate) {
        return candidate
      }
    }

    return nil
  }

  private func runCommand(executable: String, arguments: [String]) -> String? {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments

    let outputPipe = Pipe()
    process.standardOutput = outputPipe
    process.standardError = Pipe()

    do {
      try process.run()
      process.waitUntilExit()
    } catch {
      return nil
    }

    guard process.terminationStatus == 0 else {
      return nil
    }

    return String(
      data: outputPipe.fileHandleForReading.readDataToEndOfFile(),
      encoding: .utf8
    )
  }

  private func parseKeyValueMap(_ text: String) -> [String: String] {
    var values: [String: String] = [:]
    for rawLine in text.split(separator: "\n") {
      let line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !line.isEmpty else {
        continue
      }

      let parts = line.split(separator: ":", maxSplits: 1).map {
        String($0).trimmingCharacters(in: .whitespacesAndNewlines)
      }
      if parts.count == 2 {
        values[parts[0]] = parts[1]
      }
    }
    return values
  }

  private func systemProxyEnvironment() -> [String: String] {
    guard let output = runCommand(executable: "/usr/sbin/scutil", arguments: ["--proxy"]) else {
      return [:]
    }

    let values = parseKeyValueMap(output)
    var env: [String: String] = [:]

    var hasProxy = false

    if values["HTTPEnable"] == "1",
       let host = values["HTTPProxy"],
       let port = values["HTTPPort"] {
      let proxy = "http://\(host):\(port)"
      env["HTTP_PROXY"] = proxy
      env["http_proxy"] = proxy
      hasProxy = true
    }

    if values["HTTPSEnable"] == "1",
       let host = values["HTTPSProxy"],
       let port = values["HTTPSPort"] {
      let proxy = "http://\(host):\(port)"
      env["HTTPS_PROXY"] = proxy
      env["https_proxy"] = proxy
      hasProxy = true
    }

    if values["SOCKSEnable"] == "1",
       let host = values["SOCKSProxy"],
       let port = values["SOCKSPort"] {
      let proxy = "socks5://\(host):\(port)"
      env["ALL_PROXY"] = proxy
      env["all_proxy"] = proxy
      hasProxy = true
    }

    env["NO_PROXY"] = "localhost,127.0.0.1,::1"
    env["no_proxy"] = "localhost,127.0.0.1,::1"
    if hasProxy {
      // Node fetch only honors proxy vars when this flag is enabled.
      env["NODE_USE_ENV_PROXY"] = "1"
    }

    return env
  }

  private func runCLI(arguments: [String]) throws -> String {
    guard let nodeBinary = resolveNodeBinary() else {
      throw CLIError.commandFailed("未找到 Node.js，请安装 Node.js 20+。支持 PATH、Homebrew、/usr/local 和 nvm。只安装 bun 不行。")
    }

    let homeDir = FileManager.default.homeDirectoryForCurrentUser.path
    let process = Process()
    process.executableURL = URL(fileURLWithPath: nodeBinary)
    process.arguments = [GeneratedConfig.runtimePath] + arguments
    var environment = ProcessInfo.processInfo.environment
    environment["PATH"] = augmentedPath(homeDir: homeDir)
    for (key, value) in systemProxyEnvironment() {
      environment[key] = value
    }
    process.environment = environment

    let outputPipe = Pipe()
    let errorPipe = Pipe()
    process.standardOutput = outputPipe
    process.standardError = errorPipe

    try process.run()
    process.waitUntilExit()

    let output = String(data: outputPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    let error = String(data: errorPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""

    guard process.terminationStatus == 0 else {
      throw CLIError.commandFailed(error.isEmpty ? output : error)
    }

    return output
  }

  private func runAsync(
    successMessage: String? = nil,
    successAction: (() -> Void)? = nil,
    _ work: @escaping () throws -> Void,
  ) {
    DispatchQueue.global(qos: .userInitiated).async {
      do {
        try work()
        DispatchQueue.main.async {
          self.refreshMenu()
          if let successAction {
            successAction()
          } else if let successMessage {
            self.showInfo(successMessage)
          }
        }
      } catch {
        DispatchQueue.main.async { self.showError(error.localizedDescription) }
      }
    }
  }

  private func showInfo(_ message: String) {
    let alert = NSAlert()
    alert.messageText = "codex-switch"
    alert.informativeText = message
    alert.runModal()
  }

  private func showSwitchSuccessAlert() {
    guard !UserDefaults.standard.bool(forKey: Self.suppressSwitchAlertKey) else {
      return
    }

    let alert = NSAlert()
    alert.messageText = "账号切换成功"
    alert.informativeText = "请重启当前 VS Code / Codex / 终端中的会话，新的账号才会生效。"
    alert.addButton(withTitle: "知道了")
    alert.addButton(withTitle: "以后不再提示")

    if alert.runModal() == .alertSecondButtonReturn {
      UserDefaults.standard.set(true, forKey: Self.suppressSwitchAlertKey)
    }
  }

  private func shellQuote(_ value: String) -> String {
    return "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
  }

  private func nvmBinDirectories(homeDir: String) -> [String] {
    let basePath = "\(homeDir)/.nvm/versions/node"
    guard let entries = try? FileManager.default.contentsOfDirectory(atPath: basePath) else {
      return []
    }

    return entries.map { "\(basePath)/\($0)/bin" }
  }

  private func ensureCliShims() {
    let fileManager = FileManager.default
    let homeDir = fileManager.homeDirectoryForCurrentUser.path
    var candidateDirs: [String] = []
    candidateDirs.append(contentsOf: [
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "\(homeDir)/.nvm/current/bin",
      "\(homeDir)/.local/bin",
      "\(homeDir)/bin",
    ])
    candidateDirs.append(contentsOf: nvmBinDirectories(homeDir: homeDir))
    var seenDirs = Set<String>()
    let appBundlePath = Bundle.main.bundlePath

    let script = """
    #!/bin/sh
    open \(shellQuote(appBundlePath))
    """

    for dir in candidateDirs {
      guard seenDirs.insert(dir).inserted else {
        continue
      }

      do {
        try fileManager.createDirectory(
          at: URL(fileURLWithPath: dir),
          withIntermediateDirectories: true
        )

        guard fileManager.isWritableFile(atPath: dir) else {
          continue
        }

        for name in ["codex-switch", "cxs"] {
          let target = URL(fileURLWithPath: dir).appendingPathComponent(name)
          if fileManager.fileExists(atPath: target.path) {
            try fileManager.removeItem(at: target)
          }
          try script.write(to: target, atomically: true, encoding: .utf8)
          try fileManager.setAttributes(
            [.posixPermissions: 0o755],
            ofItemAtPath: target.path
          )
        }

        return
      } catch {
        continue
      }
    }
  }

  private func showError(_ message: String) {
    let alert = NSAlert()
    alert.messageText = "codex-switch"
    alert.informativeText = message
    alert.runModal()
  }

  @objc private func saveCurrentAccount() {
    runAsync {
      _ = try self.runCLI(arguments: ["save-current-auto"])
    }
  }

  @objc private func refreshUsageMenu() {
    refreshUsageInBackground()
  }

  @objc private func addAccount() {
    runAsync {
      _ = try self.runCLI(arguments: ["add-account"])
    }
  }

  @objc private func importAuthAccount() {
    let panel = NSOpenPanel()
    panel.canChooseFiles = true
    panel.canChooseDirectories = false
    panel.allowsMultipleSelection = false
    panel.allowedContentTypes = [.json]
    panel.prompt = "导入"
    panel.message = "选择要导入的 auth.json 文件。"

    guard panel.runModal() == .OK, let url = panel.url else {
      return
    }

    runAsync {
      _ = try self.runCLI(arguments: ["import-auth", url.path])
    }
  }

  @objc private func switchAccount(_ sender: NSMenuItem) {
    guard let name = sender.representedObject as? String else {
      return
    }

    runAsync(successAction: { self.showSwitchSuccessAlert() }) {
      _ = try self.runCLI(arguments: ["use", name])
    }
  }

  @objc private func deleteAccount(_ sender: NSMenuItem) {
    guard let name = sender.representedObject as? String else {
      return
    }

    let alert = NSAlert()
    alert.messageText = "确认删除"
    alert.informativeText = "删除 \(name) ?"
    alert.alertStyle = .warning
    alert.addButton(withTitle: "删除")
    alert.addButton(withTitle: "取消")

    guard alert.runModal() == .alertFirstButtonReturn else {
      return
    }

    runAsync {
      _ = try self.runCLI(arguments: ["remove", name])
    }
  }

  @objc private func openAuthInFinder(_ sender: NSMenuItem) {
    guard let path = sender.representedObject as? String else {
      return
    }

    NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
  }

  @objc private func openConfigInFinder(_ sender: NSMenuItem) {
    guard let path = sender.representedObject as? String else {
      return
    }

    NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
  }

  @objc private func quitApp() {
    NSApp.terminate(nil)
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
