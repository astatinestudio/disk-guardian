#!/usr/bin/env bash
# Removes Disk Guardian (app, collector service, GNOME Shell extension).
#   ./uninstall.sh            keep temperature / usage history and settings
#   ./uninstall.sh --purge    also delete history, config and extension settings
set -euo pipefail

gnome-extensions disable disk-guardian@diskguardian 2>/dev/null || true
gnome-extensions disable disk-health@linuxhealth 2>/dev/null || true
if [[ "${1:-}" == "--purge" ]]; then
    sudo apt-get purge -y disk-guardian disk-health linuxhealth 2>/dev/null || true
    dconf reset -f /org/gnome/shell/extensions/diskguardian/ 2>/dev/null || true
    echo "History, config and settings removed."
else
    sudo apt-get remove -y disk-guardian disk-health linuxhealth 2>/dev/null || true
fi

# leftovers of the very old manual installation (Python collector under /usr/local)
if [[ -f /etc/systemd/system/linuxhealth-collector.service ]]; then
    sudo systemctl disable --now linuxhealth-collector.service 2>/dev/null || true
    sudo rm -f /etc/systemd/system/linuxhealth-collector.service /usr/local/sbin/linuxhealth-collector
    sudo rm -rf /usr/local/lib/linuxhealth /usr/local/share/doc/linuxhealth
    sudo systemctl daemon-reload
fi
rm -rf "$HOME/.local/share/gnome-shell/extensions/disk-guardian@diskguardian" "$HOME/.local/share/fonts/diskguardian"
# previous name (Disk Health)
rm -rf "$HOME/.local/share/gnome-shell/extensions/disk-health@linuxhealth" "$HOME/.local/share/fonts/linuxhealth"

echo "Disk Guardian removed. Log out and in to unload the extension completely."
