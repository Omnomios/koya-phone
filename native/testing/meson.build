test_modules = []
test_modules += shared_library('hx-linux-device', '../modules/linux-device.cpp', name_prefix: 'lib', override_options: ['b_lundef=false'],
  include_directories: include_directories('../sdk'), dependencies: [gio, dependency('libevdev'), dependency('libudev')], cpp_args: ['-fvisibility=hidden', '-DKOYA_TESTING'])
test_modules += shared_library('hx-polkit-agent', '../modules/polkit-agent.cpp', name_prefix: 'lib', override_options: ['b_lundef=false'],
  include_directories: include_directories('../sdk'), dependencies: [gio, dependency('polkit-agent-1'), meson.get_compiler('cpp').find_library('dl')], cpp_args: ['-fvisibility=hidden', '-DKOYA_TESTING'])
