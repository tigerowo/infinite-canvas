#!/bin/bash

set -euo pipefail
umask 022

output_dir=""
identity=""
team_id=""
notary_profile=""
manifest_source=""
public_key_source=""

usage() {
    echo "用法: $0 --output /absolute/directory --identity 'Developer ID Application: ...' --team-id APPLE_TEAM_ID --notary-profile keychain-profile --manifest /absolute/manifest.json --public-key /absolute/public-key.txt" >&2
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --output) output_dir="${2:-}"; shift 2 ;;
        --identity) identity="${2:-}"; shift 2 ;;
        --team-id) team_id="${2:-}"; shift 2 ;;
        --notary-profile) notary_profile="${2:-}"; shift 2 ;;
        --manifest) manifest_source="${2:-}"; shift 2 ;;
        --public-key) public_key_source="${2:-}"; shift 2 ;;
        *) usage; exit 2 ;;
    esac
done

if [[ "$(/usr/bin/uname -s)" != "Darwin" || "$output_dir" != /* || -z "$identity" || ! "$team_id" =~ ^[A-Z0-9]{10}$ || -z "$notary_profile" || "$manifest_source" != /* || "$public_key_source" != /* ]]; then
    usage
    exit 2
fi

for command in go lipo codesign ditto shasum; do
    command -v "$command" >/dev/null || { echo "缺少命令: $command" >&2; exit 1; }
done
go_path="$(command -v go)"
command -v xcrun >/dev/null || { echo "缺少 xcrun" >&2; exit 1; }
[[ -f "$manifest_source" && ! -L "$manifest_source" && -f "$public_key_source" && ! -L "$public_key_source" ]] || { echo "清单或公钥文件无效" >&2; exit 1; }

repo_root="$(cd "$(dirname "$0")/../.." && pwd -P)"
version="$(/usr/bin/tr -d '\r\n' < "$repo_root/VERSION")"
[[ "$version" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "VERSION 格式无效" >&2; exit 1; }
/bin/mkdir -p "$output_dir"
archive="$output_dir/infinite-canvas-cli-helper-$version-macos-universal.zip"
checksum="$archive.sha256"
[[ ! -e "$archive" && ! -e "$checksum" ]] || { echo "发布产物已存在" >&2; exit 1; }

work_dir="$(/usr/bin/mktemp -d)"
cleanup() {
    if [[ -n "$work_dir" && -d "$work_dir" && "$work_dir" != "/" ]]; then
        /bin/rm -rf "$work_dir"
    fi
}
trap cleanup EXIT

cd "$repo_root"
for architecture in arm64 amd64; do
    CGO_ENABLED=0 GOOS=darwin GOARCH="$architecture" "$go_path" build -trimpath -ldflags="-s -w" -o "$work_dir/helper-$architecture" ./cmd/infinite-canvas-cli-helper
done
/usr/bin/lipo -create "$work_dir/helper-arm64" "$work_dir/helper-amd64" -output "$work_dir/infinite-canvas-cli-helper"
/usr/bin/codesign --force --options runtime --timestamp --sign "$identity" "$work_dir/infinite-canvas-cli-helper"
/usr/bin/codesign --verify --strict --verbose=2 "$work_dir/infinite-canvas-cli-helper"
signature_info="$(/usr/bin/codesign -d --verbose=4 "$work_dir/infinite-canvas-cli-helper" 2>&1)"
if ! /usr/bin/grep -Fq "Authority=Developer ID Application:" <<<"$signature_info" || ! /usr/bin/grep -Fq "TeamIdentifier=$team_id" <<<"$signature_info"; then
    echo "Developer ID Application 签名身份校验失败" >&2
    exit 1
fi

bundle="$work_dir/infinite-canvas-cli-helper-$version"
/bin/mkdir "$bundle"
/usr/bin/install -m 755 "$work_dir/infinite-canvas-cli-helper" "$bundle/infinite-canvas-cli-helper"
/usr/bin/install -m 755 "$repo_root/scripts/macos/install-cli-helper.sh" "$bundle/install-cli-helper.sh"
/usr/bin/install -m 755 "$repo_root/scripts/macos/uninstall-cli-helper.sh" "$bundle/uninstall-cli-helper.sh"
/usr/bin/install -m 600 "$manifest_source" "$bundle/cli-helper-manifest.json"
/usr/bin/install -m 600 "$public_key_source" "$bundle/manifest-public-key.txt"
/usr/bin/openssl rand -base64 48 > "$work_dir/preflight-secret"
/bin/chmod 600 "$work_dir/preflight-secret"
CLI_HELPER_ENABLED=true \
CLI_HELPER_MANIFEST="$bundle/cli-helper-manifest.json" \
CLI_HELPER_PUBLIC_KEY_FILE="$bundle/manifest-public-key.txt" \
CLI_HELPER_SHARED_SECRET_FILE="$work_dir/preflight-secret" \
"$bundle/infinite-canvas-cli-helper" verify-config
/usr/bin/ditto -c -k --keepParent "$bundle" "$archive"

/usr/bin/xcrun notarytool submit "$archive" --keychain-profile "$notary_profile" --wait

/usr/bin/shasum -a 256 "$archive" > "$checksum"
echo "已生成签名发布包：$archive"
