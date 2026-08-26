#!/bin/bash

set -euo pipefail

if [[ "${1:-}" != "--confirm" || $# -ne 1 || "$(/usr/bin/uname -s)" != "Darwin" ]]; then
    echo "用法: $0 --confirm" >&2
    exit 2
fi

label="com.tigerowo.infinite-canvas.cli-helper"
install_root="$HOME/Library/Application Support/Infinite Canvas/cli-helper"
plist_path="$HOME/Library/LaunchAgents/$label.plist"

if [[ -L "$install_root" || ( -e "$install_root" && ! -d "$install_root" ) ]]; then
    echo "安装目录类型不安全，拒绝卸载" >&2
    exit 1
fi
/bin/launchctl bootout "gui/$(/usr/bin/id -u)/$label" >/dev/null 2>&1 || true
/bin/rm -f \
    "$plist_path" \
    "$install_root/infinite-canvas-cli-helper.sock" \
    "$install_root/backend.env" \
    "$install_root/shared-secret" \
    "$install_root/public-key.txt" \
    "$install_root/manifest.json" \
    "$install_root/bin/infinite-canvas-cli-helper"
/bin/rmdir "$install_root/bin" "$install_root" 2>/dev/null || true

echo "CLI helper、LaunchAgent 和本机共享密钥已移除；日志目录保留。"
