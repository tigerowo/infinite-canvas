#!/bin/bash

set -euo pipefail
umask 077

label="com.tigerowo.infinite-canvas.cli-helper"
helper_source=""
manifest_source=""
public_key_source=""
team_id=""

usage() {
    echo "用法: $0 --helper /absolute/helper --manifest /absolute/manifest.json --public-key /absolute/public-key.txt --team-id APPLE_TEAM_ID" >&2
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --helper) helper_source="${2:-}"; shift 2 ;;
        --manifest) manifest_source="${2:-}"; shift 2 ;;
        --public-key) public_key_source="${2:-}"; shift 2 ;;
        --team-id) team_id="${2:-}"; shift 2 ;;
        *) usage; exit 2 ;;
    esac
done

if [[ "$(/usr/bin/uname -s)" != "Darwin" || -z "$helper_source" || -z "$manifest_source" || -z "$public_key_source" || ! "$team_id" =~ ^[A-Z0-9]{10}$ ]]; then
    usage
    exit 2
fi

resolve_file() {
    local source="$1"
    [[ "$source" = /* && -f "$source" && ! -L "$source" ]] || return 1
    local directory
    directory="$(cd "$(/usr/bin/dirname "$source")" && pwd -P)"
    printf '%s/%s\n' "$directory" "$(/usr/bin/basename "$source")"
}

helper_source="$(resolve_file "$helper_source")" || { echo "helper 文件无效" >&2; exit 1; }
manifest_source="$(resolve_file "$manifest_source")" || { echo "清单文件无效" >&2; exit 1; }
public_key_source="$(resolve_file "$public_key_source")" || { echo "公钥文件无效" >&2; exit 1; }

for source in "$helper_source" "$manifest_source" "$public_key_source"; do
    mode="$(/usr/bin/stat -f '%Lp' "$source")"
    if (( (8#$mode & 022) != 0 )); then
        echo "安装源文件不能允许组或其他用户写入" >&2
        exit 1
    fi
done

/usr/bin/codesign --verify --strict --verbose=2 "$helper_source" >/dev/null 2>&1 || {
    echo "helper 的 Apple 代码签名无效" >&2
    exit 1
}
/usr/sbin/spctl --assess --type execute --verbose=2 "$helper_source" >/dev/null 2>&1 || {
    echo "helper 未通过 Gatekeeper 公证评估" >&2
    exit 1
}
signature_info="$(/usr/bin/codesign -d --verbose=4 "$helper_source" 2>&1)"
if ! /usr/bin/grep -Fq "Authority=Developer ID Application:" <<<"$signature_info" || ! /usr/bin/grep -Fq "TeamIdentifier=$team_id" <<<"$signature_info"; then
    echo "helper 签名团队不匹配" >&2
    exit 1
fi

install_root="$HOME/Library/Application Support/Infinite Canvas/cli-helper"
bin_dir="$install_root/bin"
logs_dir="$HOME/Library/Logs/Infinite Canvas"
launch_agents_dir="$HOME/Library/LaunchAgents"
helper_path="$bin_dir/infinite-canvas-cli-helper"
manifest_path="$install_root/manifest.json"
public_key_path="$install_root/public-key.txt"
secret_path="$install_root/shared-secret"
socket_path="$install_root/infinite-canvas-cli-helper.sock"
backend_env_path="$install_root/backend.env"
plist_path="$launch_agents_dir/$label.plist"

if [[ -L "$install_root" || ( -e "$install_root" && ! -d "$install_root" ) ]]; then
    echo "安装目录不是安全的普通目录" >&2
    exit 1
fi
/bin/mkdir -p "$bin_dir" "$logs_dir" "$launch_agents_dir"
/usr/bin/stat -f '%Su' "$install_root" | /usr/bin/grep -Fxq "$(/usr/bin/id -un)" || { echo "安装目录所有者不正确" >&2; exit 1; }
/bin/chmod 700 "$install_root" "$bin_dir"

tmp_dir="$(/usr/bin/mktemp -d "$install_root/.install.XXXXXX")"
cleanup() { /bin/rm -f "$tmp_dir/helper" "$tmp_dir/manifest.json" "$tmp_dir/public-key.txt" "$tmp_dir/agent.plist" "$tmp_dir/backend.env" "$tmp_dir/shared-secret"; /bin/rmdir "$tmp_dir" 2>/dev/null || true; }
trap cleanup EXIT

/usr/bin/install -m 700 "$helper_source" "$tmp_dir/helper"
/usr/bin/install -m 600 "$manifest_source" "$tmp_dir/manifest.json"
/usr/bin/install -m 600 "$public_key_source" "$tmp_dir/public-key.txt"
/usr/bin/codesign --verify --strict --verbose=2 "$tmp_dir/helper" >/dev/null 2>&1 || { echo "复制后的 helper 签名无效" >&2; exit 1; }
/usr/sbin/spctl --assess --type execute --verbose=2 "$tmp_dir/helper" >/dev/null 2>&1 || { echo "复制后的 helper 未通过 Gatekeeper 公证评估" >&2; exit 1; }
copied_signature_info="$(/usr/bin/codesign -d --verbose=4 "$tmp_dir/helper" 2>&1)"
if ! /usr/bin/grep -Fq "Authority=Developer ID Application:" <<<"$copied_signature_info" || ! /usr/bin/grep -Fq "TeamIdentifier=$team_id" <<<"$copied_signature_info"; then
    echo "复制后的 helper 签名身份不匹配" >&2
    exit 1
fi
if [[ -e "$secret_path" || -L "$secret_path" ]]; then
    [[ -f "$secret_path" && ! -L "$secret_path" ]] || { echo "现有共享密钥文件类型不安全" >&2; exit 1; }
    mode="$(/usr/bin/stat -f '%Lp' "$secret_path")"
    (( (8#$mode & 077) == 0 )) || { echo "现有共享密钥权限不安全" >&2; exit 1; }
else
    /usr/bin/openssl rand -base64 48 > "$tmp_dir/shared-secret"
    /bin/chmod 600 "$tmp_dir/shared-secret"
fi

xml_escape() {
    /usr/bin/sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g' -e "s/'/\&apos;/g"
}

helper_xml="$(printf '%s' "$helper_path" | xml_escape)"
manifest_xml="$(printf '%s' "$manifest_path" | xml_escape)"
public_key_xml="$(printf '%s' "$public_key_path" | xml_escape)"
secret_xml="$(printf '%s' "$secret_path" | xml_escape)"
socket_xml="$(printf '%s' "$socket_path" | xml_escape)"
stdout_xml="$(printf '%s' "$logs_dir/cli-helper.log" | xml_escape)"
stderr_xml="$(printf '%s' "$logs_dir/cli-helper-error.log" | xml_escape)"
path_value="/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin:/Applications/ChatGPT.app/Contents/Resources:$HOME/.local/bin:$HOME/.npm/bin:$HOME/.bun/bin:$HOME/.codex/bin"
path_xml="$(printf '%s' "$path_value" | xml_escape)"

/bin/cat > "$tmp_dir/agent.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$label</string>
<key>ProgramArguments</key><array><string>$helper_xml</string></array>
<key>EnvironmentVariables</key><dict>
<key>CLI_HELPER_ENABLED</key><string>true</string>
<key>CLI_HELPER_MANIFEST</key><string>$manifest_xml</string>
<key>CLI_HELPER_PUBLIC_KEY_FILE</key><string>$public_key_xml</string>
<key>CLI_HELPER_SHARED_SECRET_FILE</key><string>$secret_xml</string>
<key>CLI_HELPER_SOCKET</key><string>$socket_xml</string>
<key>PATH</key><string>$path_xml</string>
</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ProcessType</key><string>Interactive</string>
<key>StandardOutPath</key><string>$stdout_xml</string>
<key>StandardErrorPath</key><string>$stderr_xml</string>
</dict></plist>
EOF
/bin/chmod 600 "$tmp_dir/agent.plist"

{
    printf 'CLI_HELPER_ENABLED=true\n'
    printf 'CLI_HELPER_MANIFEST=%q\n' "$manifest_path"
    printf 'CLI_HELPER_PUBLIC_KEY_FILE=%q\n' "$public_key_path"
    printf 'CLI_HELPER_SHARED_SECRET_FILE=%q\n' "$secret_path"
    printf 'CLI_HELPER_SOCKET=%q\n' "$socket_path"
} > "$tmp_dir/backend.env"
/bin/chmod 600 "$tmp_dir/backend.env"

/bin/launchctl bootout "gui/$(/usr/bin/id -u)/$label" >/dev/null 2>&1 || true
/bin/mv -f "$tmp_dir/helper" "$helper_path"
/bin/mv -f "$tmp_dir/manifest.json" "$manifest_path"
/bin/mv -f "$tmp_dir/public-key.txt" "$public_key_path"
if [[ ! -e "$secret_path" ]]; then
    /bin/mv "$tmp_dir/shared-secret" "$secret_path"
fi
/bin/mv -f "$tmp_dir/backend.env" "$backend_env_path"
/bin/mv -f "$tmp_dir/agent.plist" "$plist_path"
/bin/chmod 700 "$helper_path"
/bin/chmod 600 "$manifest_path" "$public_key_path" "$secret_path" "$backend_env_path" "$plist_path"

CLI_HELPER_ENABLED=true \
CLI_HELPER_MANIFEST="$manifest_path" \
CLI_HELPER_PUBLIC_KEY_FILE="$public_key_path" \
CLI_HELPER_SHARED_SECRET_FILE="$secret_path" \
CLI_HELPER_SOCKET="$socket_path" \
"$helper_path" verify-config

/bin/launchctl bootstrap "gui/$(/usr/bin/id -u)" "$plist_path"
/bin/launchctl kickstart -k "gui/$(/usr/bin/id -u)/$label"

echo "CLI helper 已安装并启动。后端启动前请加载：$backend_env_path"
