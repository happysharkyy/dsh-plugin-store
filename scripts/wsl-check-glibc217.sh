#!/usr/bin/env bash
# 检查 glibc 2.17（CentOS 7）兼容性：
#   1) 官方 node 需要多高版本的 glibc
#   2) unofficial glibc-217 构建是否可用、它自己需要多少
#   3) 插件包里的 .node 原生模块各自需要多少
set -uo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
CACHE="$HOME/.cache/dsh-node"
mkdir -p "$CACHE"

echo "=== 1. 现有 runtime/node 的依赖 ==="
readelf --version-info /mnt/d/dsh_store_plugin/runtime/node/bin/node 2>/dev/null \
  | grep -o 'GLIBC_[0-9.]*' | sort -u -V | tail -3

echo
echo "=== 2. unofficial glibc-217 构建 ==="
for v in v22.22.3 v22.11.0 v20.19.0 v20.18.0 v18.20.4; do
  url="https://unofficial-builds.nodejs.org/download/release/$v/node-$v-linux-x64-glibc-217.tar.gz"
  code=$(curl -sS -m 25 -o /dev/null -w '%{http_code}' -L "$url" 2>/dev/null)
  echo "$v -> $code"
done
