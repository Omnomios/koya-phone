#!/usr/bin/env bash
set -euo pipefail
run=${XDG_RUNTIME_DIR:?}
if [[ $1 == events ]]; then
  # A separate cursor per IPC peer preserves fragmented writes.
  exec tail -c +1 -f -s .02 "$run/events"
fi
command=
IFS= read -r -t .02 -n 65536 command || true
printf '%s\n' "$command" >>"$run/commands"
case "$command" in
  j/monitors) on=false; [[ $(cat "$run/dpms") == 1 ]] && on=true; printf '[{"name":"DSI-1","dpmsStatus":%s,"width":1080,"height":2280,"refreshRate":60,"x":10,"y":20,"scale":2,"transform":%s}]' "$on" "$(cat "$run/transform")";;
  j/workspaces) workspace=$(cat "$run/workspace"); printf '[{"id":%s,"name":"%s"}]' "$workspace" "$workspace";;
  j/activeworkspace) workspace=$(cat "$run/workspace"); printf '{"id":%s,"name":"%s"}' "$workspace" "$workspace";;
  j/clients) cat "$run/clients";;
  'dispatch workspace '*)
    target=${command##* }
    if [[ $target == "$(cat "$run/workspace")" ]]; then printf "Previous workspace doesn't exist";
    else printf '%s\n' "$target" >"$run/workspace"; printf ok; fi;;
  'dispatch dpms on'|'dispatch dpms off')
    if [[ -f $run/reject-dpms ]]; then printf unsupported;
    else on=0; [[ $command == 'dispatch dpms on' ]] && on=1; printf '%s\n' "$on" >"$run/dpms"; printf ok; fi;;
  'dispatch exec '*|'dispatch closewindow address:'*|'dispatch focuswindow address:'*) printf ok;;
  'keyword monitor DSI-1,1080x2280@60,10x20,2,transform,'*) printf '%s\n' "${command##*,}" >"$run/transform"; printf ok;;
  *) printf ok;;
esac
