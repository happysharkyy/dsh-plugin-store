#!/usr/bin/env bash
# 查 docling package 里 xberg 原生模块是怎么加载的
set -uo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
D="$HOME/store-linux/.mirror-work/docling"

echo "=== 含 xberg 的文件 ==="
find "$D/node_modules" -name '*xberg*' 2>/dev/null | head -10

echo
echo "=== 代码里怎么引用 ==="
grep -rln 'xberg' "$D/node_modules" --include='*.js' 2>/dev/null | head -5

echo
echo "=== 引用处上下文 ==="
for f in $(grep -rln 'xberg' "$D/node_modules" --include='*.js' 2>/dev/null | head -2); do
  echo "--- $f"
  grep -n -B3 -A6 'xberg' "$f" | head -30
done
