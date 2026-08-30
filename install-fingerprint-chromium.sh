#!/bin/bash
# Install the pinned fingerprint-chromium build used by the Chromium daemon.
set -euo pipefail

VERSION=148.0.7778.215
DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="$DIR/fingerprint-chromium"

install_linux_apparmor_profile() {
  [ -r /proc/sys/kernel/apparmor_restrict_unprivileged_userns ] || return 0
  [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns)" = 1 ] || return 0

  local path=/etc/apparmor.d/browser-swarm-chromium
  local profile
  profile="$(cat <<EOF
abi <abi/5.0>,
include <tunables/global>
profile browser-swarm-chromium $INSTALL_DIR/chrome flags=(unconfined) {
  userns,
}
EOF
)"
  if [ -f "$path" ] && printf '%s\n' "$profile" | cmp -s - "$path"; then
    return
  fi
  if ! sudo -n true; then
    echo "ERROR: BrowserSwarm needs sudo once to install its Chromium AppArmor profile. Run:" >&2
    printf '%s\n' \
      "sudo tee /etc/apparmor.d/browser-swarm-chromium >/dev/null <<'EOF'" \
      "$profile" \
      "EOF" \
      "sudo apparmor_parser -r /etc/apparmor.d/browser-swarm-chromium" >&2
    exit 1
  fi
  printf '%s\n' "$profile" | sudo tee "$path" >/dev/null
  sudo apparmor_parser -r "$path"
}

case "$(uname -sm)" in
  "Darwin arm64")
    URL="https://github.com/adryfish/fingerprint-chromium/releases/download/$VERSION/ungoogled-chromium_${VERSION}-1.1_macos.dmg"
    SHA256=b72f091e2e1a7583eed389c4b8e3534ed355e568af8c8bbf8fc30a25e23ca679
    BINARY="$INSTALL_DIR/Chromium.app/Contents/MacOS/Chromium"
    ;;
  "Linux x86_64")
    URL="https://github.com/adryfish/fingerprint-chromium/releases/download/$VERSION/ungoogled-chromium-${VERSION}-1-x86_64_linux.tar.xz"
    SHA256=70d239830332e5820aa34dfcb284161cac0429eee25da642830afe04bda717f4
    BINARY="$INSTALL_DIR/chrome"
    install_linux_apparmor_profile
    ;;
  *)
    echo "ERROR: fingerprint-chromium supports Darwin arm64 and Linux x86_64" >&2
    exit 1
    ;;
esac

if [ -x "$BINARY" ]; then
  "$BINARY" --version | grep -qF "$VERSION" || { echo "ERROR: $INSTALL_DIR contains the wrong Chromium version" >&2; exit 1; }
  if [ "$(uname -s)" = Darwin ]; then
    codesign --verify --deep --strict "$INSTALL_DIR/Chromium.app"
  fi
  echo "fingerprint-chromium $VERSION already installed"
  exit 0
fi
[ ! -e "$INSTALL_DIR" ] || { echo "ERROR: incomplete browser install at $INSTALL_DIR; delete it before reinstalling" >&2; exit 1; }

TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/fingerprint-chromium.XXXXXX")"
ARCHIVE="$TEMP_DIR/download"
curl -L --fail --show-error --retry 5 --retry-all-errors "$URL" -o "$ARCHIVE"
ACTUAL_SHA256="$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')"
[ "$ACTUAL_SHA256" = "$SHA256" ] || { echo "ERROR: fingerprint-chromium download checksum mismatch" >&2; exit 1; }

if [ "$(uname -s)" = Darwin ]; then
  MOUNT="$TEMP_DIR/mount"
  mkdir "$MOUNT"
  hdiutil attach -nobrowse -readonly -mountpoint "$MOUNT" "$ARCHIVE"
  mkdir -p "$INSTALL_DIR"
  ditto "$MOUNT/Chromium.app" "$INSTALL_DIR/Chromium.app"
  hdiutil detach "$MOUNT"
  xattr -cr "$INSTALL_DIR/Chromium.app"
  codesign --verify --deep --strict "$INSTALL_DIR/Chromium.app"
else
  tar -xJf "$ARCHIVE" -C "$TEMP_DIR"
  mv "$TEMP_DIR"/ungoogled-chromium-* "$INSTALL_DIR"
fi

"$BINARY" --version | grep -qF "$VERSION" || { echo "ERROR: installed Chromium version does not match $VERSION" >&2; exit 1; }
find "$TEMP_DIR" -depth -delete

echo "fingerprint-chromium $VERSION installed at $BINARY"
