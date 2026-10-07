#!/bin/zsh

set -e
cd "$(dirname "$0")"

PORT=4173
URL="http://127.0.0.1:${PORT}"

if ! command -v python3 >/dev/null 2>&1; then
  echo "未找到 Python 3，无法启动本地网站。"
  echo "按回车键退出。"
  read -r
  exit 1
fi

echo "正在启动小太阳工作轨迹……"
echo "本地地址：${URL}"
echo "关闭此窗口即可停止本地服务。"

python3 -m http.server "${PORT}" --bind 127.0.0.1 &
SERVER_PID=$!
trap 'kill "${SERVER_PID}" 2>/dev/null || true' EXIT INT TERM

sleep 1
open "${URL}"
wait "${SERVER_PID}"
