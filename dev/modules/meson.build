module_inc = include_directories('../../native/sdk')
module_args = ['-fvisibility=hidden']
if phone_testing
  module_args += ['-DKOYA_TESTING']
endif
phone_modules = []
phone_modules += shared_library('hx-desktop', '../../native/modules/desktop.cpp', name_prefix: 'lib', override_options: ['b_lundef=false'],
  include_directories: module_inc, dependencies: [gio, dependency('threads'), meson.get_compiler('cpp').find_library('dl')], cpp_args: module_args)
phone_modules += shared_library('hx-linux-device', '../../native/modules/linux-device.cpp', name_prefix: 'lib', override_options: ['b_lundef=false'],
  include_directories: module_inc, dependencies: [gio, dependency('libevdev'), dependency('libudev')], cpp_args: module_args)
phone_modules += shared_library('hx-polkit-agent', '../../native/modules/polkit-agent.cpp', name_prefix: 'lib', override_options: ['b_lundef=false'],
  include_directories: module_inc, dependencies: [gio, dependency('polkit-agent-1'), meson.get_compiler('cpp').find_library('dl')], cpp_args: module_args)

phone_modules += shared_library('hx-credentials', '../../native/modules/credentials.cpp', name_prefix: 'lib', override_options: ['b_lundef=false'],
  include_directories: module_inc, dependencies: [gio, dependency('libcrypto'), dependency('threads')], cpp_args: module_args)
