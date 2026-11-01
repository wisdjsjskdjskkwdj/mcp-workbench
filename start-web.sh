#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] 未检测到 Node.js 运行环境。"
  echo "请先运行 ./install-node.sh 进行一键安装，或访问 https://nodejs.org/ 下载安装。"
  exit 1
fi

URL="http://127.0.0.1:43110/ui"
if command -v open >/dev/null 2>&1; then
  # macOS
  open "$URL" &
elif command -v xdg-open >/dev/null 2>&1; then
  # Linux
  xdg-open "$URL" &
fi

node ./dist/daemon.js
