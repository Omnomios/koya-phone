project('koya-phone-dev', 'cpp', 'c', version: '0.1.0',
  default_options: ['cpp_std=c++17', 'warning_level=2'])

# Development depends on the application's native sources. The application
# build and phone deployment have no dependency on this environment.
gio = dependency('gio-unix-2.0')
deps = [gio, dependency('libevdev'), dependency('libudev'), dependency('polkit-agent-1')]
coordinator = executable('koya-session-dev', '../native/session.cpp',
  dependencies: deps, cpp_args: ['-DKOYA_TESTING'])
executable('koya-askpass', '../native/askpass.cpp', dependencies: gio)
display = executable('koya-hyprland-display-dev', '../native/hyprland-display.cpp',
  dependencies: gio, cpp_args: ['-DKOYA_TESTING'])
services = executable('koya-dev-services', 'mocks/services.cpp', dependencies: gio)
fixture = executable('koya-local-dev-fixture', 'tests/fixture.cpp', dependencies: gio)
sizing = shared_library('koya-dev-wayland-size', 'wayland-size.c',
  dependencies: [dependency('wayland-client'), meson.get_compiler('c').find_library('dl')])
executable('koya-launch-app', '../native/launch-app.cpp', dependencies: gio)
executable('koya-render-icon', '../native/render-icon.cpp', dependencies: gio)

test('local-dev', find_program('bash'),
  args: [files('tests/session.sh'), meson.current_build_dir()],
  depends: [services, coordinator, display, fixture, sizing], timeout: 30)
test('koya-release', find_program('bash'), args: files('tests/release.sh'), timeout: 10)
test('container-launcher', find_program('bash'), args: files('tests/container.sh'), timeout: 10)
