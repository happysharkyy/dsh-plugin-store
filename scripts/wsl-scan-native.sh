#!/usr/bin/env bash
# 扫描每个插件包里的 .node 原生模块，报告它们需要的最高 glibc 版本
set -uo pipefail
export PATH="$HOME/tools/node-v22.22.3-linux-x64/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
WIN=/mnt/d/dsh_store_plugin
SCAN=$(mktemp -d)
ONLY="${1:-}"   # 可选：只扫名字里包含该字符串的包

printf '%-22s %-52s %s\n' "插件" "原生模块" "需要 glibc"
printf '%.0s-' {1..100}; echo
RISKY=0
for tgz in "$WIN"/mirror/packages-linux/*.tgz; do
  name=$(basename "$tgz" .tgz)
  if [ -n "$ONLY" ] && [[ "$name" != *"$ONLY"* ]]; then continue; fi
  list=$(tar -tzf "$tgz" 2>/dev/null | grep '\.node$' || true)
  [ -z "$list" ] && continue
  while read -r f; do
    [ -z "$f" ] && continue
    rm -rf "$SCAN"/* 2>/dev/null
    if ! tar -xzf "$tgz" -C "$SCAN" "$f" 2>/dev/null; then continue; fi
    real=$(find "$SCAN" -name '*.node' -type f | head -1)
    [ -z "$real" ] && continue
    maxv=$(readelf --version-info "$real" 2>/dev/null | grep -o 'GLIBC_[0-9.]*' | sed 's/GLIBC_//' | sort -V | tail -1)
    short=$(basename "$f")
    [ ${#short} -gt 50 ] && short="…${short: -48}"
    flag=""
    if [ -n "${maxv}" ]; then
      if [ "$(printf '%s\n2.17\n' "$maxv" | sort -V | tail -1)" = "$maxv" ] && [ "$maxv" != "2.17" ]; then
        flag="  <<< 超 2.17"
        RISKY=$((RISKY+1))
      fi
    fi
    printf '%-22s %-52s %s%s\n' "$name" "$short" "${maxv:-?}" "$flag"
  done <<< "$list"
done
rm -rf "$SCAN"
echo
echo "超出 glibc 2.17 的原生模块：$RISKY 个"
