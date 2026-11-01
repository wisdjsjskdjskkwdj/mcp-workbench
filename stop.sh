#!/usr/bin/env bash
cd "$(dirname "$0")"

echo "[INFO] 正在关闭 MCP Workbench 守护进程 (端口 43110)..."

PID=$(lsof -ti:43110 2>/dev/null || true)
if [ -n "$PID" ]; then
  kill -9 $PID 2>/dev/null || true
fi

if [ -f ".workbench-daemon.lock.json" ]; then
  rm -f ".workbench-daemon.lock.json"
fi

echo "[OK] MCP Workbench 守护进程已停止，Web 控制台已关闭。"
