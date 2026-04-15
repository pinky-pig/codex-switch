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

extension CLIError: LocalizedError {
  var errorDescription: String? {
    switch self {
    case .commandFailed(let message), .invalidOutput(let message):
      return message
    }
  }
}

private struct CustomApiFormValues {
  let name: String
  let baseURL: String
  let apiKey: String
  let model: String
  let reasoningEffort: String
}

private final class TextPreviewWindowController: NSObject, NSWindowDelegate {
  private let window: NSWindow
  private var closingWithResponse: NSApplication.ModalResponse?

  init(title: String, content: String) {
    self.window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 720, height: 520),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered,
      defer: false
    )
    super.init()
    setupWindow(title: title, content: content)
  }

  func runModal() {
    closingWithResponse = nil
    NSApp.activate(ignoringOtherApps: true)
    window.center()
    window.makeKeyAndOrderFront(nil)
    _ = NSApp.runModal(for: window)
    window.orderOut(nil)
  }

  func windowWillClose(_ notification: Notification) {
    if NSApp.modalWindow === window && closingWithResponse == nil {
      NSApp.stopModal(withCode: .cancel)
    }
  }

  private func setupWindow(title: String, content: String) {
    window.title = title
    window.isReleasedWhenClosed = false
    window.delegate = self
    window.minSize = NSSize(width: 560, height: 360)

    let textView = NSTextView(frame: NSRect(x: 0, y: 0, width: 640, height: 400))
    textView.string = content
    textView.isEditable = false
    textView.isSelectable = true
    textView.isRichText = false
    textView.font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
    textView.textColor = .textColor
    textView.backgroundColor = .textBackgroundColor
    textView.textContainerInset = NSSize(width: 12, height: 12)
    textView.isHorizontallyResizable = true
    textView.isVerticallyResizable = true
    textView.minSize = NSSize(width: 0, height: 0)
    textView.maxSize = NSSize(
      width: CGFloat.greatestFiniteMagnitude,
      height: CGFloat.greatestFiniteMagnitude
    )
    textView.autoresizingMask = []
    textView.textContainer?.widthTracksTextView = false
    textView.textContainer?.containerSize = NSSize(
      width: CGFloat.greatestFiniteMagnitude,
      height: CGFloat.greatestFiniteMagnitude
    )

    let scrollView = NSScrollView()
    scrollView.drawsBackground = true
    scrollView.borderType = .bezelBorder
    scrollView.hasVerticalScroller = true
    scrollView.hasHorizontalScroller = true
    scrollView.autohidesScrollers = true
    scrollView.translatesAutoresizingMaskIntoConstraints = false
    scrollView.documentView = textView

    let closeButton = NSButton(title: "关闭", target: self, action: #selector(closeWindow))
    closeButton.bezelStyle = .rounded

    let spacer = NSView()
    spacer.translatesAutoresizingMaskIntoConstraints = false
    spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)

    let footer = NSStackView(views: [spacer, closeButton])
    footer.orientation = .horizontal
    footer.alignment = .centerY
    footer.spacing = 10
    footer.translatesAutoresizingMaskIntoConstraints = false

    let contentView = NSView()
    contentView.translatesAutoresizingMaskIntoConstraints = false
    contentView.addSubview(scrollView)
    contentView.addSubview(footer)
    window.contentView = contentView

    NSLayoutConstraint.activate([
      scrollView.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 20),
      scrollView.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -20),
      scrollView.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 20),
      scrollView.bottomAnchor.constraint(equalTo: footer.topAnchor, constant: -16),

      footer.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 20),
      footer.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -20),
      footer.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -20),
    ])
  }

  @objc private func closeWindow() {
    closingWithResponse = .OK
    NSApp.stopModal(withCode: .OK)
    window.close()
  }
}

