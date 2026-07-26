#!/bin/sh
set -eu

PORT=8080 /app/server &
API_PID=$!

cd /app/web
PORT=3000 node server.js &
WEB_PID=$!

term() {
  kill -TERM "$API_PID" "$WEB_PID" 2>/dev/null || true
  wait "$API_PID" 2>/dev/null || true
  wait "$WEB_PID" 2>/dev/null || true
}

trap term INT TERM

while kill -0 "$API_PID" 2>/dev/null && kill -0 "$WEB_PID" 2>/dev/null; do
  sleep 1
done

term
exit 1
