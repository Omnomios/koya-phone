#!/usr/bin/env bash
set -euo pipefail
IFS= read -r current
IFS= read -r next
[[ $# == 0 ]]
[[ ( "$current" == fixture-current || "$current" == fixture-long-current-* ) && -n "$next" ]] || { printf 'unchanged\n'; exit 2; }
[[ "$next" != fixture-ambiguous ]] || { printf 'denied\n'; exit 3; }
sleep .3
printf 'changed\n'
