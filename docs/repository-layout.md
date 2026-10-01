# Repository layout

| Area | Files | What to change here |
| --- | --- | --- |
| Interface | `apps/`, `assets/` | Screens, controls, artwork and JavaScript controllers |
| Native integration | `native/modules/`, `native/session.cpp` | Desktop discovery, devices, authentication and session policy |
| Applications | `applications/` | Desktop entries for the bundled apps |
| Phone session | `scripts/`, `hyprland.conf.in`, `session.conf` | Startup, compositor configuration and default settings |
| Installation | `install.sh`, `install/` | Packages, deployment and device setup |
| Desktop development | `local-dev.sh`, `dev/` | Nested session, mock phone services and development tools |
| Tests | `tests/`, `install/tests/`, `dev/tests/` | Application, installer and development checks |

`apps/platform.js` connects the shell to phone-specific Helix modules:
`Module/desktop` for applications and icons, `Module/linux-device` for buttons
and device status, and `Module/polkit-agent` for authentication. Their source is
in `native/modules/`. The shared credential input uses `Module/credentials` for
PIN derivation and the upstream `Module/pam` for account authentication. DBus and
Hyprland IPC use the plugins supplied by Helix.

Start with `./local-dev.sh` to try changes on a desktop. See the
[development guide](local-development.md) for setup and controls, and
[tests/README.md](../tests/README.md) for running the application tests.
Native application builds use `build/`; development builds and logs use
`dev/.build/`.
