#!/usr/bin/env bash
# 把一份 Linux x64 的 Node 运行时取到 runtime/node/，让目标服务器不需要预装 Node
#
#   wsl bash scripts/fetch-node-runtime.sh [版本]
#
# 只保留 bin/node + LICENSE，够跑这个零依赖服务即可。
set -uo pipefail
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

VER="${1:-v22.22.3}"
WIN_ROOT=/mnt/d/dsh_store_plugin
DEST="$WIN_ROOT/runtime/node"
CACHE="$HOME/.cache/dsh-node"

mkdir -p "$CACHE" "$DEST/bin"

TAR="$CACHE/node-$VER-linux-x64.tar.xz"
if [ ! -s "$TAR" ]; then
  echo "下载 node $VER ..."
  curl -fsSL -C - --retry 3 --retry-delay 3 -m 1800 -o "$TAR" \
    "https://nodejs.org/dist/$VER/node-$VER-linux-x64.tar.xz" || {
      echo "主站失败，改用 npmmirror"
      curl -fsSL -C - --retry 3 -m 1800 -o "$TAR" \
        "https://cdn.npmmirror.com/binaries/node/$VER/node-$VER-linux-x64.tar.xz" || exit 1
    }
fi

echo "解包 ..."
TMP=$(mktemp -d)
tar -xf "$TAR" -C "$TMP"
SRC="$TMP/node-$VER-linux-x64"

cp -f "$SRC/bin/node" "$DEST/bin/node"
chmod 755 "$DEST/bin/node"
[ -f "$SRC/LICENSE" ] && cp -f "$SRC/LICENSE" "$DEST/LICENSE"
echo "$VER" > "$DEST/VERSION"

rm -rf "$TMP"
echo "完成：$DEST"
ls -lh "$DEST/bin/node"
"$DEST/bin/node" -v
