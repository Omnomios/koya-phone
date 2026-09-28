#!/usr/bin/python3
"""Integration tests: private bus, fake input, fake login1, real process ownership."""
import os
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from gi.repository import Gio, GLib

ROOT = Path(__file__).resolve().parents[1]
if '--inside' not in sys.argv:
    with tempfile.TemporaryDirectory(prefix='koya-session-test-') as tmp:
        env = dict(os.environ, XDG_RUNTIME_DIR=tmp, XDG_STATE_HOME=tmp)
        env.pop('DBUS_SYSTEM_BUS_ADDRESS', None)
        result = subprocess.run(['dbus-run-session', '--', sys.executable, __file__, sys.argv[1], '--inside'], env=env)
        sys.exit(result.returncode)
# Both buses are isolated from the host, including all power calls.
os.environ['DBUS_SYSTEM_BUS_ADDRESS'] = os.environ['DBUS_SESSION_BUS_ADDRESS']
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
def call(method, args=None, dest='org.koya.Shell1', path='/org/koya/Shell1', iface='org.koya.Shell1'):
    result = bus.call_sync(dest, path, iface, method, args, None, Gio.DBusCallFlags.NONE, 3000, None)
    return result.unpack() if result else ()
def state(): return call('GetState')[0]
def wait(predicate, timeout=8):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        try:
            if predicate(): return
        except GLib.Error: pass
        time.sleep(.03)
    raise AssertionError('Timed out waiting for condition')
def login(active=True, cap='yes', reject=False):
    return call('Set', GLib.Variant('(bsb)', (active, cap, reject)), 'org.freedesktop.login1', '/org/freedesktop/login1', 'org.koya.Test.Login')
def key(code, value): call('Button', GLib.Variant('(uu)', (code, value)), iface='org.koya.Shell1.Test')
def action(name, component='power_menu'): return call('Action', GLib.Variant('(s)', (name,)), 'org.koya.Test.' + component, '/org/koya/Test/Component', 'org.koya.Test.Component')
def denied(fn):
    try: fn()
    except GLib.Error: return
    raise AssertionError('Expected rejection')
def dead(pid):
    try:
        return Path(f'/proc/{pid}/stat').read_text().split()[2] == 'Z'
    except (FileNotFoundError, ProcessLookupError): return True
