#!/usr/bin/env bash
# 码上取 启动脚本（Linux / macOS）
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 未找到 Node.js，请先安装: https://nodejs.org"
  exit 1
fi
echo "正在启动码上取..."
echo "启动后打开 http://localhost:8000"
exec node server.js
