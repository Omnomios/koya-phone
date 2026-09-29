# Repository layout

| Domain | Files | Responsibility |
| --- | --- | --- |
| Shell application | `apps/`, `assets/`, `native/`, `applications/` | UI, native coordinator, compositor adapter and desktop integration |
| Phone runtime | `scripts/`, `run.sh`, `start-hyprland.sh`, `hyprland.conf.in`, `session.conf` | Start and configure the installed shell |
| Phone deployment | `install.sh`, `install/` | Bootstrap postmarketOS, declare packages, deploy the shell and maintain device setup |
| Development environment | `dev/`, `local-dev.sh` | Alpine image, Koya repository setup, nested session, mock services, asset tools and development checks |
| Application build and checks | Root `meson.build`, `meson_options.txt`, `tests/` | Build and test the phone application |

The public development entry point is `./local-dev.sh`. It delegates to `dev/`.
`dev/meson.build` is an independent project that compiles the application's
native sources for development and adds private mock services. The phone's
Meson project does not reference the development environment.

`install.sh` remains a standalone bootstrap so the documented `curl | sh`
installation works. It packages an explicit set of application and phone
runtime files. The container, development mocks and development checks are
excluded from phone deployments. Deployment checks live under `install/tests/`
and run with `sh install/check.sh` using offline fixtures.

Development builds and logs live under the ignored `dev/.build/` directory.
Application builds use `build/`. Both domains own their build outputs.
