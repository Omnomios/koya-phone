#!/usr/bin/python3
"""Real coordinator, private Squeekboard/login1/Hyprland fixtures."""
import os, signal, socket, subprocess, sys, tempfile, threading, time
from pathlib import Path
from gi.repository import Gio, GLib
ROOT = Path(__file__).resolve().parents[1]
if '--inside' not in sys.argv:
    with tempfile.TemporaryDirectory(prefix='koya-keyboard-') as tmp:
        env = dict(os.environ, XDG_RUNTIME_DIR=tmp, XDG_STATE_HOME=tmp, XDG_CACHE_HOME=tmp,
                   HYPRLAND_INSTANCE_SIGNATURE='keyboard-test', KOYA_TEST_KEYBOARD_FIXTURE=str(ROOT/'tests/fixtures/keyboard.py'))
        sys.exit(subprocess.run(['dbus-run-session', '--', sys.executable, __file__, '--inside'], env=env).returncode)
os.environ['DBUS_SYSTEM_BUS_ADDRESS'] = os.environ['DBUS_SESSION_BUS_ADDRESS']
instance = Path(os.environ['XDG_RUNTIME_DIR'])/'hypr/keyboard-test'
instance.mkdir(parents=True)
peers = []
servers = []
for filename in ('.socket.sock', '.socket2.sock'):
    server = socket.socket(socket.AF_UNIX); server.bind(str(instance/filename)); server.listen(); servers.append(server)
    def serve(server=server, events=filename=='.socket2.sock'):
        while True:
            peer, _ = server.accept()
            if events: peers.append(peer)
            else:
                peer.recv(4096); peer.sendall(b'ok'); peer.close()
    threading.Thread(target=serve, daemon=True).start()
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
def call(method, args=None, dest='org.koya.Shell1', path='/org/koya/Shell1', interface='org.koya.Shell1'):
    return bus.call_sync(dest, path, interface, method, args, None, Gio.DBusCallFlags.NONE, 2000, None).unpack()
def state(): return call('GetState')[0]
def wait(predicate):
    end = time.monotonic()+5
    while time.monotonic()<end:
        try:
            if predicate(state()): return
        except GLib.Error: pass
        time.sleep(.02)
    raise AssertionError(state())
def toggle(): call('Action', GLib.Variant('(s)', ('ToggleKeyboard',)), 'org.koya.Test.navigation', '/org/koya/Test/Component', 'org.koya.Test.Component')
def keyboard(method, args=None): return call(method, args, 'sm.puri.OSK0', '/sm/puri/OSK0', 'org.koya.Test.Keyboard')
def shown(): wait(lambda s: s['KeyboardVisible'] and not s['KeyboardPending'])
def hidden():
    wait(lambda s: not s['KeyboardVisible'] and not s['KeyboardPending'] and
         not call('Get', GLib.Variant('(ss)', ('sm.puri.OSK0', 'Visible')), 'sm.puri.OSK0', '/sm/puri/OSK0', 'org.freedesktop.DBus.Properties')[0])
processes = []
try:
    processes.append(subprocess.Popen([sys.executable, str(ROOT/'tests/fixtures/login.py')]))
    processes.append(subprocess.Popen([str(ROOT/'build/koya-session-test'), str(ROOT), str(ROOT/'tests/fixtures/component.py')]))
    wait(lambda s: s['Active'] and s['navigationStatus']=='ready' and s['keyboardStatus']=='ready')
    initial = state(); pid = initial['keyboardPid']
    assert initial['KeyboardAvailable'] and pid and not initial['KeyboardVisible'], initial
    try: call('ToggleKeyboard')
    except GLib.Error: pass
    else: raise AssertionError('Unowned caller controlled keyboard')
    toggle(); shown(); toggle(); hidden()
    keyboard('Visible', GLib.Variant('(b)', (True,))); shown()
    call('SwitchDesktop', GLib.Variant('(u)', (1,))); hidden()
    toggle(); shown()
    call('ShowDesktopView', GLib.Variant('(s)', ('apps',))); hidden()
    keyboard('Visible', GLib.Variant('(b)', (True,))); hidden()
    call('DismissDesktopView'); toggle(); shown()
    call('ShowPowerMenu'); hidden()
    wait(lambda s: s['PowerMenuState']=='open')
    call('DismissPowerMenu'); wait(lambda s: s['PowerMenuState']=='closed')
    toggle(); shown(); call('Lock'); hidden()
    wait(lambda s: s['lock-screenStatus']=='ready')
    try: toggle()
    except GLib.Error: pass
    else: raise AssertionError('Keyboard opened while locked')
    call('Action', GLib.Variant('(s)', ('Unlock',)), 'org.koya.Test.lock_screen', '/org/koya/Test/Component', 'org.koya.Test.Component')
    wait(lambda s: s['ScreenState']=='unlocked')
    keyboard('DelayNext'); toggle(); toggle(); hidden()
    keyboard('DelayNext'); toggle(); call('Lock'); hidden()
    wait(lambda s: s['lock-screenStatus']=='ready')
    call('Action', GLib.Variant('(s)', ('Unlock',)), 'org.koya.Test.lock_screen', '/org/koya/Test/Component', 'org.koya.Test.Component')
    wait(lambda s: s['ScreenState']=='unlocked')
    keyboard('FailNext'); toggle()
    wait(lambda s: 'Test keyboard rejected' in s['LastError'] and not s['KeyboardPending'])
    hidden()
    toggle(); shown()
    # A compositor workspace event also hides the keyboard without querying IPC.
    for peer in peers: peer.sendall(b'workspacev2>>1,1\n')
    hidden()
    os.kill(pid, signal.SIGKILL)
    wait(lambda s: s['keyboardPid'] not in (0, pid) and s['keyboardStatus']=='ready')
    replacement = state()['keyboardPid']
    processes[-1].terminate(); processes[-1].wait(timeout=5)
    try: os.kill(replacement, 0)
    except ProcessLookupError: pass
    else: raise AssertionError('Keyboard survived coordinator shutdown')
    print('PASS: keyboard supervision, manual/automatic visibility, drawer/home/power/lock dismissal, rapid presses, errors, restart and cleanup')
finally:
    for process in reversed(processes):
        if process.poll() is None: process.terminate(); process.wait(timeout=6)