mock = subprocess.Popen([sys.executable, str(ROOT/'tests/fixtures/login.py')])
process = None
try:
    wait(lambda: login() == ())
    process = subprocess.Popen([sys.argv[1], str(ROOT), str(ROOT/'tests/fixtures/component.py')])
    wait(lambda: state()['Active'] and all(state()[n+'Status']=='ready' for n in ('wallpaper', 'top-bar')))
    duplicate = subprocess.run([sys.argv[1], str(ROOT), str(ROOT/'tests/fixtures/component.py')])
    assert duplicate.returncode != 0
    with tempfile.TemporaryDirectory(prefix='koya-other-runtime-') as other:
        duplicate = subprocess.run([sys.argv[1], str(ROOT), str(ROOT/'tests/fixtures/component.py')], env=dict(os.environ, XDG_RUNTIME_DIR=other))
        assert duplicate.returncode != 0, 'D-Bus name must also be exclusive'
    denied(lambda: call('Ready', GLib.Variant('(s)', ('wallpaper',))))
    denied(lambda: call('PowerOff'))
    key(116, 1); time.sleep(.1); key(116, 0); time.sleep(1.05)
    assert state()['PowerMenuState'] == 'closed', 'Short press opened menu'
    wait(lambda: state()['ScreenState']=='off' and state()['lock-screenStatus']=='ready')
    lock_pid = state()['lock-screenPid']
    denied(lambda: call('Unlock'))
    denied(lambda: action('Unlock', 'lock_screen'))  # Cannot swipe with panel off.
    key(116, 0)  # Unmatched release cannot wake.
    assert state()['ScreenState']=='off'
    key(116, 1); key(116, 0)
    assert state()['ScreenState']=='locked' and state()['lock-screenPid']==lock_pid
    action('Unlock', 'lock_screen')
    wait(lambda: state()['ScreenState']=='unlocked' and state()['lock-screenPid']==0)
    call('Lock'); wait(lambda: state()['lock-screenStatus']=='ready')
    assert state()['ScreenState']=='locked'
    action('Unlock', 'lock_screen')
    wait(lambda: state()['lock-screenPid']==0)
    # Re-lock during the delayed unlock must keep the existing owned process.
    call('Lock'); wait(lambda: state()['lock-screenStatus']=='ready')
    lock_pid = state()['lock-screenPid']
    action('Unlock', 'lock_screen'); call('Lock'); time.sleep(.2)
    assert state()['ScreenState']=='locked' and state()['lock-screenPid']==lock_pid
    key(116, 1); key(116, 0)
    assert state()['ScreenState']=='off'
    key(116, 1); wait(lambda: state()['PowerMenuState']=='open')
    key(116, 0)
    assert state()['ScreenState']=='locked', 'Long press did not wake or release powered off'
    call('DismissPowerMenu'); wait(lambda: state()['PowerMenuState']=='closed')
    action('Unlock', 'lock_screen'); wait(lambda: state()['lock-screenPid']==0)
    key(116, 1); call('DeviceLost', iface='org.koya.Shell1.Test'); time.sleep(1.05)
    assert state()['PowerMenuState'] == 'closed', 'Removed device completed hold'
    key(116, 1); login(False); wait(lambda: not state()['Active']); time.sleep(1.05)
    assert state()['PowerMenuState'] == 'closed'
    denied(lambda: call('ShowPowerMenu'))
    login(); wait(lambda: state()['Active'])
    key(116, 1); time.sleep(.5); key(116, 2)
    assert state()['PowerMenuState'] == 'closed'
    wait(lambda: state()['PowerMenuState'] == 'open')
    menu_pid = state()['power-menuPid']
    key(116, 2); call('ShowPowerMenu')
    assert state()['power-menuPid'] == menu_pid
    call('DismissPowerMenu'); wait(lambda: state()['PowerMenuState'] == 'closed')
    key(116, 2); time.sleep(1.05)
    assert state()['PowerMenuState'] == 'closed', 'Repeat retriggered held key'
    key(116, 0)
    assert state()['ScreenState']=='unlocked', 'Long hold release toggled display'
    # Observe real D-Bus button signals, including all repeat/release edges.
    events = []
    sub = bus.signal_subscribe('org.koya.Shell1', 'org.koya.Shell1', 'HardwareButton', None, None, Gio.DBusSignalFlags.NONE, lambda *a: events.append(a[5].unpack()))
    for value in (1, 2, 0): key(115, value)
    context = GLib.MainContext.default()
    for _ in range(10):
        while context.pending(): context.iteration(False)
        time.sleep(.01)
    assert events == [({'Button': 'volume-up', 'State': edge},) for edge in ('pressed', 'repeat', 'released')], events
    bus.signal_unsubscribe(sub)
    key(116, 1)
    mock.terminate(); mock.wait(timeout=3)
    wait(lambda: not state()['Active'])
    time.sleep(1.05)
    assert state()['PowerMenuState']=='closed'
    mock = subprocess.Popen([sys.executable, str(ROOT/'tests/fixtures/login.py')])
    wait(lambda: state()['Active'])
    call('ShowPowerMenu'); wait(lambda: state()['PowerMenuState']=='open')
    login(cap='challenge'); denied(lambda: action('PowerOff'))
    assert state()['PowerMenuState']=='open'
    login(reject=True); denied(lambda: action('Reboot'))
    assert 'Test inhibitor' in state()['LastError']
    login(); action('Reboot')
    assert state()['PowerMenuState']=='pending'
    denied(lambda: action('PowerOff'))
    assert call('Actions', dest='org.freedesktop.login1', path='/org/freedesktop/login1', iface='org.koya.Test.Login') == (['Reboot'],)
    pids = [state()[n+'Pid'] for n in ('wallpaper', 'top-bar', 'power-menu')]
    process.terminate(); assert process.wait(timeout=6)==0
    wait(lambda: all(dead(pid) for pid in pids))
    # Lock is released and a fresh session can start. Crash restart is bounded.
    process = subprocess.Popen([sys.argv[1], str(ROOT), str(ROOT/'tests/fixtures/component.py')])
    wait(lambda: state()['top-barStatus']=='ready')
    call('ShowPowerMenu'); wait(lambda: state()['PowerMenuState']=='open')
    action('PowerOff')
    assert call('Actions', dest='org.freedesktop.login1', path='/org/freedesktop/login1', iface='org.koya.Test.Login') == (['Reboot', 'PowerOff'],)
    for attempt in range(4):
        old = state()['top-barPid']; assert old > 1; os.kill(old, signal.SIGKILL)
        if attempt < 3: wait(lambda: (lambda s: s['top-barStatus']=='ready' and s['top-barPid']>1 and s['top-barPid']!=old)(state()))
        else: wait(lambda: state()['top-barStatus']=='failed')
    # A coordinator killed without cleanup still takes its children with it.
    pids = [state()[n+'Pid'] for n in ('wallpaper', 'power-menu')]; process.kill(); process.wait(timeout=3)
    wait(lambda: all(dead(pid) for pid in pids))
    print('PASS: holds, activity, volume, singleton, power authorization, inhibitors, restart cap, parent death, cleanup')
finally:
    if process and process.poll() is None:
        process.terminate(); process.wait(timeout=6)
    mock.terminate(); mock.wait(timeout=3)
