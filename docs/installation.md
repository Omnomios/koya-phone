# Installation

## Requirements

Start with a postmarketOS installation with working device drivers, display,
audio and internet access.

| Requirement | Supported configuration |
| --- | --- |
| Distribution | postmarketOS v25.12 or newer, with apk-tools 3 or newer |
| Architecture | aarch64 or x86_64 |
| Compositor packages | Hyprland 0.51.x available in the configured repositories |
| Device | OnePlus 6 (`enchilada`); other devices use a generic profile and need working hardware support |
| Installer access | `curl` and permission to use `sudo` or `doas`, or a root shell |

The installer installs its build tools, Koya and other dependencies. It adds the
signed [Koya Alpine repository](https://www.koya-ui.com/repository/alpine) with the
`@koya` tag and authenticates its APK key against the pinned Koya signing key.
`apk` verifies the repository index and packages. Existing distribution repository
branches and device configuration are retained.
The installer sets feedbackd's `quiet` profile for the graphical user, enabling
vibration feedback without sound.

## Install

Run as the intended graphical login user:

```sh
curl -fsSL https://raw.githubusercontent.com/Omnomios/koya-phone/master/install.sh | sh
```

**Save your work first.** The installer replaces the selected graphical session
with Koya/Hyprland and starts it when installation completes. It requests
privileges as needed.

### Options

Pass options after `sh -s --`. For example, install without starting the session:

```sh
curl -fsSL https://raw.githubusercontent.com/Omnomios/koya-phone/master/install.sh |
    sh -s -- --no-start
```

| Option | Purpose |
| --- | --- |
| `--no-start` | Install and select the session, leaving tinydm stopped |
| `--no-apps` | Skip Firefox, Alacritty and extra fonts |
| `--user USER` | Select the non-root graphical user when installing from a root shell |
| `--prefix DIRECTORY` | Choose an installation directory within that user's home |
| `--ref REF` | Install a particular source branch, tag or commit |
| `--koya-version VERSION` | Choose a version still available in the Koya repo; default `latest` |
| `--help` | Show all options |

To install from a downloaded checkout, run `sh ./install.sh --source-dir .`.

## Settings and updates

The default installation directory is `~/.local/share/koya-shell/`. Its `current`
symlink selects the active release. To update, rerun the installation command.
This installs the latest available Koya and matching plugins, unless a version is
specified. Existing `session.conf` and Hyprland settings are preserved. Older
shell releases remain in the `releases` directory; each release's
`install-record.txt` records the repository and installed Koya package versions.

Edit `~/.local/share/koya-shell/current/session.conf` to change screen timeouts,
volume, brightness and vibration. Display settings are in
`/etc/koya-shell/hyprland.conf`. See the [user guide](user-guide.md#settings) for
settings and defaults.

After editing settings, save your work and restart the graphical session:

```sh
sudo rc-service tinydm restart
```

This command also starts the session after an installation with `--no-start`.

## Troubleshooting

### Installation or startup failed

Resolve the error printed by the installer and rerun it. Startup logs are in
`~/.local/state/tinydm.log`; shell logs are in `~/.local/state/koya-shell/`.
If installation changed the selected session before failing, inspect these logs
before starting tinydm.

### Vibration is missing

Refresh the device rules and restart the graphical session:

```sh
sudo udevadm control --reload-rules
sudo udevadm trigger --action=change --subsystem-match=input
sudo udevadm settle
sudo rc-service tinydm restart
```

### Firefox notifications are missing

Fully quit and reopen Firefox after installation. It needs to reload the
notification library.

### The phone does not sleep

Check that `suspend-seconds` is greater than `0` in `session.conf`. Automatic
suspend requires the phone's sleep support and session permissions. Applications
and SSH connections can inhibit sleep; close SSH connections when checking sleep
behaviour.

## OnePlus 6 battery-gauge workaround

If a replacement battery reports an unknown percentage or incorrect readings,
use [`fix-battery-gauge.sh`](../install/fix-battery-gauge.sh) to check whether it
needs a different battery-gauge configuration. The utility runs separately from
the shell installer and supports postmarketOS on the OnePlus 6 (`enchilada`).

Install its tools, download the script and check the battery:

```sh
sudo apk add dtc i2c-tools
curl -fSL https://raw.githubusercontent.com/Omnomios/koya-phone/master/install/fix-battery-gauge.sh -o /tmp/fix-battery-gauge.sh
sudo sh /tmp/fix-battery-gauge.sh --check
```

If it reports that a patch is needed:

```sh
sudo sh /tmp/fix-battery-gauge.sh --apply
sudo reboot
```

**Applying the fix writes the boot partition.** The utility backs up the boot
files before changing them and does not reboot automatically. Batteries that need
no change are left alone. After reboot, run `--check` again and confirm normal
battery readings.

If applying the fix fails, follow the error message and successfully run
`sudo mkinitfs` before rebooting. The utility attempts to restore the source
configuration, but boot deployment may be incomplete.

To undo a successful fix, replace `BACKUP` below with the directory printed by
the utility:

```sh
sudo cp /var/lib/koya-shell/battery-gauge-backups/BACKUP/source.dtb /boot/dtbs/qcom/sdm845-oneplus-enchilada.dtb
sudo mkinitfs
sudo reboot
```

Restore a backup only with the kernel it was created for. Kernel upgrades can
replace the fix; rerun `--check` after an upgrade.
