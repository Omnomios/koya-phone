#!/bin/sh
# OnePlus 6 / postmarketOS replacement-battery register-map workaround.
set -eu

fail() { printf 'fix-battery-gauge: %s\n' "$*" >&2; exit 1; }

init_paths() {
    tree=/sys/firmware/devicetree/base
    devices=/sys/bus/i2c/devices
    os_release=/etc/os-release
    node=/soc@0/geniqup@ac0000/i2c@a88000/bq27441-battery@55
    dtb=/boot/dtbs/qcom/sdm845-oneplus-enchilada.dtb
    deployed=/boot/sdm845-oneplus-enchilada.dtb
    boot=/boot/boot.img
    backups=/var/lib/koya-shell/battery-gauge-backups
    lock=/run/koya-battery-gauge.lock.d
    old=ti,bq27411
    new=ti,bq27541
}

cleanup() {
    status=$?
    trap - 0
    [ -z "$temporary" ] || rm -f "$temporary"
    temporary=
    if [ "$restore" = 1 ]; then
        if atomic_copy "$backup/source.dtb" "$dtb"; then
            printf 'Source DTB restored. Boot deployment may be partial.\n' >&2
        else
            printf 'Source DTB restoration failed.\n' >&2
        fi
        printf 'Recovery files: %s\nSuccessfully rebuild with mkinitfs before rebooting.\n' "$backup" >&2
        status=1
    fi
    [ -z "$temporary" ] || rm -f "$temporary"
    [ -z "$work" ] || rm -rf "$work"
    [ "$locked" = 0 ] || rmdir "$lock"
    exit "$status"
}

atomic_copy() {
    temporary=$(mktemp "${2}.koya.XXXXXX") || return 1
    cp -p "$1" "$temporary" || return 1
    mv -f "$temporary" "$2" || return 1
    temporary=
}

discover_gauge() {
    grep -Eq "^ID=(postmarketos|\"postmarketos\"|'postmarketos')$" "$os_release" ||
        fail 'This utility targets postmarketOS'
    tr '\000' '\n' < "$tree/compatible" | grep -Fxq oneplus,enchilada ||
        fail 'This utility targets the OnePlus 6 (enchilada)'
    count=0
    for device in "$devices"/*-0055; do
        [ -e "$device/of_node" ] || continue
        [ "$(readlink -f "$device/of_node")" = "$(readlink -f "$tree$node")" ] || continue
        live=$(tr -d '\000' < "$device/of_node/compatible")
        case "$live" in "$old"|"$new") ;; *) fail 'Unexpected fuel-gauge configuration' ;; esac
        bus=${device##*/}; bus=${bus%-0055}
        case "$bus" in ''|*[!0-9]*) fail 'Invalid I2C bus number' ;; esac
        count=$((count + 1))
    done
    [ "$count" = 1 ] || fail 'Expected exactly one supported gauge at address 0x55'
}

read_word() {
    response=$(i2ctransfer -f -y "$bus" w1@0x55 "$1" r2) || fail 'I2C read failed'
    # Accept exactly two hexadecimal bytes; never evaluate arbitrary tool output.
    set -f
    set -- $response
    [ "$#" = 2 ] || fail 'Incomplete I2C response'
    for byte do
        case "$byte" in 0x[0-9a-fA-F][0-9a-fA-F]) ;; *) fail 'Invalid I2C response' ;; esac
    done
    printf '%s\n' "$(( $1 + ($2 << 8) ))"
}

device_type() {
    # DEVICE_TYPE query only: no reset, unseal, configuration or driver reprobe.
    i2ctransfer -f -y "$bus" w3@0x55 0x00 0x01 0x00 >/dev/null || fail 'DeviceType query failed'
    sleep 0.01
    read_word 0x00
}

prepare_patch() {
    cp -p "$dtb" "$work/original.dtb"
    cp -p "$dtb" "$work/patched.dtb"
    fdtput -t s "$work/patched.dtb" "$node" compatible "$new"
    [ "$(fdtget -t s "$work/patched.dtb" "$node" compatible)" = "$new" ] || fail 'DTB validation failed'
    [ "$(wc -c < "$work/original.dtb")" = "$(wc -c < "$work/patched.dtb")" ] || fail 'DTB size changed'
    if cmp -l "$work/original.dtb" "$work/patched.dtb" > "$work/differences"; then
        fail 'DTB did not change'
    else
        [ "$?" = 1 ] || fail 'DTB comparison failed'
    fi
    # cmp prints octal bytes: only ASCII 4 -> 5 and ASCII 1 -> 4 may change.
    awk 'NF != 3 {bad=1} $2 == 64 && $3 == 65 {a++; next}
         $2 == 61 && $3 == 64 {b++; next} {bad=1}
         END {exit (bad || a != 1 || b != 1)}' "$work/differences" ||
        fail 'DTB validation failed: unrelated bytes changed'
}

