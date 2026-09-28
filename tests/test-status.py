#!/usr/bin/python3
"""Real coordinator status projection; private bus, fake battery and NM/MM."""
import os, subprocess, sys, tempfile, time
from pathlib import Path
from gi.repository import Gio, GLib

ROOT = Path(__file__).resolve().parents[1]
if '--inside' not in sys.argv:
    with tempfile.TemporaryDirectory(prefix='koya-status-') as tmp:
        env = dict(os.environ, XDG_RUNTIME_DIR=tmp, XDG_STATE_HOME=tmp, KOYA_TEST_POWER_SUPPLY_DIR=tmp+'/power')
        env.pop('HYPRLAND_INSTANCE_SIGNATURE', None)
        sys.exit(subprocess.run(['dbus-run-session', '--', sys.executable, __file__, '--inside'], env=env).returncode)
os.environ['DBUS_SYSTEM_BUS_ADDRESS'] = os.environ['DBUS_SESSION_BUS_ADDRESS']
supplies = Path(os.environ['KOYA_TEST_POWER_SUPPLY_DIR'])
for name, fields in [('battery', dict(type='Battery', present='1', capacity='73', status='Discharging')), ('usb', dict(type='USB', online='0'))]:
    directory = supplies/name; directory.mkdir(parents=True)
    for key, value in fields.items(): (directory/key).write_text(value+'\n')
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
def control(method, args): return call(method, args, 'org.koya.Test.Status', '/org/koya/Test/Status', 'org.koya.Test.Status')
def update(interface, values): control('Update', GLib.Variant('(sa{sv})', (interface, values)))
def battery(): call('PowerSupplyChanged', interface='org.koya.Shell1.Test')
processes=[]
try:
    for fixture in ('login.py', 'status.py'): processes.append(subprocess.Popen([sys.executable, str(ROOT/'tests/fixtures'/fixture)]))
    processes.append(subprocess.Popen([str(ROOT/'build/koya-session-test'), str(ROOT), str(ROOT/'tests/fixtures/component.py')]))
    wait(lambda s: s['top-barStatus']=='ready' and s['BatteryPercent']==73 and s['WifiStrength']==76 and s['CellularTechnology']=='4G')
    initial=state()
    assert initial['NetworkConnectivity']=='full' and initial['WifiSsid']=='Koya test' and initial['CellularStrength']==47 and initial['CellularOperator']=='Test carrier', initial
    (supplies/'usb/online').write_text('1\n'); (supplies/'battery/status').write_text('Charging\n'); battery()
    wait(lambda s: s['ExternalPower'] and s['BatteryState']=='charging')
    (supplies/'battery/capacity').write_text('14\n'); battery()
    wait(lambda s: s['BatteryPercent']==14)
    update('org.freedesktop.NetworkManager.AccessPoint', {'Strength': GLib.Variant('y', 22)})
    wait(lambda s: s['WifiStrength']==22)
    update('org.freedesktop.NetworkManager', {'Connectivity': GLib.Variant('u', 2)})
    wait(lambda s: s['NetworkConnectivity']=='portal')
    update('org.freedesktop.NetworkManager', {'WirelessEnabled': GLib.Variant('b', False)})
    wait(lambda s: s['WifiState']=='disabled' and s['WifiStrength']==-1 and s['WifiSsid']=='')
    update('org.freedesktop.ModemManager1.Modem.Modem3gpp', {'RegistrationState': GLib.Variant('u', 5)})
    wait(lambda s: s['CellularState']=='roaming')
    update('org.freedesktop.ModemManager1.Modem', {'SignalQuality': GLib.Variant('(ub)', (90, False))})
    wait(lambda s: s['CellularStrength']==-1)
    for name, predicate in [('org.freedesktop.NetworkManager', lambda s: not s['NetworkAvailable'] and s['WifiState']=='unavailable'), ('org.freedesktop.ModemManager1', lambda s: s['CellularState']=='unavailable')]:
        control('Drop', GLib.Variant('(s)', (name,))); wait(predicate)
        control('Own', GLib.Variant('(s)', (name,)))
        wait(lambda s: s['NetworkAvailable'] and s['CellularState']=='roaming')
    (supplies/'battery/capacity').write_text('invalid\n'); battery()
    wait(lambda s: s['BatteryPresent'] and s['BatteryPercent']==-1)
    (supplies/'battery/present').write_text('0\n'); battery()
    wait(lambda s: not s['BatteryPresent'])
    # A duplicate kernel event must not publish an unchanged status snapshot.
    events=[]
    subscription=bus.signal_subscribe('org.koya.Shell1', 'org.koya.Shell1', 'StateChanged', None, None, Gio.DBusSignalFlags.NONE, lambda *args: events.append(args[5].unpack()[0]))
    battery()
    context=GLib.MainContext.default(); end=time.monotonic()+.15
    while time.monotonic()<end:
        while context.pending(): context.iteration(False)
        time.sleep(.01)
    assert not events, 'Unchanged battery event emitted a redraw notification'
    bus.signal_unsubscribe(subscription)
    print('PASS: battery/charging, Wi-Fi strength/radio state, connectivity, cellular/roaming, stale signal, service recovery and duplicate suppression')
finally:
    for process in reversed(processes):
        if process.poll() is None:
            process.terminate(); process.wait(timeout=6)
