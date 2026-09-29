#!/usr/bin/env bash
# A distinct entry point keeps the real display adapter active in this test.
set -euo pipefail
exec "$(dirname -- "${BASH_SOURCE[0]}")/component.sh" "$@"
