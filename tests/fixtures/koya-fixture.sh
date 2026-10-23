#!/usr/bin/env bash
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
entry=${KOYA_TEST_ENTRY:-component}
if [[ $entry == sleep ]]; then exec python3 "$root/tests/fixtures/login-sleep.py"; fi
exec "$KOYA_BIN" -n "$KOYA_PLUGIN_DIR" -m "$KOYA_ASSET_DIR" -m "$root" -i "tests/fixtures/$entry.js" </dev/null
