project('koya-shell', 'cpp', 'c', version: '0.1.0',
  default_options: ['cpp_std=c++17', 'warning_level=2'])
deps = [dependency('gio-unix-2.0'), dependency('libevdev'), dependency('libudev')]
coordinator = executable('koya-session', 'native/session.cpp', dependencies: deps)
executable('koya-launch-app', 'native/launch-app.cpp', dependencies: dependency('gio-unix-2.0'))
executable('koya-render-icon', 'native/render-icon.cpp', dependencies: dependency('gio-unix-2.0'))
hyprland_display = executable('koya-hyprland-display', 'native/hyprland-display.cpp', dependencies: dependency('gio-unix-2.0'))
if get_option('integration_tests')
  python = find_program('python3')
  coordinator_test = executable('koya-session-test', 'native/session.cpp', dependencies: deps,
    cpp_args: ['-DKOYA_TESTING'])
  hyprland_display_test = executable('koya-hyprland-display-test', 'native/hyprland-display.cpp',
    dependencies: dependency('gio-unix-2.0'), cpp_args: ['-DKOYA_TESTING'])
  test('session-integration', python,
    args: [files('tests/test-session.py'), coordinator_test.full_path()],
    depends: coordinator_test, timeout: 70)
  test('hyprland-integration', python, args: files('tests/test-hyprland.py'),
    depends: [coordinator_test, hyprland_display_test, hyprland_display], timeout: 35)
  test('installer-offline', find_program('sh'), args: files('tests/test-install.sh'), timeout: 10)
  test('status-integration', python, args: files('tests/test-status.py'), depends: coordinator_test, timeout: 20)
  test('keyboard-integration', python, args: files('tests/test-keyboard.py'), depends: coordinator_test, timeout: 20)
endif
