#!/usr/bin/env bash
# Build and run the standalone Alpine development environment.
set -euo pipefail
shell_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec bash "$shell_dir/dev/container.sh" "$@"
