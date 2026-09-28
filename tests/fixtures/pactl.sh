#!/bin/sh
# Private test backend: no connection to the phone's audio server.
set -eu
volume_dir="${XDG_CACHE_HOME:?}/volume-fixture"
mkdir -p "$volume_dir"
if [ ! -f "$volume_dir/left" ]; then
    printf '%s\n' 42598 > "$volume_dir/left"
    printf '%s\n' 21299 > "$volume_dir/right"
    printf '%s\n' 0 > "$volume_dir/mute"
fi
[ -p "$volume_dir/events" ] || mkfifo "$volume_dir/events" 2>/dev/null || :
case "$1" in
    subscribe)
        exec 3<>"$volume_dir/events"
        exec cat <&3 ;;
    get-default-sink) printf '%s\n' fixture-speaker ;;
    --format=json)
        printf '[{"index":1,"name":"fixture-speaker","description":"Test speaker","mute":%s,"volume":{"left":{"value":%s},"right":{"value":%s}}}]\n' \
            "$( [ "$(cat "$volume_dir/mute")" = 1 ] && printf true || printf false )" \
            "$(cat "$volume_dir/left")" "$(cat "$volume_dir/right")" ;;
    set-sink-volume)
        printf '%s %s %s\n' "$1" "$3" "$4" >> "$volume_dir/commands"
        awk -v percent="$3" 'BEGIN { printf "%.0f\n", percent * 65536 / 100 }' > "$volume_dir/left"
        awk -v percent="$4" 'BEGIN { printf "%.0f\n", percent * 65536 / 100 }' > "$volume_dir/right"
        printf "Event 'change' on sink #1\n" > "$volume_dir/events" ;;
    set-sink-mute)
        printf '%s\n' "$3" > "$volume_dir/mute"
        printf "Event 'change' on sink #1\n" > "$volume_dir/events" ;;
    *) exit 2 ;;
esac