deploy_patch() {
    for file in "$dtb" "$deployed" "$boot"; do
        [ -f "$file" ] && [ ! -L "$file" ] || fail "Expected a regular boot file: $file"
    done
    cmp -s "$dtb" "$work/original.dtb" || fail 'Source DTB changed during preparation'
    mkdir -p "$backups"
    backup=$(mktemp -d "$backups/$(date +%Y%m%d-%H%M%S)-XXXXXX")
    cp -p "$dtb" "$backup/source.dtb"
    cp -p "$deployed" "$backup/deployed.dtb"
    cp -p "$boot" "$backup/boot.img"
    (cd "$backup" && sha256sum source.dtb deployed.dtb boot.img > SHA256SUMS)
    printf 'kernel=%s\ndevice_type=0x%04x\nlive_compatible=%s\nsource=%s\n' \
        "$(uname -r)" "$type" "$live" "$dtb" > "$backup/record.txt"
    sync
    printf 'Backup: %s\n' "$backup"
    restore=1
    atomic_copy "$work/patched.dtb" "$dtb" || fail 'Could not replace source DTB'
    mkinitfs || fail 'mkinitfs failed'
    cmp -s "$deployed" "$work/patched.dtb" || fail 'boot-deploy did not install the patched DTB'
    if cmp -s "$boot" "$backup/boot.img"; then fail 'boot-deploy did not regenerate the boot image'; fi
    restore=0
    printf 'Boot image regenerated/deployed. Reboot separately, then check battery readings.\n'
}

main() {
    mode=check
    case "$#:$*" in
        0:|1:--check) ;;
        1:--apply) mode=apply ;;
        1:--help|1:-h) ;;
        *) fail 'Usage: fix-battery-gauge.sh [--check|--apply|--help]' ;;
    esac
    if [ "${1-}" = --help ] || [ "${1-}" = -h ]; then
        printf 'Usage: fix-battery-gauge.sh [--check|--apply]\nDefault: inspect only. --apply backs up boot files, patches the DTB and runs mkinitfs.\nRequires root, dtc and i2c-tools. Never reboots automatically.\n'
        return
    fi
    [ "$(id -u)" = 0 ] || fail 'Run with sudo or doas'
    init_paths
    work= temporary= backup= restore=0 locked=0
    trap cleanup 0
    trap 'exit 130' INT
    trap 'exit 143' TERM HUP
    for tool in fdtget i2ctransfer; do
        command -v "$tool" >/dev/null || fail "Missing $tool; install dtc and i2c-tools with apk"
    done
    if [ "$mode" = apply ]; then
        for tool in fdtput mkinitfs modinfo; do
            command -v "$tool" >/dev/null || fail "Missing tool: $tool"
        done
        mkdir "$lock" 2>/dev/null || fail "Another utility is running, or stale lock exists: $lock"
        locked=1
    fi
    discover_gauge
    type=$(device_type)
    [ "$type" = "$(device_type)" ] || fail 'Inconsistent DeviceType responses'
    source=$(fdtget -t s "$dtb" "$node" compatible)
    case "$source" in "$old"|"$new") ;; *) fail "Unsupported source compatibility: $source" ;; esac
    printf 'DeviceType: 0x%04x; live: %s; source DTB: %s\n' "$type" "$live" "$source"
    case "$type" in
        1057) # 0x0421
            [ "$source" = "$old" ] || fail 'The 0x0421 gauge needs bq27411; restore its original DTB'
            printf 'No change needed: keep the bq27411 register map.\n'
            return ;;
        1345|4417) ;; # 0x0541 or the observed 0x1141
        *) fail 'Unsupported DeviceType; no boot files changed' ;;
    esac
    voltage=$(read_word 0x08); temperature=$(read_word 0x06); charge=$(read_word 0x2c)
    [ "$voltage" -ge 2500 ] && [ "$voltage" -le 5000 ] &&
    [ "$temperature" -ge 2531 ] && [ "$temperature" -le 3531 ] &&
    [ "$charge" -ge 0 ] && [ "$charge" -le 100 ] || fail 'Implausible bq27541 readings; refusing the change'
    awk -v v="$voltage" -v t="$temperature" -v c="$charge" \
        'BEGIN {printf "bq27541 readings: %.3f V, %.1f C, %d%%\n", v/1000, (t-2731)/10, c}'
    if [ "$source" = "$new" ]; then
        printf 'Source DTB already patched.\n'
        [ "$live" = "$new" ] || printf 'Reboot to activate it.\n'
        return
    fi
    if [ "$mode" = check ]; then
        printf 'Patch needed. Run again with --apply to back up and deploy the change.\n'
        return
    fi
    modinfo bq27xxx_battery_i2c | grep -Fq 'of:N*T*Cti,bq27541' || fail 'Kernel module lacks bq27541 support'
    umask 077
    work=$(mktemp -d /tmp/koya-gauge-XXXXXX)
    prepare_patch
    deploy_patch
}

main "$@"
