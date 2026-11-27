# Development

## How it works

```
┌────────────────────────────┐   state.json (raw smartctl JSON)   ┌────────────────────────────┐
│ disk-guardian --service    │ ─────────────────────────────────▶ │ desktop app (Tauri)        │
│ Windows service / launchd /│                                    │ GNOME Shell extension      │
│ systemd, as admin / root   │ ◀───────────────────────────────── │ normalize.js: SMART        │
│ smartctl, hwmon, lsblk     │   requests/ (refresh, self-test)   │ analysis and health score  │
└────────────────────────────┘                                    └────────────────────────────┘
```

Reading SMART data needs administrator rights, but the app itself should not run with them.
A small collector service (the same `disk-guardian` binary started with `--service`) gathers the raw data:
- `smartctl -j -x` and temperatures on every system.
- `lsblk`, hwmon and btrfs on Linux.

It writes everything to one JSON file:

| System | State file |
|---|---|
| Windows | `%ProgramData%\DiskGuardian\state.json` |
| macOS | `/Library/Application Support/DiskGuardian/state.json` |
| Linux | `/run/diskguardian/state.json` (history in `/var/lib/diskguardian/`) |

All SMART parsing and health scoring live in `extension/lib/normalize.js`. The desktop app and the
GNOME extension both use it. On Linux, refresh and self-test requests are accepted only from members
of the `sudo` group.

## Build from source

Requirements: [Node.js](https://nodejs.org) 20+, [Rust](https://rustup.rs) and the
[Tauri prerequisites](https://tauri.app/start/prerequisites/) for your system.

```bash
cd desktop
npm install
npm run dev      # run the app in development mode
npm test         # SMART analysis tests (normalize.js against real smartctl samples)
npm run build    # installer for the current system
node scripts/check-locales.mjs   # every translation has every string
```

On Debian / Ubuntu, `desktop/scripts/build-deb.sh` installs the build dependencies, builds the `.deb`
and installs it. Other Linux formats: `npx tauri build --bundles deb,rpm,appimage`.

Command-line options of the binary:

```text
disk-guardian                      the app (tray icon, window, floating widget)
disk-guardian --minimized          start in the tray
disk-guardian --service            collector service (as admin / root)
disk-guardian --install-service    register + start the collector service (admin / root)
disk-guardian --uninstall-service  remove it
disk-guardian --once               read every disk once and print the raw JSON (admin / root)
disk-guardian --check-update       print what updates.json offers this installation
disk-guardian --download-update    download + verify that update (no install)
```

## Collector settings (Linux)

`/etc/diskguardian/collector.conf`, applied with `sudo systemctl restart disk-guardian`:

| Key | Default | Meaning |
|---|---|---|
| `smart_interval` | 300 | Seconds between full SMART scans |
| `temp_interval` | 3 | Seconds between SSD / NVMe temperature reads |
| `hdd_temp_interval` | 60 | Seconds between HDD temperature reads (sleeping disks are not woken) |
| `hdd_use_hwmon` | false | Read HDD temperature through `drivetemp` every `temp_interval` (some drives then never spin down) |
| `wake_for_first_scan` | true | Wake a sleeping disk once if it has never been read |
| `request_group` | sudo | Group allowed to request a refresh or a self-test |
| `ignore_devices` | | Block devices to hide, e.g. `sdc sdd` |

## Builds

GitHub Actions (`.github/workflows/desktop.yml`) builds every target on each push to `main`:

| Target | Runner | Output |
|---|---|---|
| Windows x64 / x86 / ARM64 | `windows-latest` (ARM64 cross-compiled) | NSIS installer, portable zip |
| macOS Apple silicon | `macos-latest` | `.dmg`, `.app.tar.gz` |
| macOS Intel | `macos-15-intel` | `.dmg`, `.app.tar.gz` |
| Linux x64 | `ubuntu-22.04` | `.deb`, `.rpm`, `.AppImage` |
| Linux ARM64 | `ubuntu-22.04-arm` | `.deb`, `.rpm`, `.AppImage` |

Linux builds use Ubuntu 22.04 so the binaries run on every distribution with glibc 2.35 or newer.
`smartctl` is bundled on Windows (the 32-bit build for x86 and ARM64, which Windows on ARM emulates) and
macOS. The Linux packages depend on `smartmontools`; the AppImage uses the system's `smartctl`.

## Releasing an update

The app reads [`updates.json`](../updates.json) from this repository. Its layout:
- `releases`: the download location and checksum files of each version.
- `platforms`: the current version per system, with a `mandatory` flag.
- `announcements`: optional in-app messages.

Each GitHub release contains `SHA256SUMS.txt` and `SHA256SUMS.txt.sig`, an Ed25519 signature of that
file. The app installs only files whose hash appears in a correctly signed list.

**One-time setup:**
1. `node desktop/scripts/release.mjs keygen` creates the signing key in `~/.disk-guardian/update-signing-key.pem` and writes the public key into `src-tauri/src/updater.rs`. Keep a backup of the key: without it, installed copies cannot be updated.
2. Store the whole PEM file as the repository secret `UPDATE_SIGNING_KEY` (Settings → Secrets and variables → Actions, or `gh secret set UPDATE_SIGNING_KEY < ~/.disk-guardian/update-signing-key.pem`).

**Every release:**
1. Raise the version in `desktop/src-tauri/tauri.conf.json` **and** `desktop/src-tauri/Cargo.toml`, and the date in `extension/lib/about.js`.
2. Add `release-notes/v<version>.json` with one note per app language (`en`, `fa`, `ar`, … all 19 codes of `extension/lib/i18n.js`; the app falls back to English) and `"mandatory": false`.
3. Commit, then tag and push: `git tag v<version> && git push origin main --tags`.

The workflow builds every target. Its `release` job then:
- checks that the tag matches both version numbers,
- signs `SHA256SUMS.txt`,
- publishes the GitHub release with stable file names,
- commits the new `updates.json` to `main`.

Installed apps see the update only after that last step, so they never learn about files that aren't online yet.

To pack a release by hand instead (for example from downloaded artifacts):
`node desktop/scripts/release.mjs pack <folder> --notes-file release-notes/v<version>.json`.

## Project layout

```
desktop/                        the app and collector for Windows, macOS and Linux (Tauri 2, Rust)
  src-tauri/src/collector.rs    collector service: smartctl, temperatures, history, requests
  src-tauri/src/linux.rs        Linux details: lsblk and partitions, hwmon, btrfs, collector.conf
  src-tauri/src/service.rs      installing / running the service (Windows service, launchd, systemd)
  src-tauri/src/updater.rs      automatic updates (updates.json, signature check, installers)
  src-tauri/src/app.rs          windows, tray, settings
  src-tauri/linux/              systemd unit, collector.conf, .deb scripts, dg-top
  ui/                           user interface (HTML / CSS / JS)
  scripts/                      build helpers, release.mjs, check-locales.mjs, build-deb.sh
  tests/                        SMART analysis tests
extension/                      GNOME Shell extension
  lib/normalize.js              SMART analysis and health score (shared with the desktop app)
  lib/i18n.js, lib/locales/     translations (19 languages, shared with the desktop app)
  lib/about.js                  name, author and dates shown in About
docs/                           README translations, images, this file
install.sh                      one-line installer / updater (Linux: deb, rpm, AppImage; macOS)
release-notes/                  optional notes per release (read by the release workflow)
updates.json                    update manifest read by the app
```
