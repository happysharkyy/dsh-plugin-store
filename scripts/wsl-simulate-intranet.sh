#!/usr/bin/env bash
# 模拟「内网 Linux 服务器、没装 Node」：解包后用 start.sh 起服务并验证
set -uo pipefail
# 刻意使用系统 PATH，里面没有 node —— 验证包内运行时能被正确选中
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

ARCHIVE=$(ls -t /mnt/d/dsh_store_plugin/dist/*.tgz 2>/dev/null | head -1)
WORK="$HOME/intranet-sim"

echo "=== 归档 ==="
echo "$ARCHIVE"
echo "=== 系统里有没有 node ==="
command -v node || echo "(没有 node，符合预期)"

rm -rf "$WORK"; mkdir -p "$WORK"
echo "=== 解包 ==="
tar -xzf "$ARCHIVE" -C "$WORK"
APP="$WORK/dsh-plugin-store"
echo "start.sh 权限: $(stat -c '%a' "$APP/start.sh")"

echo "=== 用 start.sh 启动 ==="
cd "$APP"
PORT=8855 ./start.sh > /tmp/store-sim.log 2>&1 &
sleep 8
head -8 /tmp/store-sim.log || true

echo "=== 接口验证 ==="
for p in /api/health /api/stats / /admin; do
  code=$(curl -sS -m 15 -o /dev/null -w '%{http_code}' "http://127.0.0.1:8855$p")
  echo "  $p -> $code"
done

echo "=== 下载一个插件包 ==="
curl -sS -m 60 -o /tmp/p.tgz -w '  %{http_code} %{size_download} bytes\n' http://127.0.0.1:8855/packages/ops-0.5.2.tgz
tar -tzf /tmp/p.tgz | head -4

pkill -f 'server.mjs' 2>/dev/null
echo "=== 完成 ==="
