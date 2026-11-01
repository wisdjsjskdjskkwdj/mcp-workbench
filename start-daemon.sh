#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] 未检测到 Node.js 运行环境。"
  echo "请先运行 ./install-node.sh 进行一键安装，或访问 https://nodejs.org/ 下载安装。"
  exit 1
fi

echo "==================================================="
echo "  MCP Workbench Unified Gateway (v0.3.0)"
echo "  Web Console: http://127.0.0.1:43110/ui"
echo "  MCP Endpoint: http://127.0.0.1:43110/mcp"
echo "==================================================="
echo ""

node ./dist/daemon.js
