#!/bin/bash

set -euo pipefail
umask 077

if [[ $# -ne 0 || "$(/usr/bin/uname -s)" != "Darwin" ]]; then
    echo "用法: $0" >&2
    exit 2
fi

for command in go codex codesign openssl launchctl; do
    command -v "$command" >/dev/null || { echo "缺少命令: $command" >&2; exit 1; }
done

repo_root="$(cd "$(dirname "$0")/../.." && pwd -P)"
go_path="$(command -v go)"
codex_path="$(command -v codex)"
[[ "$codex_path" = /* ]] || { echo "Codex CLI 必须使用绝对路径" >&2; exit 1; }
agy_path="$(command -v agy || true)"
if [[ -n "$agy_path" && "$agy_path" != /* ]]; then
    echo "Antigravity CLI 必须使用绝对路径" >&2
    exit 1
fi
gemini_path="$(command -v gemini || true)"
if [[ -n "$gemini_path" && "$gemini_path" != /* ]]; then
    echo "Gemini 官方 CLI 必须使用绝对路径" >&2
    exit 1
fi
dreamina_path="$(command -v dreamina || true)"
if [[ -n "$dreamina_path" && "$dreamina_path" != /* ]]; then
    echo "即梦 CLI 必须使用绝对路径" >&2
    exit 1
fi
gpt_image_2_path="$(command -v gpt-image-2-skill || true)"
if [[ -n "$gpt_image_2_path" && "$gpt_image_2_path" != /* ]]; then
    echo "GPT Image 2 helper 必须使用绝对路径" >&2
    exit 1
fi

cli_proxy_enabled="${CLI_PROXY_ENABLED:-false}"
cli_proxy_key_file="${CLI_PROXY_API_KEY_FILE:-}"
if [[ "$cli_proxy_enabled" != "true" && "$cli_proxy_enabled" != "false" ]]; then
    echo "CLI_PROXY_ENABLED 只能是 true 或 false" >&2
    exit 1
fi
if [[ "$cli_proxy_enabled" == "true" ]]; then
    [[ "$cli_proxy_key_file" = /* && -f "$cli_proxy_key_file" && ! -L "$cli_proxy_key_file" ]] || { echo "订阅代理密钥必须是仓库外的普通绝对路径文件" >&2; exit 1; }
    [[ "$cli_proxy_key_file" != "$repo_root"/* ]] || { echo "订阅代理密钥不能放在项目仓库内" >&2; exit 1; }
    /usr/bin/stat -f '%Su' "$cli_proxy_key_file" | /usr/bin/grep -Fxq "$(/usr/bin/id -un)" || { echo "订阅代理密钥文件所有者不正确" >&2; exit 1; }
    /usr/bin/stat -f '%Lp' "$cli_proxy_key_file" | /usr/bin/grep -Fxq '600' || { echo "订阅代理密钥文件权限必须是 0600" >&2; exit 1; }
fi

label="com.tigerowo.infinite-canvas.cli-helper.dev"
install_root="$HOME/Library/Application Support/Infinite Canvas/cli-helper-dev"
bin_dir="$install_root/bin"
logs_dir="$HOME/Library/Logs/Infinite Canvas"
launch_agents_dir="$HOME/Library/LaunchAgents"
helper_path="$bin_dir/infinite-canvas-cli-helper"
manifest_path="$install_root/manifest.json"
public_key_path="$install_root/public-key.txt"
secret_path="$install_root/shared-secret"
socket_parent="$HOME/.infinite-canvas"
socket_dir="$socket_parent/cli-helper-dev"
socket_path="$socket_dir/helper.sock"
backend_env_path="$install_root/backend.env"
plist_path="$launch_agents_dir/$label.plist"

if [[ -L "$install_root" || ( -e "$install_root" && ! -d "$install_root" ) ]]; then
    echo "开发安装目录不是安全的普通目录" >&2
    exit 1
fi
for directory in "$socket_parent" "$socket_dir"; do
    if [[ -L "$directory" || ( -e "$directory" && ! -d "$directory" ) ]]; then
        echo "开发 Socket 目录类型不安全" >&2
        exit 1
    fi
done
/bin/mkdir -p "$bin_dir" "$logs_dir" "$launch_agents_dir" "$socket_dir"
/usr/bin/stat -f '%Su' "$install_root" | /usr/bin/grep -Fxq "$(/usr/bin/id -un)" || { echo "开发安装目录所有者不正确" >&2; exit 1; }
for directory in "$install_root" "$socket_parent" "$socket_dir"; do
    /usr/bin/stat -f '%Su' "$directory" | /usr/bin/grep -Fxq "$(/usr/bin/id -un)" || { echo "开发目录所有者不正确" >&2; exit 1; }
done
/bin/chmod 700 "$install_root" "$bin_dir" "$socket_parent" "$socket_dir"

work_dir="$(/usr/bin/mktemp -d "$install_root/.dev-install.XXXXXX")"
cleanup() {
    if [[ -n "$work_dir" && -d "$work_dir" && "$work_dir" != "/" ]]; then
        /bin/rm -rf "$work_dir"
    fi
}
trap cleanup EXIT

architecture="$(/usr/bin/uname -m)"
[[ "$architecture" == "arm64" ]] || architecture="amd64"
cd "$repo_root"
CGO_ENABLED=0 GOOS=darwin GOARCH="$architecture" "$go_path" build -trimpath -ldflags="-s -w" -o "$work_dir/helper" ./cmd/infinite-canvas-cli-helper
/usr/bin/codesign --force --sign - "$work_dir/helper" >/dev/null
/usr/bin/codesign --verify --strict "$work_dir/helper"

/bin/mkdir "$work_dir/signing"
/bin/chmod 700 "$work_dir/signing"
"$go_path" run ./cmd/infinite-canvas-cli-manifest \
    -generate-key \
    -private-key "$work_dir/signing/private-key.pem" \
    -public-key "$work_dir/public-key.txt" >/dev/null
expires_at="$(/bin/date -u -v+30d '+%Y-%m-%dT%H:%M:%SZ')"
manifest_entries=(-entry "codex=codex=$codex_path")
manifest_entries+=(-entry "codex-image-emergency=codex=$codex_path")
if [[ -n "$gpt_image_2_path" ]]; then
    manifest_entries+=(-entry "gpt-image-2=gpt-image-2-skill=$gpt_image_2_path")
fi
if [[ -n "$agy_path" ]]; then
    manifest_entries+=(-entry "gemini-cli=agy=$agy_path")
fi
if [[ -n "$gemini_path" ]]; then
    manifest_entries+=(-entry "gemini-official-cli=gemini=$gemini_path")
fi
if [[ -n "$dreamina_path" ]]; then
    manifest_entries+=(-entry "jimeng=dreamina=$dreamina_path")
fi
"$go_path" run ./cmd/infinite-canvas-cli-manifest \
    -private-key "$work_dir/signing/private-key.pem" \
    -output "$work_dir/manifest.json" \
    -expires-at "$expires_at" \
    "${manifest_entries[@]}" >/dev/null

if [[ -e "$secret_path" || -L "$secret_path" ]]; then
    [[ -f "$secret_path" && ! -L "$secret_path" ]] || { echo "现有开发共享密钥文件类型不安全" >&2; exit 1; }
    mode="$(/usr/bin/stat -f '%Lp' "$secret_path")"
    (( (8#$mode & 077) == 0 )) || { echo "现有开发共享密钥权限不安全" >&2; exit 1; }
    preflight_secret="$secret_path"
else
    /usr/bin/openssl rand -base64 48 > "$work_dir/shared-secret"
    /bin/chmod 600 "$work_dir/shared-secret"
    preflight_secret="$work_dir/shared-secret"
fi

xml_escape() {
    /usr/bin/sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g' -e "s/'/\&apos;/g"
}

helper_xml="$(printf '%s' "$helper_path" | xml_escape)"
manifest_xml="$(printf '%s' "$manifest_path" | xml_escape)"
public_key_xml="$(printf '%s' "$public_key_path" | xml_escape)"
secret_xml="$(printf '%s' "$secret_path" | xml_escape)"
socket_xml="$(printf '%s' "$socket_path" | xml_escape)"
stdout_xml="$(printf '%s' "$logs_dir/cli-helper-dev.log" | xml_escape)"
stderr_xml="$(printf '%s' "$logs_dir/cli-helper-dev-error.log" | xml_escape)"
path_value="/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin:/Applications/ChatGPT.app/Contents/Resources:$HOME/.local/bin:$HOME/.npm/bin:$HOME/.bun/bin:$HOME/.codex/bin"
path_xml="$(printf '%s' "$path_value" | xml_escape)"
cli_proxy_enabled_xml="$(printf '%s' "$cli_proxy_enabled" | xml_escape)"
cli_proxy_key_file_xml="$(printf '%s' "$cli_proxy_key_file" | xml_escape)"
proxy_xml=""
for proxy_name in HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy; do
    proxy_value="$(/usr/bin/printenv "$proxy_name" 2>/dev/null || true)"
    if [[ "$proxy_value" =~ ^https?://(localhost|127\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|\[::1\]):[0-9]{1,5}/?$ ]]; then
        proxy_value_xml="$(printf '%s' "$proxy_value" | xml_escape)"
        proxy_xml+="<key>$proxy_name</key><string>$proxy_value_xml</string>"$'\n'
    fi
done

/bin/cat > "$work_dir/agent.plist" <<EOF
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
<key>CLI_PROXY_ENABLED</key><string>$cli_proxy_enabled_xml</string>
<key>CLI_PROXY_API_KEY_FILE</key><string>$cli_proxy_key_file_xml</string>
<key>PATH</key><string>$path_xml</string>
$proxy_xml</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ProcessType</key><string>Interactive</string>
<key>StandardOutPath</key><string>$stdout_xml</string>
<key>StandardErrorPath</key><string>$stderr_xml</string>
</dict></plist>
EOF
/bin/chmod 600 "$work_dir/agent.plist"

{
    printf 'CLI_HELPER_ENABLED=true\n'
    printf 'CLI_HELPER_MANIFEST=%q\n' "$manifest_path"
    printf 'CLI_HELPER_PUBLIC_KEY_FILE=%q\n' "$public_key_path"
    printf 'CLI_HELPER_SHARED_SECRET_FILE=%q\n' "$secret_path"
    printf 'CLI_HELPER_SOCKET=%q\n' "$socket_path"
    printf 'CLI_PROXY_ENABLED=%q\n' "$cli_proxy_enabled"
    printf 'CLI_PROXY_API_KEY_FILE=%q\n' "$cli_proxy_key_file"
} > "$work_dir/backend.env"
/bin/chmod 600 "$work_dir/backend.env" "$work_dir/manifest.json" "$work_dir/public-key.txt"

CLI_HELPER_ENABLED=true \
CLI_HELPER_MANIFEST="$work_dir/manifest.json" \
CLI_HELPER_PUBLIC_KEY_FILE="$work_dir/public-key.txt" \
CLI_HELPER_SHARED_SECRET_FILE="$preflight_secret" \
CLI_HELPER_SOCKET="$socket_path" \
"$work_dir/helper" verify-config

/bin/launchctl bootout "gui/$(/usr/bin/id -u)/$label" >/dev/null 2>&1 || true
/bin/rm -f "$socket_path"
/bin/mv -f "$work_dir/helper" "$helper_path"
/bin/mv -f "$work_dir/manifest.json" "$manifest_path"
/bin/mv -f "$work_dir/public-key.txt" "$public_key_path"
if [[ ! -e "$secret_path" ]]; then
    /bin/mv "$work_dir/shared-secret" "$secret_path"
fi
/bin/mv -f "$work_dir/backend.env" "$backend_env_path"
/bin/mv -f "$work_dir/agent.plist" "$plist_path"
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

echo "本机开发 CLI helper 已安装并启动。"
echo "仅限当前 Mac 个人开发使用；未经过 Developer ID 签名或 Apple 公证，不可作为发布包分发。"
echo "后端启动前请加载：$backend_env_path"
