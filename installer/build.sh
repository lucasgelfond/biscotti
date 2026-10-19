#!/bin/bash
# Build "biscotti Installer.app" with the command-line tools (no Xcode project).
set -euo pipefail
cd "$(dirname "$0")"
VERSION=$(plutil -extract version raw ../package.json)
swift build -c release
# The release's image hashes, built into the (notarized) app: a changed file on the download server can't pass. Empty
# for a build before the images are uploaded; that app trusts the server's .sha256 files.
DL="https://dl.biscotti.lucasgelfond.online/v$VERSION"
published_sha() { curl -fsS "$DL/$1.sha256" 2>/dev/null | cut -d' ' -f1 || true; }
PI_SHA=$(published_sha "biscotti-pi5-v$VERSION.img.zst")
MAC_SHA=$(published_sha "biscotti-mac-v$VERSION.qcow2.zst")
echo "image hashes: pi ${PI_SHA:-none}, mac ${MAC_SHA:-none}"
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
  <key>BiscottiPiSHA256</key><string>$PI_SHA</string>
  <key>BiscottiMacSHA256</key><string>$MAC_SHA</string>
  <key>NSContactsUsageDescription</key><string>To fill in your phone number and email from your contact card.</string>
</dict></plist>
PLIST
# Ad hoc unless SIGN_ID names a Developer ID; with NOTARY_PROFILE (xcrun notarytool store-credentials), notarized too.
codesign --force --sign "${SIGN_ID:--}" --timestamp --options runtime --entitlements entitlements.plist "$APP"
ZIP="build/biscotti-installer-v$VERSION.zip"
ditto -c -k --keepParent "$APP" "$ZIP"
if [ -n "${NOTARY_PROFILE:-}" ]; then
  xcrun notarytool submit "$ZIP" --keychain-profile "$NOTARY_PROFILE" --wait
  xcrun stapler staple "$APP"
  ditto -c -k --keepParent "$APP" "$ZIP"
fi
echo "$ZIP"
