#!/bin/bash
# start-nanoclaw.sh — Start NanoClaw without systemd
# To stop: kill \$(cat /workspace/NanoClaw/src/nanoclaw/nanoclaw.pid)

set -euo pipefail

cd "/workspace/NanoClaw/src/nanoclaw"

# Stop existing instance if running
if [ -f "/workspace/NanoClaw/src/nanoclaw/nanoclaw.pid" ]; then
  OLD_PID=$(cat "/workspace/NanoClaw/src/nanoclaw/nanoclaw.pid" 2>/dev/null || echo "")
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Stopping existing NanoClaw (PID $OLD_PID)..."
    kill "$OLD_PID" 2>/dev/null || true
    sleep 2
  fi
fi

echo "Starting NanoClaw..."
nohup "/usr/bin/node" "/workspace/NanoClaw/src/nanoclaw/dist/index.js" \
  >> "/workspace/NanoClaw/src/nanoclaw/logs/nanoclaw.log" \
  2>> "/workspace/NanoClaw/src/nanoclaw/logs/nanoclaw.error.log" &

echo $! > "/workspace/NanoClaw/src/nanoclaw/nanoclaw.pid"
echo "NanoClaw started (PID $!)"
echo "Logs: tail -f /workspace/NanoClaw/src/nanoclaw/logs/nanoclaw.log"
