#!/usr/bin/env bash
# Disk Guardian: install or update to the latest release.
#   Linux: .deb (apt), .rpm (dnf / zypper), otherwise the AppImage · macOS: .dmg
#
#   curl -fsSL https://raw.githubusercontent.com/astatinestudio/disk-guardian/main/install.sh | bash
#
# The download is checked against SHA256SUMS.txt of the same release.
# Windows: use the installer from the releases page.
# Build from source instead: desktop/scripts/build-deb.sh
set -euo pipefail

REPO="astatinestudio/disk-guardian"
BASE="https://github.com/$REPO/releases/latest/download"

bold() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31mError:\033[0m %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "'$1' is required."; }
SUDO=""
[ "$(id -u)" -eq 0 ] || SUDO="sudo"

need curl
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fetch() { # file
    bold "Downloading $1"
    curl -fL --progress-bar -o "$TMP/$1" "$BASE/$1" || die "download failed: $BASE/$1"
    curl -fsSL -o "$TMP/SHA256SUMS.txt" "$BASE/SHA256SUMS.txt" || die "download failed: SHA256SUMS.txt"
    local want got
    want="$(awk -v f="$1" '$2 == f || $2 == "*" f { print $1 }' "$TMP/SHA256SUMS.txt")"
    [ -n "$want" ] || die "$1 is not listed in SHA256SUMS.txt"
    if command -v sha256sum >/dev/null 2>&1; then
        got="$(sha256sum "$TMP/$1" | awk '{print $1}')"
    else
        got="$(shasum -a 256 "$TMP/$1" | awk '{print $1}')"
    fi
    [ "$want" = "$got" ] || die "checksum mismatch for $1 (damaged download?)"
    echo "Checksum OK."
}

case "$(uname -s)" in
Linux)
    case "$(uname -m)" in
        x86_64 | amd64) DEB_ARCH=amd64; RPM_ARCH=x86_64 ;;
        aarch64 | arm64) DEB_ARCH=arm64; RPM_ARCH=aarch64 ;;
        *) die "no Linux build for $(uname -m) yet." ;;
    esac
    if command -v apt-get >/dev/null 2>&1; then
        # Debian, Ubuntu, Linux Mint, Pop!_OS, elementary ...
        FILE="Disk-Guardian-Linux-$DEB_ARCH.deb"
        fetch "$FILE"
        bold "Installing (administrator password)"
        chmod 644 "$TMP/$FILE"
        $SUDO apt-get install -y "$TMP/$FILE"
    elif command -v dnf >/dev/null 2>&1 || command -v zypper >/dev/null 2>&1; then
        # Fedora, RHEL, Rocky, AlmaLinux, openSUSE ...
        FILE="Disk-Guardian-Linux-$RPM_ARCH.rpm"
        fetch "$FILE"
        bold "Installing (administrator password)"
        chmod 644 "$TMP/$FILE"
        if command -v dnf >/dev/null 2>&1; then
            $SUDO dnf install -y "$TMP/$FILE"
        else
            $SUDO zypper --non-interactive install --allow-unsigned-rpm "$TMP/$FILE"
        fi
    else
        # any other distribution (Arch, Manjaro, Void, ...): the portable AppImage
        FILE="Disk-Guardian-Linux-$RPM_ARCH.AppImage"
        fetch "$FILE"
        DEST="$HOME/Applications/Disk-Guardian.AppImage"
        mkdir -p "$HOME/Applications"
        install -m 755 "$TMP/$FILE" "$DEST"
        if ! command -v smartctl >/dev/null 2>&1 && [ ! -x /usr/sbin/smartctl ]; then
            printf '\n\033[33mNote:\033[0m install smartmontools with your package manager (e.g. sudo pacman -S smartmontools).\n'
        fi
        cat <<MSG

Disk Guardian is in $DEST
  * Start it, then press "Install service" once (it reads the disks in the background).
  * Run this command again to update.
MSG
        exit 0
    fi
    cat <<'MSG'

Disk Guardian is installed.
  * Open "Disk Guardian" from the applications menu.
  * GNOME: log out and back in once to show disk temperatures in the top panel.
  * Live disk activity in the terminal: sudo dg-top
MSG
    ;;
Darwin)
    case "$(uname -m)" in
        arm64) FILE="Disk-Guardian-macOS-aarch64.dmg" ;;
        *) FILE="Disk-Guardian-macOS-x64.dmg" ;;
    esac
    fetch "$FILE"
    bold "Installing to /Applications (administrator password)"
    MNT="$TMP/mnt"
    mkdir -p "$MNT"
    hdiutil attach -nobrowse -quiet -mountpoint "$MNT" "$TMP/$FILE"
    APP="$(find "$MNT" -maxdepth 1 -name '*.app' | head -n 1)"
    [ -n "$APP" ] || { hdiutil detach -quiet "$MNT"; die "no app found in $FILE"; }
    osascript -e 'tell application "Disk Guardian" to quit' >/dev/null 2>&1 || true
    sudo rm -rf "/Applications/Disk Guardian.app"
    sudo cp -R "$APP" "/Applications/Disk Guardian.app"
    hdiutil detach -quiet "$MNT"
    sudo xattr -dr com.apple.quarantine "/Applications/Disk Guardian.app" 2>/dev/null || true
    # an update: restart the collector so it runs the new version
    sudo launchctl kickstart -k system/io.github.diskguardian.collector >/dev/null 2>&1 || true
    open "/Applications/Disk Guardian.app"
    cat <<'MSG'

Disk Guardian is installed in /Applications.
  * On first start press "Install service" once (it reads the disks in the background).
MSG
    ;;
*)
    die "unsupported system $(uname -s). Windows: download the installer from https://github.com/$REPO/releases"
    ;;
esac
