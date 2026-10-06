#!/bin/sh
# Daily monitor run: tests -> dashboard -> artifact bundle. Invoked by launchd.
cd "$(dirname "$0")/.." || exit 1
export PATH="$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"
echo "=== $(date -u +%FT%TZ) start"
RUN_TRIGGER=scheduled npm run monitor
code=$?
node scripts/build-dashboard.mjs --artifact
echo "=== $(date -u +%FT%TZ) end (exit $code)"
exit $code
