#!/usr/bin/env bash
# 手动把某个仓库的源码包拉到 .mirror-work 下（给大仓库/慢网兜底）
#   wsl bash wsl-fetch-source.sh whyihaveyou/dsh-suite dsh-suite main
set -uo pipefail
export PATH="$HOME/.npm-global/bin:$HOME/tools/node-v22.22.3-linux-x64/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

REPO="${1:?用法: wsl-fetch-source.sh <owner/repo> <id> [branch]}"
ID="${2:?缺少 id}"
BRANCH="${3:-main}"
DEST="$HOME/store-linux/.mirror-work/$ID"
TMP="/tmp/$ID.tgz"

mkdir -p "$(dirname "$DEST")"
echo "下载 https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH"
curl -fsSL -C - --retry 3 --retry-delay 3 -m 1800 -o "$TMP" \
  "https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH" || { echo "下载失败"; exit 1; }
ls -lh "$TMP"

rm -rf "$DEST"
mkdir -p "$DEST"
tar -xzf "$TMP" -C "$DEST" --strip-components=1 || { echo "解包失败"; exit 1; }
rm -f "$TMP"
echo "解包完成：$DEST"
ls -1 "$DEST" | head -12
