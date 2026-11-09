#!/usr/bin/env bash
# DSH 内网插件商店 —— Linux 启动脚本
#
#   ./start.sh              默认 0.0.0.0:8787
#   PORT=8080 ./start.sh    改端口
#
# 不要求服务器预装 Node：如果系统里没有 18+ 的 node，
# 会自动使用随包分发的 runtime/node/bin/node。
set -euo pipefail

cd "$(dirname "$0")"

NODE_BIN=""

# 1) 系统 node（版本够才用）
if command -v node >/dev/null 2>&1; then
  ver=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  if [ "$ver" -ge 18 ] 2>/dev/null; then
    NODE_BIN="$(command -v node)"
  else
    echo "[提示] 系统 node 版本过低（$(node -v 2>/dev/null)），改用随包运行时"
  fi
fi

# 2) 随包分发的 node
if [ -z "$NODE_BIN" ] && [ -x "./runtime/node/bin/node" ]; then
  NODE_BIN="$(cd "$(dirname ./runtime/node/bin/node)" && pwd)/node"
fi

if [ -z "$NODE_BIN" ]; then
  echo "[错误] 没有可用的 Node.js，且未找到 runtime/node/bin/node" >&2
  echo "       把 runtime/ 目录一并拷过来，或安装 Node.js 18+" >&2
  exit 1
fi

echo "使用 Node：$NODE_BIN  ($("$NODE_BIN" -v))"
export PATH="$(dirname "$NODE_BIN"):$PATH"

# 首次运行时生成目录数据（纯本地，不联网）
if [ ! -f web/data/plugins.json ] && [ ! -d data/admin/packages ]; then
  echo "首次启动，生成插件目录…"
  "$NODE_BIN" scripts/build-catalog.mjs --offline || true
fi

export PORT="${PORT:-8787}"
export HOST="${HOST:-0.0.0.0}"

exec "$NODE_BIN" server.mjs
