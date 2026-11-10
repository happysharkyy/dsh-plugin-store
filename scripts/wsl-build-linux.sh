#!/usr/bin/env bash
# 在 WSL (Ubuntu x86_64) 里重建全部插件包 —— 产出可直接跑在 Linux 服务器上的 node_modules
#
# 用法（Windows 侧）：wsl bash /mnt/d/dsh_store_plugin/scripts/wsl-build-linux.sh
set -uo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export DEBIAN_FRONTEND=noninteractive
export CI=1

WIN_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_ROOT="$HOME/store-linux"
NODE_VER=v22.22.3
TOOLS="$HOME/tools"

step() { printf '\n=== %s ===\n' "$1"; }

step "0. 准备 node 运行时"
mkdir -p "$TOOLS"
if [ ! -x "$TOOLS/node-$NODE_VER-linux-x64/bin/node" ]; then
  echo "下载 node $NODE_VER ..."
  curl -fsSL -o "$TOOLS/node.tar.xz" "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-linux-x64.tar.xz" || {
    echo "主站失败，改用 npmmirror"; 
    curl -fsSL -o "$TOOLS/node.tar.xz" "https://cdn.npmmirror.com/binaries/node/$NODE_VER/node-$NODE_VER-linux-x64.tar.xz"
  }
  tar -xf "$TOOLS/node.tar.xz" -C "$TOOLS"
  rm -f "$TOOLS/node.tar.xz"
fi
export PATH="$TOOLS/node-$NODE_VER-linux-x64/bin:$PATH"
node -v && npm -v

step "1. 准备 pnpm"
export NPM_CONFIG_PREFIX="$HOME/.npm-global"
mkdir -p "$NPM_CONFIG_PREFIX"
export PATH="$NPM_CONFIG_PREFIX/bin:$PATH"
if ! command -v pnpm >/dev/null 2>&1; then
  npm install -g pnpm@11 --no-audit --no-fund --loglevel=error
fi
pnpm -v || echo "pnpm 不可用，将退回 npm"

step "2. 同步工程到 ext4（避免 9p 文件系统带来的权限/性能问题）"
rm -rf "$BUILD_ROOT"
mkdir -p "$BUILD_ROOT"
cp -a "$WIN_ROOT/catalog" "$BUILD_ROOT/"
cp -a "$WIN_ROOT/scripts" "$BUILD_ROOT/"
cp -a "$WIN_ROOT/local-plugins" "$BUILD_ROOT/"
cp -a "$WIN_ROOT/package.json" "$BUILD_ROOT/" 2>/dev/null || true
mkdir -p "$BUILD_ROOT/mirror/packages"
# 保留已有 manifest 以便复用已知结论
[ -f "$WIN_ROOT/mirror/manifest-linux.json" ] && cp "$WIN_ROOT/mirror/manifest-linux.json" "$BUILD_ROOT/mirror/manifest.json"
echo "工作目录: $BUILD_ROOT"

step "3. 镜像全部插件（linux-x64）"
cd "$BUILD_ROOT"
node scripts/mirror.mjs "$@" 2>&1 | tee "$BUILD_ROOT/mirror.log"
STATUS=${PIPESTATUS[0]}
if [ "$STATUS" -ne 0 ]; then exit "$STATUS"; fi

step "4. 回传到 Windows 工程"
OUT="$WIN_ROOT/mirror/packages-linux"
mkdir -p "$OUT"
cp -f "$BUILD_ROOT"/mirror/packages/*.tgz "$OUT/" 2>/dev/null
cp -f "$BUILD_ROOT/mirror/manifest.json" "$WIN_ROOT/mirror/manifest-linux.json"

echo
echo "=== 结果 ==="
ls -1sh "$OUT" | tail -n +1
echo "退出码: $STATUS"