private final class CustomApiAccountFormWindowController: NSObject, NSTextFieldDelegate, NSWindowDelegate {
  private let window: NSWindow
  private let defaultBaseURL: String
  private let existingConfigContent: String
  private let nameField = NSTextField(string: "")
  private let baseURLField: NSTextField
  private let apiKeyField = NSTextField(string: "")
  private let modelField = NSTextField(string: "gpt-5.4")
  private let reasoningField = NSPopUpButton()
  private let previewAuthButton = NSButton(title: "预览 auth.json", target: nil, action: nil)
  private let previewConfigButton = NSButton(title: "预览 config.toml", target: nil, action: nil)
  private let testButton = NSButton(title: "测试连接", target: nil, action: nil)
  private let saveButton = NSButton(title: "保存", target: nil, action: nil)
  private let cancelButton = NSButton(title: "取消", target: nil, action: nil)
  private let testHandler: (CustomApiFormValues, @escaping (Result<String, Error>) -> Void) -> Void
  private var result: CustomApiFormValues?
  private var closingWithResponse: NSApplication.ModalResponse?

  init(
    defaultBaseURL: String,
    existingConfigContent: String,
    testHandler: @escaping (CustomApiFormValues, @escaping (Result<String, Error>) -> Void) -> Void
  ) {
    self.defaultBaseURL = defaultBaseURL
    self.existingConfigContent = existingConfigContent
    self.baseURLField = NSTextField(string: defaultBaseURL)
    self.testHandler = testHandler
    self.window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 720, height: 390),
      styleMask: [.titled, .closable],
      backing: .buffered,
      defer: false
    )
    super.init()
    setupWindow()
    updatePreview()
    updateActionButtons()
  }

  func runModal() -> CustomApiFormValues? {
    closingWithResponse = nil
    NSApp.activate(ignoringOtherApps: true)
    window.center()
    window.makeKeyAndOrderFront(nil)
    let response = NSApp.runModal(for: window)
    window.orderOut(nil)
    return response == .OK ? result : nil
  }

  func windowWillClose(_ notification: Notification) {
    if NSApp.modalWindow === window && closingWithResponse == nil {
      NSApp.stopModal(withCode: .cancel)
    }
  }

  func controlTextDidChange(_ obj: Notification) {
    updatePreview()
    updateActionButtons()
  }

  private func setupWindow() {
    window.title = "添加自定义 API Key"
    window.isReleasedWhenClosed = false
    window.delegate = self
    window.minSize = NSSize(width: 700, height: 340)
    window.maxSize = NSSize(width: 920, height: 430)

    nameField.placeholderString = "例如: custom-main"
    baseURLField.placeholderString = "例如: http://123.56.169.10:48760/v1"
    apiKeyField.placeholderString = "输入 API Key"

    [nameField, baseURLField, apiKeyField, modelField].forEach(configureTextField)

    reasoningField.addItems(withTitles: ["low", "medium", "high", "xhigh"])
    reasoningField.selectItem(withTitle: "xhigh")
    reasoningField.target = self
    reasoningField.action = #selector(popupSelectionChanged)
    reasoningField.translatesAutoresizingMaskIntoConstraints = false
    reasoningField.setContentHuggingPriority(.required, for: .horizontal)
    reasoningField.setContentCompressionResistancePriority(.required, for: .horizontal)

    [previewAuthButton, previewConfigButton].forEach { button in
      button.bezelStyle = .rounded
      button.controlSize = .large
    }

    testButton.bezelStyle = .rounded
    testButton.target = self
    testButton.action = #selector(testConnection)

    saveButton.bezelStyle = .rounded
    saveButton.keyEquivalent = "\r"
    saveButton.target = self
    saveButton.action = #selector(saveForm)

    cancelButton.bezelStyle = .rounded
    cancelButton.keyEquivalent = "\u{1b}"
    cancelButton.target = self
    cancelButton.action = #selector(cancelForm)

    previewAuthButton.target = self
    previewAuthButton.action = #selector(previewAuthFile)

    previewConfigButton.target = self
    previewConfigButton.action = #selector(previewConfigFile)

    let noteLabel = NSTextField(
      wrappingLabelWithString: "切换到这类账号时，会保留你现有 config.toml 里的 projects、mcp 和其他 provider 配置，只更新 custom 相关字段。"
    )
    noteLabel.font = NSFont.systemFont(ofSize: 12)
    noteLabel.textColor = .secondaryLabelColor
    noteLabel.maximumNumberOfLines = 0
    noteLabel.translatesAutoresizingMaskIntoConstraints = false

    let modelReasoningLabel = NSTextField(labelWithString: "Reasoning Effort")
    modelReasoningLabel.font = NSFont.systemFont(ofSize: 12)
    modelReasoningLabel.textColor = .secondaryLabelColor

    let modelReasoningRow = NSStackView(views: [
      modelField,
      modelReasoningLabel,
      reasoningField,
    ])
    modelReasoningRow.orientation = .horizontal
    modelReasoningRow.alignment = .centerY
    modelReasoningRow.spacing = 10
    modelReasoningRow.translatesAutoresizingMaskIntoConstraints = false

    let settingsRows: [NSView] = [
      buildSettingsRow(title: "账号名称", valueView: nameField),
      buildSettingsRow(title: "Base URL", valueView: baseURLField),
      buildSettingsRow(title: "API Key", valueView: apiKeyField),
      buildSettingsRow(title: "Model / Effort", valueView: modelReasoningRow),
    ]

    let settingsCard = buildSettingsCard(rows: settingsRows)

    let previewRow = NSStackView(views: [
      previewAuthButton,
      previewConfigButton,
    ])
    previewRow.orientation = .horizontal
    previewRow.alignment = .centerY
    previewRow.spacing = 12
    previewRow.translatesAutoresizingMaskIntoConstraints = false
    previewRow.setHuggingPriority(.required, for: .horizontal)

    let previewLeftSpacer = NSView()
    previewLeftSpacer.translatesAutoresizingMaskIntoConstraints = false
    previewLeftSpacer.setContentHuggingPriority(.defaultLow, for: .horizontal)

    let previewRightSpacer = NSView()
    previewRightSpacer.translatesAutoresizingMaskIntoConstraints = false
    previewRightSpacer.setContentHuggingPriority(.defaultLow, for: .horizontal)

    let previewCardContent = NSStackView(views: [
      previewLeftSpacer,
      previewRow,
      previewRightSpacer,
    ])
    previewCardContent.orientation = .horizontal
    previewCardContent.alignment = .centerY
    previewCardContent.spacing = 0
    previewCardContent.translatesAutoresizingMaskIntoConstraints = false

    let previewCard = buildSettingsCard(content: previewCardContent, padding: 14)

    let formStack = NSStackView(views: [settingsCard, noteLabel, previewCard])
    formStack.orientation = .vertical
    formStack.alignment = .width
    formStack.spacing = 10
    formStack.translatesAutoresizingMaskIntoConstraints = false
    formStack.setContentHuggingPriority(.required, for: .vertical)

    let buttonSpacer = NSView()
    buttonSpacer.translatesAutoresizingMaskIntoConstraints = false
    buttonSpacer.setContentHuggingPriority(.defaultLow, for: .horizontal)

    let footerDivider = buildSeparator()

    let footerStack = NSStackView(views: [testButton, buttonSpacer, saveButton, cancelButton])
    footerStack.orientation = .horizontal
    footerStack.alignment = .centerY
    footerStack.spacing = 10
    footerStack.translatesAutoresizingMaskIntoConstraints = false

    let contentView = NSView()
    contentView.translatesAutoresizingMaskIntoConstraints = false
    contentView.addSubview(formStack)
    contentView.addSubview(footerDivider)
    contentView.addSubview(footerStack)
    window.contentView = contentView

    NSLayoutConstraint.activate([
      formStack.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 20),
      formStack.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -20),
      formStack.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 18),
      formStack.bottomAnchor.constraint(lessThanOrEqualTo: footerDivider.topAnchor, constant: -12),

      footerDivider.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
      footerDivider.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
      footerDivider.bottomAnchor.constraint(equalTo: footerStack.topAnchor, constant: -12),
      footerDivider.heightAnchor.constraint(equalToConstant: 1),

      footerStack.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 20),
      footerStack.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -20),
      footerStack.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -12),

      modelField.widthAnchor.constraint(greaterThanOrEqualToConstant: 220),
      reasoningField.widthAnchor.constraint(equalToConstant: 120),
    ])
  }

  private func configureTextField(_ field: NSTextField) {
    field.delegate = self
    field.font = NSFont.systemFont(ofSize: 13)
    field.isBordered = true
    field.isBezeled = true
    field.drawsBackground = true
    field.translatesAutoresizingMaskIntoConstraints = false
    field.setContentHuggingPriority(.defaultLow, for: .horizontal)
    field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
  }

  private func buildSettingsRow(title: String, valueView: NSView) -> NSView {
    let titleLabel = NSTextField(labelWithString: title)
    titleLabel.font = NSFont.systemFont(ofSize: 13, weight: .medium)
    titleLabel.textColor = .labelColor
    titleLabel.translatesAutoresizingMaskIntoConstraints = false
    titleLabel.setContentHuggingPriority(.required, for: .horizontal)
    titleLabel.setContentCompressionResistancePriority(.required, for: .horizontal)

    let rowStack = NSStackView(views: [titleLabel, valueView])
    rowStack.orientation = .horizontal
    rowStack.alignment = .centerY
    rowStack.spacing = 16
    rowStack.translatesAutoresizingMaskIntoConstraints = false

    let container = NSView()
    container.translatesAutoresizingMaskIntoConstraints = false
    container.addSubview(rowStack)

    NSLayoutConstraint.activate([
      rowStack.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 18),
      rowStack.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -18),
      rowStack.topAnchor.constraint(equalTo: container.topAnchor, constant: 10),
      rowStack.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -10),
      titleLabel.widthAnchor.constraint(equalToConstant: 120),
    ])

    return container
  }

  private func buildSettingsCard(rows: [NSView]) -> NSView {
    let stack = NSStackView()
    stack.orientation = .vertical
    stack.alignment = .width
    stack.spacing = 0
    stack.translatesAutoresizingMaskIntoConstraints = false

    for (index, row) in rows.enumerated() {
      stack.addArrangedSubview(row)
      if index < rows.count - 1 {
        stack.addArrangedSubview(buildInsetSeparator())
      }
    }

    return buildSettingsCard(content: stack, padding: 0)
  }

  private func buildSettingsCard(content: NSView, padding: CGFloat) -> NSView {
    let container = NSView()
    container.translatesAutoresizingMaskIntoConstraints = false
    container.addSubview(content)

    NSLayoutConstraint.activate([
      content.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: padding),
      content.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -padding),
      content.topAnchor.constraint(equalTo: container.topAnchor, constant: padding),
      content.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -padding),
    ])

    return container
  }

  private func buildSeparator() -> NSView {
    let separator = NSBox()
    separator.boxType = .separator
    separator.translatesAutoresizingMaskIntoConstraints = false
    return separator
  }

  private func buildInsetSeparator() -> NSView {
    let line = buildSeparator()
    let container = NSView()
    container.translatesAutoresizingMaskIntoConstraints = false
    container.addSubview(line)

    NSLayoutConstraint.activate([
      line.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 18),
      line.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -18),
      line.topAnchor.constraint(equalTo: container.topAnchor),
      line.bottomAnchor.constraint(equalTo: container.bottomAnchor),
      line.heightAnchor.constraint(equalToConstant: 1),
    ])

    return container
  }

  private func currentValues() -> CustomApiFormValues {
    CustomApiFormValues(
      name: nameField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines),
      baseURL: baseURLField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines),
      apiKey: apiKeyField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines),
      model: modelField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines),
      reasoningEffort: reasoningField.titleOfSelectedItem?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "xhigh"
    )
  }

  private func updateActionButtons() {
    let values = currentValues()
    let hasRequiredFields = !values.name.isEmpty && !values.baseURL.isEmpty && !values.apiKey.isEmpty
    saveButton.isEnabled = hasRequiredFields
    testButton.isEnabled = !values.baseURL.isEmpty && !values.apiKey.isEmpty
  }

  private func trimmedToml(_ text: String) -> String {
    text
      .replacingOccurrences(
        of: "\n{3,}",
        with: "\n\n",
        options: .regularExpression
      )
      .trimmingCharacters(in: .whitespacesAndNewlines)
  }

  private func removeRootKeyLine(_ text: String, key: String) -> String {
    let pattern = "^[\\t ]*\(NSRegularExpression.escapedPattern(for: key))[\\t ]*=.*(?:\\n|$)"
    guard let expression = try? NSRegularExpression(pattern: pattern, options: [.anchorsMatchLines]) else {
      return text
    }
    let range = NSRange(text.startIndex..<text.endIndex, in: text)
    return expression.stringByReplacingMatches(in: text, options: [], range: range, withTemplate: "")
  }

  private func removeTomlSection(_ text: String, sectionName: String) -> String {
    let lines = text.components(separatedBy: "\n")
    var kept: [String] = []
    var skipping = false

    for line in lines {
      let trimmed = line.trimmingCharacters(in: .whitespaces)
      if trimmed.hasPrefix("[") && trimmed.hasSuffix("]") {
        if trimmed == "[\(sectionName)]" {
          skipping = true
          continue
        }

        if skipping {
          skipping = false
        }
      }

      if !skipping {
        kept.append(line)
      }
    }

    return kept.joined(separator: "\n")
  }

  private func tomlQuote(_ value: String) -> String {
    let escaped = value
      .replacingOccurrences(of: "\\", with: "\\\\")
      .replacingOccurrences(of: "\"", with: "\\\"")
    return "\"\(escaped)\""
  }

  private func buildAuthPreview(values: CustomApiFormValues) -> String {
    let payload: [String: String] = [
      "OPENAI_API_KEY": values.apiKey,
    ]

    guard
      let data = try? JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted]),
      let text = String(data: data, encoding: .utf8)
    else {
      return "{\n  \"OPENAI_API_KEY\": \"\"\n}"
    }

    return text
  }

  private func buildMergedConfigPreview(values: CustomApiFormValues) -> String {
    var cleaned = existingConfigContent
    for key in [
      "model_provider",
      "model",
      "suppress_unstable_features_warning",
      "model_reasoning_effort",
    ] {
      cleaned = removeRootKeyLine(cleaned, key: key)
    }
    cleaned = removeTomlSection(cleaned, sectionName: "model_providers.custom")
    cleaned = trimmedToml(cleaned)

    let model = values.model.isEmpty ? "gpt-5.4" : values.model
    let reasoning = values.reasoningEffort.isEmpty ? "xhigh" : values.reasoningEffort
    let baseURL = values.baseURL.isEmpty ? defaultBaseURL : values.baseURL

    let managedKeys = [
      "model_provider = \"custom\"",
      "model = \(tomlQuote(model))",
      "suppress_unstable_features_warning = true",
      "model_reasoning_effort = \(tomlQuote(reasoning))",
    ].joined(separator: "\n")

    let providerSection = [
      "[model_providers.custom]",
      "name = \"custom\"",
      "base_url = \(tomlQuote(baseURL))",
      "wire_api = \"responses\"",
    ].joined(separator: "\n")

    let firstSectionRange = cleaned.range(of: "\n[", options: .literal)
    let rootPart: String
    let sectionPart: String
    if let firstSectionRange {
      rootPart = String(cleaned[..<firstSectionRange.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
      sectionPart = String(cleaned[firstSectionRange.lowerBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
    } else if cleaned.hasPrefix("[") {
      rootPart = ""
      sectionPart = cleaned.trimmingCharacters(in: .whitespacesAndNewlines)
    } else {
      rootPart = cleaned.trimmingCharacters(in: .whitespacesAndNewlines)
      sectionPart = ""
    }

    let hasModelProvidersSection = sectionPart
      .components(separatedBy: "\n")
      .contains { $0.trimmingCharacters(in: .whitespacesAndNewlines) == "[model_providers]" }

    let rootOutput = trimmedToml([rootPart, managedKeys].filter { !$0.isEmpty }.joined(separator: "\n\n"))

    var sectionPieces = [String]()
    if !sectionPart.isEmpty {
      sectionPieces.append(sectionPart)
    }
    if !hasModelProvidersSection {
      sectionPieces.append("[model_providers]")
    }
    sectionPieces.append(providerSection)
    let sectionOutput = trimmedToml(sectionPieces.joined(separator: "\n\n"))

    return "\(trimmedToml([rootOutput, sectionOutput].filter { !$0.isEmpty }.joined(separator: "\n\n")))\n"
  }

  private func updatePreview() {}

  private func describeError(_ error: Error) -> String {
    if let localizedError = error as? LocalizedError,
       let description = localizedError.errorDescription,
       !description.isEmpty {
      return description
    }

    let fallback = (error as NSError).localizedDescription
    return fallback.isEmpty ? "发生了未知错误。" : fallback
  }

  private func close(with response: NSApplication.ModalResponse) {
    closingWithResponse = response
    NSApp.stopModal(withCode: response)
    window.close()
  }

  @objc private func popupSelectionChanged() {
    updateActionButtons()
  }

  private func showMessage(
    title: String,
    message: String,
    style: NSAlert.Style = .informational
  ) {
    let alert = NSAlert()
    alert.alertStyle = style
    alert.messageText = title
    alert.informativeText = message
    alert.addButton(withTitle: "好")
    alert.beginSheetModal(for: window)
  }

  private func showPreview(title: String, content: String) {
    let controller = TextPreviewWindowController(title: title, content: content)
    controller.runModal()
  }

  @objc private func previewAuthFile() {
    showPreview(title: "预览 auth.json", content: buildAuthPreview(values: currentValues()))
  }

  @objc private func previewConfigFile() {
    showPreview(title: "预览 config.toml", content: buildMergedConfigPreview(values: currentValues()))
  }

  @objc private func cancelForm() {
    close(with: .cancel)
  }

  @objc private func saveForm() {
    let values = currentValues()

    guard !values.name.isEmpty else {
      showMessage(title: "无法保存", message: "账号名称不能为空。", style: .warning)
      return
    }

    guard !values.baseURL.isEmpty else {
      showMessage(title: "无法保存", message: "Base URL 不能为空。", style: .warning)
      return
    }

    guard !values.apiKey.isEmpty else {
      showMessage(title: "无法保存", message: "API Key 不能为空。", style: .warning)
      return
    }

    result = values
    close(with: .OK)
  }

  @objc private func testConnection() {
    let values = currentValues()

    guard !values.baseURL.isEmpty else {
      showMessage(title: "无法测试连接", message: "请先填写 Base URL。", style: .warning)
      return
    }

    guard !values.apiKey.isEmpty else {
      showMessage(title: "无法测试连接", message: "请先填写 API Key。", style: .warning)
      return
    }

    testButton.isEnabled = false
    testButton.title = "测试中..."

    testHandler(values) { [weak self] result in
      guard let self else {
        return
      }

      self.updateActionButtons()
      self.testButton.title = "测试连接"

      switch result {
      case .success(let message):
        self.showMessage(title: "测试连接成功", message: message)
      case .failure(let error):
        self.showMessage(
          title: "测试连接失败",
          message: self.describeError(error),
          style: .warning
        )
      }
    }
  }
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
    installMainMenu()
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

  private func installMainMenu() {
    let mainMenu = NSMenu()

    let appMenuItem = NSMenuItem()
    let appMenu = NSMenu()
    let appName = "Codex Switch"

    let aboutItem = NSMenuItem(
      title: "关于 \(appName)",
      action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)),
      keyEquivalent: ""
    )
    aboutItem.target = NSApp
    appMenu.addItem(aboutItem)
    appMenu.addItem(.separator())

    let hideItem = NSMenuItem(
      title: "隐藏 \(appName)",
      action: #selector(NSApplication.hide(_:)),
      keyEquivalent: "h"
    )
    hideItem.target = NSApp
    appMenu.addItem(hideItem)

    let hideOthersItem = NSMenuItem(
      title: "隐藏其他",
      action: #selector(NSApplication.hideOtherApplications(_:)),
      keyEquivalent: "h"
    )
    hideOthersItem.keyEquivalentModifierMask = [.command, .option]
    hideOthersItem.target = NSApp
    appMenu.addItem(hideOthersItem)

    let showAllItem = NSMenuItem(
      title: "显示全部",
      action: #selector(NSApplication.unhideAllApplications(_:)),
      keyEquivalent: ""
    )
    showAllItem.target = NSApp
    appMenu.addItem(showAllItem)
    appMenu.addItem(.separator())

    let quitItem = NSMenuItem(
      title: "退出 \(appName)",
      action: #selector(NSApplication.terminate(_:)),
      keyEquivalent: "q"
    )
    quitItem.target = NSApp
    appMenu.addItem(quitItem)

    appMenuItem.submenu = appMenu
    mainMenu.addItem(appMenuItem)

    let editMenuItem = NSMenuItem()
    let editMenu = NSMenu(title: "Edit")
    editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")

    let redoItem = NSMenuItem(title: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
    redoItem.keyEquivalentModifierMask = [.command, .shift]
    editMenu.addItem(redoItem)
    editMenu.addItem(.separator())

    editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")

    editMenuItem.submenu = editMenu
    mainMenu.addItem(editMenuItem)

    NSApp.mainMenu = mainMenu
  }

  private func setupStatusItem() {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    self.statusItem = item

    if let button = item.button {
      button.toolTip = "codex-switch"
      button.alphaValue = 1.0
      button.appearsDisabled = false
      button.contentTintColor = nil

      if let icon = loadStatusIcon() {
        button.image = icon
        button.image?.isTemplate = false
        button.imagePosition = .imageOnly
        button.imageScaling = .scaleProportionallyDown
      } else {
        button.title = "cxs"
      }
    }
  }

  private func statusIconColor() -> NSColor {
    NSColor(
      calibratedRed: 0x32 as CGFloat / 255,
      green: 0x2b as CGFloat / 255,
      blue: 0xf5 as CGFloat / 255,
      alpha: 1
    )
  }

  private func loadStatusIcon() -> NSImage? {
    guard let resourceURL = Bundle.main.resourceURL else {
      return nil
    }

    let iconURL = resourceURL.appendingPathComponent(GeneratedConfig.statusIconName)
    guard let image = NSImage(contentsOf: iconURL) else {
      return nil
    }

    let targetSize = NSSize(width: 16, height: 16)
    let rect = NSRect(origin: .zero, size: targetSize)
    let tintedImage = NSImage(size: targetSize)

    tintedImage.lockFocus()
    NSGraphicsContext.current?.imageInterpolation = .high
    image.draw(
      in: rect,
      from: NSRect(origin: .zero, size: image.size),
      operation: .sourceOver,
      fraction: 1.0
    )
    statusIconColor().set()
    rect.fill(using: .sourceAtop)
    tintedImage.unlockFocus()
    tintedImage.isTemplate = false

    return tintedImage
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
    let syncSessionsItem = NSMenuItem(
      title: "同步会话到当前 Model Provider",
      action: #selector(syncSessionsMenu),
      keyEquivalent: ""
    )
    syncSessionsItem.target = self
    menu.addItem(syncSessionsItem)

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

    let customItem = NSMenuItem(title: "添加自定义 API Key", action: #selector(addCustomApiAccount), keyEquivalent: "")
    customItem.target = self
    submenu.addItem(customItem)

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
        DispatchQueue.main.async { self.showError(self.describeError(error)) }
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

  private func describeError(_ error: Error) -> String {
    if let localizedError = error as? LocalizedError,
       let description = localizedError.errorDescription,
       !description.isEmpty {
      return description
    }

    let fallback = (error as NSError).localizedDescription
    return fallback.isEmpty ? "发生了未知错误。" : fallback
  }

  private func promptForCustomApiAccount() -> CustomApiFormValues? {
    let defaultBaseURL = "http://123.56.169.10:48760/v1"
    let configPath =
      state?.runtime.configPath ??
      FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".codex/config.toml")
        .path
    let existingConfigContent =
      (try? String(contentsOfFile: configPath, encoding: .utf8)) ?? ""

    let controller = CustomApiAccountFormWindowController(
      defaultBaseURL: defaultBaseURL,
      existingConfigContent: existingConfigContent
    ) { [weak self] values, completion in
      guard let self else {
        completion(.failure(CLIError.commandFailed("窗口已关闭。")))
        return
      }

      DispatchQueue.global(qos: .userInitiated).async {
        do {
          let output = try self.runCLI(arguments: [
            "test-custom-api",
            "--base-url", values.baseURL,
            "--api-key", values.apiKey,
          ])

          guard let data = output.data(using: .utf8) else {
            throw CLIError.invalidOutput("测试连接返回了非 UTF-8 数据。")
          }

          let payload = try JSONSerialization.jsonObject(with: data) as? [String: Any]
          let ok = payload?["ok"] as? Bool ?? false
          let message =
            payload?["message"] as? String ??
            output.trimmingCharacters(in: .whitespacesAndNewlines)

          DispatchQueue.main.async {
            if ok {
              completion(.success(message))
            } else {
              completion(.failure(CLIError.commandFailed(message)))
            }
          }
        } catch {
          DispatchQueue.main.async {
            completion(.failure(error))
          }
        }
      }
    }

    return controller.runModal()
  }

  @objc private func saveCurrentAccount() {
    runAsync {
      _ = try self.runCLI(arguments: ["save-current-auto"])
    }
  }

  @objc private func refreshUsageMenu() {
    refreshUsageInBackground()
  }

  private func sessionSyncSummaryMessage(from output: String) -> String {
    guard let data = output.data(using: .utf8) else {
      return "会话同步已完成。"
    }

    guard
      let jsonObject = try? JSONSerialization.jsonObject(with: data),
      let payload = jsonObject as? [String: Any]
    else {
      return "会话同步已完成。"
    }

    if let errorMessage = payload["error"] as? String, !errorMessage.isEmpty {
      return "会话同步失败：\(errorMessage)"
    }

    let targetProvider = (payload["targetProvider"] as? String) ?? "当前 provider"
    let changed = (payload["changed"] as? Bool) ?? false
    let databases = (payload["databases"] as? [[String: Any]]) ?? []
    let updatedThreads = databases.reduce(0) { partial, database in
      partial + ((database["updatedThreads"] as? Int) ?? 0)
    }

    if changed {
      return "会话同步完成，已同步 \(updatedThreads) 条会话到 \(targetProvider)。"
    }

    return "会话已是最新，无需同步（\(targetProvider)）。"
  }

  @objc private func syncSessionsMenu() {
    DispatchQueue.global(qos: .userInitiated).async {
      do {
        let output = try self.runCLI(arguments: ["sync-sessions"])
        let message = self.sessionSyncSummaryMessage(from: output)
        DispatchQueue.main.async {
          self.refreshMenu()
          self.showInfo(message)
        }
      } catch {
        DispatchQueue.main.async {
          self.showError(self.describeError(error))
        }
      }
    }
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

  @objc private func addCustomApiAccount() {
    guard let values = promptForCustomApiAccount() else {
      return
    }

    guard !values.name.isEmpty else {
      showError("账号名称不能为空。")
      return
    }

    guard !values.baseURL.isEmpty else {
      showError("Base URL 不能为空。")
      return
    }

    guard !values.apiKey.isEmpty else {
      showError("API Key 不能为空。")
      return
    }

    let model = values.model.isEmpty ? "gpt-5.4" : values.model
    let reasoning = values.reasoningEffort.isEmpty ? "xhigh" : values.reasoningEffort

    runAsync(successMessage: "已保存自定义 API 账号。") {
      _ = try self.runCLI(arguments: [
        "add-custom-api",
        "--name", values.name,
        "--base-url", values.baseURL,
        "--api-key", values.apiKey,
        "--model", model,
        "--reasoning-effort", reasoning,
      ])
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
