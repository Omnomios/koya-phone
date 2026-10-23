#!/usr/bin/env python3
import os
import pathlib
import subprocess
import sys
import tempfile
import time
from gi.repository import Gio, GLib

context = GLib.MainContext.default()
events = []
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
bus.signal_subscribe(None, 'org.koya.Application1', 'LaunchChanged', '/org/koya/Application', None,
                     Gio.DBusSignalFlags.NONE, lambda *args: events.append(args[5].unpack()))
# Complete subscription before starting a helper that may fail immediately.
bus.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'GetId',
              None, None, Gio.DBusCallFlags.NONE, 2000, None)

def wait(predicate):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        while context.pending(): context.iteration(False)
        if predicate(): return
        time.sleep(.005)
    raise AssertionError('Launch tracking timed out: ' + repr(events))

with tempfile.TemporaryDirectory(prefix='koya-launch-test-') as directory:
    root = pathlib.Path(directory)
    env = dict(os.environ, XDG_STATE_HOME=directory)
    def run(name, command=None, extra='', interpreter='', shebang='/bin/sh'):
        events.clear()
        entry = root / (name + '.desktop')
        if command:
            script = root / (name + '.sh')
            script.write_text('#!' + shebang + '\n' + command + '\n')
            script.chmod(0o700)
            entry.write_text('[Desktop Entry]\nType=Application\nName=Launch test\nExec=' + interpreter + str(script) + '\n' + extra)
        child = subprocess.Popen([sys.argv[1], str(entry), name], env=env)
        wait(lambda: child.poll() is not None)
        # Flush events sent just before the helper exited.
        bus.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'GetId',
                      None, None, Gio.DBusCallFlags.NONE, 2000, None)
        while context.pending(): context.iteration(False)
        assert all(event[0] == name for event in events), events
        return child.returncode, list(events)

    code, changes = run('failure', 'echo startup-failed >&2\nexit 7')
    assert code != 0 and [event[1] for event in changes] == ['started', 'exited'], changes
    assert changes[0][2] > 0 and changes[0][2] == changes[1][2], changes
    assert changes[1][3] == 7 and changes[1][4], changes
    assert 'startup-failed' in (root / 'koya-shell/applications.log').read_text()

    code, changes = run('signal', 'kill -TERM $$')
    assert code != 0 and changes[-1][1] == 'exited' and changes[-1][3] == -15, changes

    code, changes = run('success', 'exit 0')
    assert code == 0 and changes[-1][1] == 'exited' and changes[-1][3] == 0, changes

    code, changes = run('path-search', 'exit 9', interpreter='sh ')
    assert code != 0 and changes[0][1] == 'started' and changes[-1][3] == 9, changes

    code, changes = run('missing')
    assert code != 0 and len(changes) == 1 and changes[0][1] == 'failed' and changes[0][2] == 0, changes

    code, changes = run('spawn-failure', 'exit 0', shebang='/missing-koya-test-interpreter')
    # Depending on the spawn backend, exec failure is synchronous or a child exit.
    assert code != 0 and changes[-1][1] in ('failed', 'exited') and changes[-1][3] != 0 and changes[-1][4], changes

    # D-Bus activation has no child PID. It must remain a valid launch.
    activated = []
    name = 'org.koya.Test.Launch'
    bus.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'RequestName',
                  GLib.Variant('(su)', (name, 4)), None, Gio.DBusCallFlags.NONE, 2000, None)
    xml = '<node><interface name="org.freedesktop.Application"><method name="Activate"><arg type="a{sv}" direction="in"/></method></interface></node>'
    def activate(connection, sender, path, interface, method, parameters, invocation):
        activated.append(method)
        invocation.return_value(None)
    bus.register_object('/org/koya/Test/Launch', Gio.DBusNodeInfo.new_for_xml(xml).interfaces[0], activate, None, None)
    code, changes = run(name, 'exit 8', 'DBusActivatable=true\n')
    wait(lambda: bool(activated))
    assert code == 0 and not changes and activated == ['Activate'], (changes, activated)

print('PASS: child PID, exit status, signals, spawn failure, logs and D-Bus activation')
