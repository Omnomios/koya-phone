#!/usr/bin/env bash
set -euo pipefail
export KOYA_TEST_ENTRY=component
export KOYA_TEST_COMPONENT=${1:?Component name required}
exec "$(dirname -- "${BASH_SOURCE[0]}")/koya-fixture.sh" "$@"
