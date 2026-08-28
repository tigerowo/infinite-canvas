---
title: Mac CLI helper 安装与签名发布
description: 受控伴随进程的离线清单签名、Developer ID 发布、安装和卸载流程
---

# Mac CLI helper 安装与签名发布

Mac CLI helper 使用两套独立信任机制：

- helper 二进制由 Apple Developer ID Application 证书签名，可选提交 Apple 公证；安装器要求签名有效且 Team ID 与发布方明确提供的值一致。
- 可调用 CLI 的候选名和 SHA-256 由离线 Ed25519 私钥签名。私钥不进入发布包、项目目录、环境变量、日志或 Git。

发布要求依据 Apple 的 [macOS 软件公证说明](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)：直接分发的可执行文件使用 Developer ID、hardened runtime 和安全时间戳，并通过 `notarytool` 提交公证。当前用户后台进程放在 `~/Library/LaunchAgents`，符合 Apple 对 [Launch Agents](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html) 的目录约定。

安装器不会安装 Codex，也不会读取 shell profile。它只安装已签名 helper、可信清单和公钥，创建本机随机共享密钥文件，并注册当前用户的 LaunchAgent。

## 本机开发安装（个人自用）

仅在自己的 Mac 上开发和使用时，不需要购买 Apple Developer Program。运行独立开发安装器：

```bash
scripts/macos/install-cli-helper-dev.sh
```

开发安装器只接受零参数，使用当前仓库源码和当前 `PATH` 中的 `go`、`codex`：

- 只构建当前 Mac 架构，并使用本机 ad-hoc 签名；不会伪造 Developer ID、Team ID、Gatekeeper 或 Apple 公证通过。
- 在安装期间生成临时 Ed25519 私钥和 30 天有效清单，只允许当前解析到的 Codex 二进制 SHA-256；私钥不会保留，公钥和清单使用 `0600` 权限安装。
- 使用独立目录 `~/Library/Application Support/Infinite Canvas/cli-helper-dev`、独立 LaunchAgent `com.tigerowo.infinite-canvas.cli-helper.dev` 和独立日志，不覆盖正式安装；Unix Socket 位于权限为 `0700` 的短路径 `~/.infinite-canvas/cli-helper-dev/helper.sock`，避免触及 macOS Socket 路径长度上限。
- 首次安装生成随机共享密钥，重复安装保留该密钥；Socket、公钥、清单、共享密钥、环境文件和 LaunchAgent 均只允许当前用户访问。
- Codex CLI 更新或清单到期后必须重新运行安装器，重新计算二进制哈希并生成新清单。

开发安装完成后，按脚本提示加载：

```bash
set -a
source "$HOME/Library/Application Support/Infinite Canvas/cli-helper-dev/backend.env"
set +a
go run .
```

开发模式仅限本机个人使用，不能作为发布包发送给其他用户。独立卸载不会删除正式 helper 或 Codex 登录凭据：

```bash
scripts/macos/uninstall-cli-helper-dev.sh --confirm
```

## 1. 离线生成清单签名密钥

在不属于项目目录的私有目录中执行一次：

```bash
mkdir -m 700 "/absolute/offline/signing-directory"
go run ./cmd/infinite-canvas-cli-manifest \
  -generate-key \
  -private-key "/absolute/offline/signing-directory/manifest-private-key.pem" \
  -public-key "/absolute/release/manifest-public-key.txt"
```

工具拒绝覆盖已有文件。私钥采用 PKCS#8 PEM，所在目录和文件不得向组或其他用户开放；公钥是单行 Base64 文本。

## 2. 生成可信 CLI 清单

每次接受新的 Codex CLI 二进制时重新计算摘要并签名。到期时间必须是未来 90 天内的 RFC 3339 时间：

```bash
go run ./cmd/infinite-canvas-cli-manifest \
  -private-key "/absolute/offline/signing-directory/manifest-private-key.pem" \
  -output "/absolute/release/cli-helper-manifest.json" \
  -expires-at "<RFC3339>" \
  -entry "codex=codex=/absolute/path/to/codex"
```

`-entry` 可以重复，但协议和候选名只能来自项目 allowlist。工具会解析软链接，拒绝不在受控根目录、允许组/其他用户写入、超过 256 MiB 或不是普通文件的目标。

## 3. 构建 Developer ID 签名发布包

发布机需安装 Xcode Command Line Tools，并在钥匙串中准备 Developer ID Application 证书：

```bash
scripts/macos/release-cli-helper.sh \
  --output "/absolute/release" \
  --identity "Developer ID Application: Publisher Name (TEAMID1234)" \
  --team-id "TEAMID1234" \
  --notary-profile "infinite-canvas-notary" \
  --manifest "/absolute/release/cli-helper-manifest.json" \
  --public-key "/absolute/release/manifest-public-key.txt"
```

脚本分别构建 `arm64` 和 `amd64`，合并 universal 二进制，启用 hardened runtime 并加时间戳签名，随后核对 Team ID。打包前会用临时随机共享密钥运行 `verify-config`，确认发布包中的公钥与清单匹配；临时密钥不进入 ZIP。公证配置是正式发布的必填项，凭据只从 `notarytool` 已保存的钥匙串配置读取。发布目录得到包含 helper、安装/卸载器、清单和公钥的 ZIP，以及对应 SHA-256 文件；脚本拒绝覆盖已有发布产物。

## 4. 当前用户安装

解压发布包后，用发布方公开的 Team ID 安装：

```bash
./install-cli-helper.sh \
  --helper "$PWD/infinite-canvas-cli-helper" \
  --manifest "$PWD/cli-helper-manifest.json" \
  --public-key "$PWD/manifest-public-key.txt" \
  --team-id "TEAMID1234"
```

安装器先验证 Apple Developer ID 代码签名、Team ID、Gatekeeper 公证评估和源文件权限，然后安装到：

```text
~/Library/Application Support/Infinite Canvas/cli-helper
```

共享密钥首次安装时随机生成，文件权限固定为 `0600`；重复安装会保留原共享密钥。LaunchAgent plist 只保存文件路径，不保存密钥正文。安装完成前，helper 会执行一次 `verify-config`，验证 Ed25519 清单、公钥和共享密钥配置。

## 5. 启动 Web 后端

正式安装器生成的 `backend.env` 只有开关和受保护文件路径，不包含密钥正文。启动本机 Go 后端前加载它：

```bash
set -a
source "$HOME/Library/Application Support/Infinite Canvas/cli-helper/backend.env"
set +a
go run .
```

也可以把这些非敏感路径变量写入被 Git 忽略的 `.env`。不要把 `shared-secret` 内容复制到 `.env`、终端历史、报告或聊天。

## 6. 升级与卸载

升级时使用新签名 helper、未过期清单和相同 Team ID 再次运行安装器。卸载必须显式确认：

```bash
./uninstall-cli-helper.sh --confirm
```

卸载器停止 LaunchAgent，并删除 helper、清单、公钥、共享密钥、Socket 和后端环境文件；日志目录保留。删除共享密钥后，仍在运行的旧后端必须重启且不能再连接 helper。

## 发布检查清单

- Developer ID Application 签名有效，Team ID 与公开值一致。
- 使用钥匙串中的公证配置；不把 Apple 凭据放进参数、脚本或 CI 日志。
- Ed25519 私钥始终离线，仅发布公钥与签名清单。
- ZIP 的 SHA-256 通过独立渠道公布并在安装前核对。
- 清单未过期，且只包含已复核版本的 CLI 摘要。
- 发布包、`.env`、SQLite、用户素材和本机共享密钥都不进入 Git。
