#!/usr/bin/env bash
# Disk Guardian from source on Debian / Ubuntu: builds the disk-guardian .deb (Rust app +
# collector service + GNOME Shell extension) and installs it.
# Run as your normal user:  desktop/scripts/build-deb.sh [--rebuild]
# (The released package installs with the one-line installer, see README.md.)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
bold() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

if [[ $EUID -eq 0 ]]; then
    echo "Please run as your normal desktop user (the script calls sudo when needed)."
    exit 1
fi

DEB=$(ls -t "$HERE"/dist/disk-guardian_*.deb 2>/dev/null | head -1 || true)
if [[ -z "$DEB" || "${1:-}" == "--rebuild" ]]; then
    bold "Installing build dependencies"
    sudo apt-get install -y --no-install-recommends build-essential curl pkg-config libssl-dev \
        libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev nodejs npm
    if ! command -v cargo >/dev/null; then
        bold "Installing Rust (rustup)"
        curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
        # shellcheck disable=SC1091
        source "$HOME/.cargo/env"
    fi
    bold "Building the package (a few minutes the first time)"
    (cd "$HERE/desktop" && npm ci && npx tauri build --bundles deb)
    mkdir -p "$HERE/dist"
    SRC=$(ls -t "$HERE"/desktop/src-tauri/target/release/bundle/deb/*.deb | head -1)
    VER=$(basename "$SRC" | sed -E 's/^Disk Guardian_([^_]+)_([^.]+)\.deb$/\1_\2/')
    DEB="$HERE/dist/disk-guardian_${VER}.deb"
    cp "$SRC" "$DEB"
fi

bold "Installing $(basename "$DEB")"
sudo apt-get install -y "$DEB"

cat <<MSG

Done. Open "Disk Guardian" from the applications menu.
Log out and back in once to show disk temperatures in the GNOME top panel
(then enable it in the Extensions app if needed).
MSG
