#!/bin/bash
# Install the pinned fingerprint-chromium build used by shared-browser.sh.
set -euo pipefail

VERSION=148.0.7778.215
SHA256=b72f091e2e1a7583eed389c4b8e3534ed355e568af8c8bbf8fc30a25e23ca679
DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="$DIR/fingerprint-chromium"
APP="$INSTALL_DIR/Chromium.app"
URL="https://github.com/adryfish/fingerprint-chromium/releases/download/$VERSION/ungoogled-chromium_${VERSION}-1.1_macos.dmg"

[ "$(uname -m)" = arm64 ] || { echo "ERROR: the pinned fingerprint-chromium build requires Apple silicon" >&2; exit 1; }
if [ -x "$APP/Contents/MacOS/Chromium" ]; then
  [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")" = "$VERSION" ] || { echo "ERROR: $APP contains the wrong Chromium version" >&2; exit 1; }
  codesign --verify --deep --strict "$APP"
  echo "fingerprint-chromium $VERSION already installed"
  exit 0
fi
[ ! -e "$APP" ] || { echo "ERROR: incomplete browser bundle at $APP; delete it before reinstalling" >&2; exit 1; }

TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/fingerprint-chromium.XXXXXX")"
DMG="$TEMP_DIR/fingerprint-chromium.dmg"
MOUNT="$TEMP_DIR/mount"
mkdir "$MOUNT"

curl -L --fail --show-error --retry 5 --retry-all-errors "$URL" -o "$DMG"
ACTUAL_SHA256="$(/usr/bin/openssl dgst -sha256 "$DMG" | awk '{print $NF}')"
[ "$ACTUAL_SHA256" = "$SHA256" ] || { echo "ERROR: fingerprint-chromium download checksum mismatch" >&2; exit 1; }

hdiutil attach -nobrowse -readonly -mountpoint "$MOUNT" "$DMG"
mkdir -p "$INSTALL_DIR"
ditto "$MOUNT/Chromium.app" "$APP"
hdiutil detach "$MOUNT"
xattr -cr "$APP"
codesign --verify --deep --strict "$APP"
[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")" = "$VERSION" ] || { echo "ERROR: installed Chromium version does not match $VERSION" >&2; exit 1; }
rm -rf "$TEMP_DIR"

echo "fingerprint-chromium $VERSION installed at $APP"
