#!/usr/bin/env bash
set -euo pipefail
export KOYA_TEST_ENTRY=keyboard
exec "$(dirname -- "${BASH_SOURCE[0]}")/koya-fixture.sh"
