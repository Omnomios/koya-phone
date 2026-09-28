#!/bin/sh
# Offline boot-file fixtures and mocked I2C/deployment; no hardware access.
set -eu
shell_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
test_dir=$(mktemp -d /tmp/koya-gauge-test-XXXXXX)
trap 'rm -rf "$test_dir"' 0
export TEST_GAUGE_DIR="$test_dir"
sh -n "$shell_root/scripts/fix-battery-gauge.sh"
sh "$shell_root/scripts/fix-battery-gauge.sh" --help >/dev/null
if sh "$shell_root/scripts/fix-battery-gauge.sh" --unknown >/dev/null 2>&1; then exit 1; fi
for tool in dtc fdtget fdtput; do
    command -v "$tool" >/dev/null || { printf 'SKIP: DTB fixtures require dtc\n'; exit 77; }
done
sed '$d' "$shell_root/scripts/fix-battery-gauge.sh" > "$test_dir/library.sh"
cat > "$test_dir/source.dts" <<'DTS'
/dts-v1/;
/ {
    compatible = "oneplus,enchilada";
    unrelated-setting = "preserve-me";
    soc@0 { geniqup@ac0000 { i2c@a88000 { bq27441-battery@55 {
        compatible = "ti,bq27411";
        reg = <0x55>;
    }; }; }; };
};
DTS
dtc -I dts -O dtb -o "$test_dir/original.dtb" "$test_dir/source.dts" 2>/dev/null
cat > "$test_dir/case.sh" <<'CASE'
#!/bin/sh
set -eu
. "$TEST_GAUGE_DIR/library.sh"
kind=$1
case_dir=$TEST_GAUGE_DIR/$kind
mkdir "$case_dir"
cp "$TEST_GAUGE_DIR/original.dtb" "$case_dir/source.dtb"
cp "$case_dir/source.dtb" "$case_dir/deployed.dtb"
printf 'original boot' > "$case_dir/boot.img"
init_paths() {
    node=/soc@0/geniqup@ac0000/i2c@a88000/bq27441-battery@55
    dtb=$case_dir/source.dtb deployed=$case_dir/deployed.dtb boot=$case_dir/boot.img
    backups=$case_dir/backups lock=$case_dir/lock old=ti,bq27411 new=ti,bq27541
}
id() { printf '0\n'; }
discover_gauge() { bus=10 live=ti,bq27411; }
modinfo() { printf 'alias: of:N*T*Cti,bq27541\n'; }
sync() { :; }
i2ctransfer() {
    [ "$1:$2:$3" = '-f:-y:10' ] || exit 1
    case "$4" in
        w3@0x55)
            [ "$5:$6:$7" = '0x00:0x01:0x00' ] && [ "$#" = 7 ] || exit 1
            printf 'query\n' >> "$case_dir/queries" ;;
        w1@0x55)
            [ "$6" = r2 ] && [ "$#" = 6 ] || exit 1
            case "$5" in
                0x00)
                    case "$kind" in
                        correct) printf '0x21 0x04\n' ;;
                        standard) printf '0x41 0x05\n' ;;
                        unknown) printf '0x99 0x99\n' ;;
                        malformed) printf 'garbage\n' ;;
                        inconsistent)
                            if [ "$(wc -l < "$case_dir/queries")" = 1 ]; then
                                printf '0x41 0x11\n'
                            else printf '0x41 0x05\n'; fi ;;
                        *) printf '0x41 0x11\n' ;;
                    esac ;;
                0x08)
                    if [ "$kind" = invalid ]; then printf '0xff 0xff\n'; else printf '0x29 0x11\n'; fi ;;
                0x06) printf '0x90 0x0b\n' ;;
                0x2c) printf '0x64 0x00\n' ;;
                *) exit 1 ;;
            esac ;;
        *) exit 1 ;;
    esac
}
mkinitfs() {
    printf 'called\n' > "$case_dir/mkinitfs"
    case "$kind" in
        failure) printf 'partial deployment' > "$boot"; return 1 ;;
        bad-deploy) return 0 ;;
        *) cp "$dtb" "$deployed"; printf 'patched boot' > "$boot" ;;
    esac
}
case "$kind" in
    patched) init_paths; fdtput -t s "$dtb" "$node" compatible "$new" ;;
    locked) mkdir "$case_dir/lock" ;;
esac
case "$kind" in check) main --check ;; *) main --apply ;; esac
CASE
for kind in check correct patched apply standard unknown malformed inconsistent invalid locked failure bad-deploy; do
    expected=0
    case "$kind" in unknown|malformed|inconsistent|invalid|locked|failure|bad-deploy) expected=1 ;; esac
    status=0
    sh "$test_dir/case.sh" "$kind" > "$test_dir/$kind.log" 2>&1 || status=$?
    if [ "$status" != "$expected" ]; then
        cat "$test_dir/$kind.log"
        printf 'FAIL: %s status=%s expected=%s\n' "$kind" "$status" "$expected" >&2
        exit 1
    fi
    case "$kind" in
        apply|standard)
            [ "$(fdtget -t s "$test_dir/$kind/source.dtb" /soc@0/geniqup@ac0000/i2c@a88000/bq27441-battery@55 compatible)" = ti,bq27541 ]
            cmp -s "$test_dir/$kind/source.dtb" "$test_dir/$kind/deployed.dtb"
            [ -f "$test_dir/$kind/mkinitfs" ] ;;
        patched) [ ! -e "$test_dir/$kind/mkinitfs" ] ;;
        *) cmp -s "$test_dir/original.dtb" "$test_dir/$kind/source.dtb" ;;
    esac
    case "$kind" in
        apply|standard|failure|bad-deploy)
            set -- "$test_dir/$kind/backups/"*
            [ "$#" = 1 ]
            cmp -s "$test_dir/original.dtb" "$1/source.dtb"
            [ "$(cat "$1/boot.img")" = 'original boot' ]
            (cd "$1" && sha256sum -c SHA256SUMS >/dev/null)
            [ "$(stat -c %a "$1")" = 700 ] ;;
        *) [ ! -d "$test_dir/$kind/backups" ]; [ ! -e "$test_dir/$kind/mkinitfs" ] ;;
    esac
    case "$kind" in
        failure|bad-deploy) grep -q 'Boot deployment may be partial' "$test_dir/$kind.log" ;;
    esac
    [ "$kind" = locked ] || [ ! -e "$test_dir/$kind/lock" ]
done
# Exercise exact byte validation with the real DTB tools.
( . "$test_dir/library.sh"
  init_paths
  dtb=$test_dir/original.dtb work=$test_dir/byte-check
  mkdir "$work"
  prepare_patch
  cmp -l "$dtb" "$work/patched.dtb" > "$test_dir/diff" || [ "$?" = 1 ]
  [ "$(wc -l < "$test_dir/diff")" = 2 ]
)
printf 'PASS: shell gauge detection, no-op reruns, DTB validation, backups and deployment recovery\n'
