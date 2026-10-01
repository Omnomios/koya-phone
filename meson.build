project('koya-shell', 'cpp', 'c', version: '0.1.0',
  default_options: ['cpp_std=c++17', 'warning_level=2'])
gio = dependency('gio-unix-2.0')
crypto = dependency('libcrypto')
deps = [gio]
phone_testing = false
subdir('native/modules')
executable('koya-credential-update', 'native/credential-update.cpp', dependencies: [crypto, meson.get_compiler('cpp').find_library('pam')])
coordinator = executable('koya-session', 'native/session.cpp', dependencies: deps)
executable('koya-update-service', 'native/update-service.cpp', dependencies: dependency('gio-unix-2.0'))
askpass = executable('koya-askpass', 'native/askpass.cpp', dependencies: dependency('gio-unix-2.0'))
executable('koya-launch-app', 'native/launch-app.cpp', dependencies: dependency('gio-unix-2.0'))
executable('koya-render-icon', 'native/render-icon.cpp', dependencies: dependency('gio-unix-2.0'))
hyprland_display = executable('koya-hyprland-display', 'native/hyprland-display.cpp', dependencies: dependency('gio-unix-2.0'))
if get_option('integration_tests')
  subdir('native/testing')
  bash = find_program('bash')
  dbus_run = find_program('dbus-run-session')
  python = find_program('python3')
  updater_test = executable('koya-update-service-test', 'native/update-service.cpp',
    dependencies: dependency('gio-unix-2.0'), cpp_args: ['-DKOYA_UPDATE_TESTING'])
  test('update-service-integration', dbus_run,
    args: ['--', python.full_path(), files('tests/test-update-service.py'), updater_test], timeout: 30)
  find_program('socat')
  coordinator_test = executable('koya-session-test', 'native/session.cpp', dependencies: deps,
    cpp_args: ['-DKOYA_TESTING'])
  hyprland_display_test = executable('koya-hyprland-display-test', 'native/hyprland-display.cpp',
    dependencies: dependency('gio-unix-2.0'), cpp_args: ['-DKOYA_TESTING'])
  foreach name : ['session', 'hyprland', 'status', 'system-reconnect', 'keyboard', 'wifi', 'settings', 'rotation', 'askpass', 'notifications-service', 'credentials']
    test(name + '-integration', bash,
      args: [files('tests/run.sh'), name, meson.current_build_dir()],
      depends: [coordinator_test, hyprland_display_test, hyprland_display, askpass] + phone_modules + test_modules, timeout: 75)
  endforeach
endif

node = find_program('node', required: false)
if node.found()
  test('credential-model', node, args: files('tests/test-credential-model.mjs'))
endif
