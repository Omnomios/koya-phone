#!/usr/bin/env bash
set -euo pipefail
IFS= read -r current
IFS= read -r next
[[ $# == 0 ]]
[[ "$current" == fixture-current && ${#next} -ge 8 ]] || { printf 'denied\n'; exit 2; }
sleep .3
printf 'changed\n'
