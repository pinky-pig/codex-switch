#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_OUTPUT_DIR="$ROOT_DIR/dist/macos"
APP_PATH="$APP_OUTPUT_DIR/Codex Switch.app"
MACOS_DIR="$APP_PATH/Contents/MacOS"
RESOURCES_DIR="$APP_PATH/Contents/Resources"
PLIST_PATH="$APP_PATH/Contents/Info.plist"
PKGINFO_PATH="$APP_PATH/Contents/PkgInfo"
SWIFT_SOURCE="$ROOT_DIR/macos/menubar-swift/main.swift"
GENERATED_SWIFT="$APP_OUTPUT_DIR/GeneratedConfig.swift"
BIN_NAME="CodexSwitchMenubar"
RUNTIME_BIN_DIR="$HOME/.codex-switch/bin"
RUNTIME_PATH="$RUNTIME_BIN_DIR/codex-switch-runtime.mjs"
NODE_BIN_PATH="$(command -v node)"
ICON_PATH="$ROOT_DIR/assets/icons/cxs.icns"
STATUS_ICON_PATH="$ROOT_DIR/assets/icons/cxs-menubar-template-hires.png"

cd "$ROOT_DIR"

npm run build
mkdir -p "$APP_OUTPUT_DIR" "$RUNTIME_BIN_DIR"
rm -rf "$APP_PATH"
mkdir -p "$MACOS_DIR" "$RESOURCES_DIR"

cp "$ROOT_DIR/dist/app-runtime.js" "$RUNTIME_PATH"
chmod 755 "$RUNTIME_PATH"

python3 - <<'PY' "$SWIFT_SOURCE" "$GENERATED_SWIFT" "$NODE_BIN_PATH" "$RUNTIME_PATH"
from pathlib import Path
import sys

source = Path(sys.argv[1]).read_text()
node_path = sys.argv[3].replace("\\", "\\\\").replace('"', '\\"')
runtime_path = sys.argv[4].replace("\\", "\\\\").replace('"', '\\"')
compiled = source.replace("__NODE_BIN__", node_path).replace("__RUNTIME_PATH__", runtime_path)
Path(sys.argv[2]).write_text(compiled)
PY

swiftc \
  -framework AppKit \
  -framework Foundation \
  "$GENERATED_SWIFT" \
  -o "$MACOS_DIR/$BIN_NAME"

cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleExecutable</key>
  <string>$BIN_NAME</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>CFBundleIdentifier</key>
  <string>local.codex-switch.menubar</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>Codex Switch</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSPrincipalClass</key>
  <string>NSApplication</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
PLIST

printf 'APPL????' > "$PKGINFO_PATH"

if [ -f "$ICON_PATH" ]; then
  cp "$ICON_PATH" "$RESOURCES_DIR/AppIcon.icns"
fi

if [ -f "$STATUS_ICON_PATH" ]; then
  cp "$STATUS_ICON_PATH" "$RESOURCES_DIR/cxs-menubar-template-hires.png"
fi

write_app_shim() {
  local target="$1"
  mkdir -p "$(dirname "$target")"
  rm -f "$target"
  cat > "$target" <<SH
#!/bin/sh
open '$APP_PATH'
SH
  chmod 755 "$target"
}

nvm_dirs=()
if [ -d "$HOME/.nvm/versions/node" ]; then
  while IFS= read -r dir; do
    nvm_dirs+=("$dir")
  done < <(find "$HOME/.nvm/versions/node" -maxdepth 2 -type d -name bin 2>/dev/null | sort)
fi

candidate_dirs=(/opt/homebrew/bin /usr/local/bin "$HOME/.local/bin" "$HOME/bin" "${nvm_dirs[@]}")

for candidate_dir in "${candidate_dirs[@]}"; do
  if mkdir -p "$candidate_dir" 2>/dev/null && [ -w "$candidate_dir" ]; then
    write_app_shim "$candidate_dir/codex-switch"
    write_app_shim "$candidate_dir/cxs"
  fi
done

codesign --force --deep --sign - "$APP_PATH" >/dev/null 2>&1 || true
rm -f "$GENERATED_SWIFT"

echo "Built menu bar app:"
echo "  $APP_PATH"
