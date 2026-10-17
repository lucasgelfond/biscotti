#!/bin/sh
# Cold headless Firefox page loads with a fresh profile per run. Same script in every runtime.
# Usage: firefox-in-vm.sh <label>   (runs as root inside the sandbox; prints "BENCH <label> <url> <secs>")
label=${1:-firecracker}
sleep 5
i=0
for url in https://example.com https://example.com https://en.wikipedia.org/wiki/Biscotti https://en.wikipedia.org/wiki/Biscotti; do
  i=$((i + 1)); p=/tmp/ffprofile$i
  rm -rf $p; runuser -u cua -- mkdir -p $p
  s=$(date +%s.%N)
  timeout 60 runuser -u cua -- firefox-esr --headless --no-remote --profile $p --screenshot /tmp/shot$i.png "$url" >/dev/null 2>&1
  echo "BENCH $label $url $(awk "BEGIN{printf \"%.1f\", $(date +%s.%N) - $s}")s rc=$?"
done
