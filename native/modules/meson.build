module_inc = include_directories('../sdk')
module_args = ['-fvisibility=hidden']
if phone_testing
  module_args += ['-DKOYA_TESTING']
endif
phone_modules = []
phone_modules += shared_library('hx-desktop', 'desktop.cpp', name_prefix: 'lib', override_options: ['b_lundef=false'],
  include_directories: module_inc, dependencies: [gio, dependency('threads'), meson.get_compiler('cpp').find_library('dl')], cpp_args: module_args)
phone_modules += shared_library('hx-linux-device', 'linux-device.cpp', name_prefix: 'lib', override_options: ['b_lundef=false'],
  include_directories: module_inc, dependencies: [gio, dependency('libevdev'), dependency('libudev')], cpp_args: module_args)
phone_modules += shared_library('hx-polkit-agent', 'polkit-agent.cpp', name_prefix: 'lib', override_options: ['b_lundef=false'],
  include_directories: module_inc, dependencies: [gio, dependency('polkit-agent-1'), meson.get_compiler('cpp').find_library('dl')], cpp_args: module_args)

phone_modules += shared_library('hx-credentials', 'credentials.cpp', name_prefix: 'lib', override_options: ['b_lundef=false'],
  include_directories: module_inc, dependencies: [gio, dependency('libcrypto'), dependency('threads')], cpp_args: module_args)
