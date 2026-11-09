#!/usr/bin/env bash
# 换成 glibc-2.17 构建的 node，并扫描所有插件里的原生模块的 glibc 依赖
set -uo pipefail
export PATH="$HOME/tools/node-v22.22.3-linux-x64/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

VER=v22.22.3
CACHE="$HOME/.cache/dsh-node"
WIN=/mnt/d/dsh_store_plugin
DEST="$WIN/runtime/node"
mkdir -p "$CACHE" "$DEST/bin"

TAR="$CACHE/node-$VER-linux-x64-glibc-217.tar.gz"
if [ ! -s "$TAR" ]; then
  echo "下载 $VER glibc-217 ..."
  curl -fsSL -m 3600 -o "$TAR" \
    "https://unofficial-builds.nodejs.org/download/release/$VER/node-$VER-linux-x64-glibc-217.tar.gz" || exit 1
fi
ls -lh "$TAR"

TMP=$(mktemp -d)
tar -xzf "$TAR" -C "$TMP"
SRC="$TMP/node-$VER-linux-x64-glibc-217"

echo "=== glibc-217 版 node 自身需要的 glibc ==="
readelf --version-info "$SRC/bin/node" | grep -o 'GLIBC_[0-9.]*' | sort -u -V | tail -4

cp -f "$SRC/bin/node" "$DEST/bin/node"
chmod 755 "$DEST/bin/node"
echo "$VER (glibc-217)" > "$DEST/VERSION"
[ -f "$SRC/LICENSE" ] && cp -f "$SRC/LICENSE" "$DEST/LICENSE"
"$DEST/bin/node" -v
rm -rf "$TMP"

echo
echo "=== 扫描插件里的原生模块（*_linux*.node / 非 prebuilds 目录）==="
SCAN=$(mktemp -d)
for tgz in "$WIN"/mirror/packages-linux/*.tgz; do
  name=$(basename "$tgz" .tgz)
  # 只取 .node 结尾的文件列表
  list=$(tar -tzf "$tgz" 2>/dev/null | grep '\.node$' || true)
  [ -z "$list" ] && continue
  echo "--- $name"
  while read -r f; do
    [ -z "$f" ] && continue
    out="$SCAN/x.node"
    tar -xzf "$tgz" -C "$SCAN" --strip-components=1 "$f" 2>/dev/null || continue
    [ -f "$SCAN/x.node" ] || continue
    maxv=$(readelf --version-info "$SCAN/x.node" 2>/dev/null | grep -o 'GLIBC_[0-9.]*' | sed 's/GLIBC_//' | sort -V | tail -1)
    rm -f "$SCAN/x.node"
    printf '    %-18s glibc<=%s\n' "$(basename "$f" | cut -c1-18)" "${maxv:-?}"
  done <<< "$list"
done
rm -rf "$SCAN"
