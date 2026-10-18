#!/bin/bash
# Build "biscotti Installer.app" with the command-line tools (no Xcode project).
set -euo pipefail
cd "$(dirname "$0")"
VERSION=$(plutil -extract version raw ../../package.json)
swift build -c release
APP="build/biscotti Installer.app"
rm -rf "$APP" && mkdir -p "$APP/Contents/MacOS"
cp .build/release/BiscottiInstaller "$APP/Contents/MacOS/"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>biscotti Installer</string>
  <key>CFBundleIdentifier</key><string>dev.biscotti.installer</string>
  <key>CFBundleExecutable</key><string>BiscottiInstaller</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSContactsUsageDescription</key><string>To fill in your phone number and email from your contact card.</string>
</dict></plist>
PLIST
codesign --force --sign - --options runtime --entitlements entitlements.plist "$APP"
echo "$APP"
