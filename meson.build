project('koya-shell', 'cpp', 'c', version: '0.1.0',
  default_options: ['cpp_std=c++17', 'warning_level=2'])
deps = [dependency('gio-unix-2.0'), dependency('libevdev'), dependency('libudev')]
coordinator = executable('koya-session', 'native/session.cpp', dependencies: deps)
executable('koya-launch-app', 'native/launch-app.cpp', dependencies: dependency('gio-unix-2.0'))
executable('koya-render-icon', 'native/render-icon.cpp', dependencies: dependency('gio-unix-2.0'))
hyprland_display = executable('koya-hyprland-display', 'native/hyprland-display.cpp', dependencies: dependency('gio-unix-2.0'))
if get_option('integration_tests')
  bash = find_program('bash')
  find_program('dbus-run-session')
  find_program('socat')
  coordinator_test = executable('koya-session-test', 'native/session.cpp', dependencies: deps,
    cpp_args: ['-DKOYA_TESTING'])
  hyprland_display_test = executable('koya-hyprland-display-test', 'native/hyprland-display.cpp',
    dependencies: dependency('gio-unix-2.0'), cpp_args: ['-DKOYA_TESTING'])
  foreach name : ['session', 'hyprland', 'status', 'keyboard', 'wifi', 'settings', 'rotation']
    test(name + '-integration', bash,
      args: [files('tests/run.sh'), name, meson.current_build_dir()],
      depends: [coordinator_test, hyprland_display_test, hyprland_display], timeout: 75)
  endforeach
endif
