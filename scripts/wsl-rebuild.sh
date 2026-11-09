#!/usr/bin/env bash
# 在 WSL 里增量重建指定插件（其它包保持不动）
#
#   wsl bash /mnt/d/dsh_store_plugin/scripts/wsl-rebuild.sh files,easyssh
set -uo pipefail
export PATH="$HOME/.npm-global/bin:$HOME/tools/node-v22.22.3-linux-x64/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export CI=1

WIN_ROOT=/mnt/d/dsh_store_plugin
BUILD_ROOT="$HOME/store-linux"
ONLY="${1:-}"

command -v node >/dev/null 2>&1 || { echo "node 不可用"; exit 1; }
export DSH_PNPM_BIN="$(command -v pnpm || true)"
echo "node=$(node -v)  pnpm=${DSH_PNPM_BIN:-未找到}  重建=${ONLY:-全部}"

# 前置校验：sources.json 必须是明文 JSON。
# 在装了透明加密的 Windows 上，node 脚本写出来的文件在磁盘上是密文，
# WSL 里读到的是 %TSD-Header 块，解析会直接失败。
if ! node -e "JSON.parse(require('fs').readFileSync('$WIN_ROOT/catalog/sources.json','utf8'))" 2>/dev/null; then
  echo "错误：$WIN_ROOT/catalog/sources.json 不是明文 JSON（很可能被 DLP 加密了）"
  echo "      请先在 Windows 侧执行："
  echo "      powershell -ExecutionPolicy Bypass -File D:\\skills\\dlp-file-recovery\\scripts\\restore-dlp.ps1 -Root $WIN_ROOT"
  exit 2
fi

# 同步最新脚本到构建目录
cp -f "$WIN_ROOT/scripts/mirror.mjs" "$BUILD_ROOT/scripts/mirror.mjs"
cp -f "$WIN_ROOT/scripts/lib/tar.mjs" "$BUILD_ROOT/scripts/lib/tar.mjs"
cp -f "$WIN_ROOT/catalog/sources.json" "$BUILD_ROOT/catalog/sources.json"
# 本地插件目录（自己写的插件）也同步过去
rm -rf "$BUILD_ROOT/local-plugins"
if [ -d "$WIN_ROOT/local-plugins" ]; then
  cp -a "$WIN_ROOT/local-plugins" "$BUILD_ROOT/local-plugins"
fi

cd "$BUILD_ROOT"
if [ -n "$ONLY" ]; then
  node scripts/mirror.mjs --only "$ONLY" --fresh 2>&1 | tail -40
else
  node scripts/mirror.mjs --fresh 2>&1 | tail -60
fi
STATUS=${PIPESTATUS[0]}

# 回传
OUT="$WIN_ROOT/mirror/packages-linux"
mkdir -p "$OUT"
cp -f "$BUILD_ROOT"/mirror/packages/*.tgz "$OUT/" 2>/dev/null
cp -f "$BUILD_ROOT/mirror/manifest.json" "$WIN_ROOT/mirror/manifest-linux.json"

echo
echo "=== mirror/packages-linux ==="
ls -1sh "$OUT"
echo "退出码: $STATUS"
