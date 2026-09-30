#!/bin/sh
# Offline deployment checks; never invokes the phone installer or hardware.
set -eu
install_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
sh "$install_dir/tests/install.sh"
sh "$install_dir/tests/update.sh"
status=0
sh "$install_dir/tests/battery-gauge.sh" || status=$?
[ "$status" = 0 ] || [ "$status" = 77 ] || exit "$status"
