#!/bin/bash
# Time from `docker run` until the desktop is usable (X up, noVNC and cua-spacesd listening).
# Usage: bench/ready.sh [runtime]   e.g. runc (default), runsc
set -euo pipefail
RUNTIME=${1:-runc}
NAME=bench-$RUNTIME

docker rm -f "$NAME" >/dev/null 2>&1 || true
start=$(date +%s.%N)
docker run -d --name "$NAME" --runtime "$RUNTIME" -p 127.0.0.1::6901 biscotti/cua-desktop:dev >/dev/null
until docker exec "$NAME" bash -c 'xdpyinfo -display :1 >/dev/null 2>&1 && </dev/tcp/127.0.0.1/6901 && </dev/tcp/127.0.0.1/3211' 2>/dev/null; do
  sleep 0.2
done
end=$(date +%s.%N)

echo "$RUNTIME ready in $(awk "BEGIN{printf \"%.1f\", $end - $start}")s, RAM $(docker stats --no-stream --format '{{.MemUsage}}' "$NAME" | cut -d/ -f1)"
