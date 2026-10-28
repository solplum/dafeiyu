#!/usr/bin/env bash
# 默认只读；传 --fix-links 才修复软链接，不连接设备或调用模型。
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$SCRIPT_DIR/doctor.mjs" "$@"
