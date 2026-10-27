#!/usr/bin/env bash
# 只登记本地插件；不启动插件、不连接 ADB/QQ、不发送消息。
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$SCRIPT_DIR/install-dsh.mjs" "$@"
