#!/bin/bash
# start-nanoclaw.sh — Start NanoClaw without systemd
# To stop: kill \$(cat /workspace/NanoClaw/src/nanoclaw/nanoclaw.pid)

set -euo pipefail

cd "/workspace/NanoClaw/src/nanoclaw"

ROOT_LOG_DIR="/workspace/NanoClaw/logs"
LOG_FILE="$ROOT_LOG_DIR/nanoclaw.log"
ERROR_LOG_FILE="$ROOT_LOG_DIR/nanoclaw.error.log"

mkdir -p "$ROOT_LOG_DIR"

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
# Detach fully from the invoking shell so the process survives non-interactive
# sessions in devcontainers where plain nohup can become a zombie immediately.
setsid "/usr/bin/node" "/workspace/NanoClaw/src/nanoclaw/dist/index.js" \
  < /dev/null \
  >> "$LOG_FILE" \
  2>> "$ERROR_LOG_FILE" &

echo $! > "/workspace/NanoClaw/src/nanoclaw/nanoclaw.pid"
echo "NanoClaw started (PID $!)"
echo "Logs: tail -f $LOG_FILE"
