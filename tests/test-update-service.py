#!/usr/bin/env python3
"""Real service on a private bus, fake Polkit and a controlled installer."""
import os
import pathlib
import signal
import subprocess
import sys
import tempfile
import time
from gi.repository import Gio, GLib

NAME, PATH = 'org.koya.Update1', '/org/koya/Update1'
ctx = GLib.MainContext.default()
def pump():
    while ctx.pending():
        ctx.iteration(False)
def wait(test, label):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        pump()
        if test(): return
        time.sleep(.01)
    raise AssertionError(label)
def connection():
    return Gio.DBusConnection.new_for_address_sync(os.environ['DBUS_SESSION_BUS_ADDRESS'],
        Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION, None, None)
def call(bus, method):
    return bus.call_sync(NAME, PATH, NAME, method, None, None, Gio.DBusCallFlags.NONE, 2000, None)
def state(bus):
    return call(bus, 'GetState').unpack()[0]
def busy(bus):
    try: call(bus, 'Start')
    except GLib.Error as error:
        assert 'org.koya.Update1.Busy' in str(error), error
    else: raise AssertionError('Accepted overlapping update')

policy = connection()
policy.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'RequestName',
    GLib.Variant('(su)', ('org.freedesktop.PolicyKit1', 4)), None, Gio.DBusCallFlags.NONE, -1, None)
xml = '''<node><interface name="org.freedesktop.PolicyKit1.Authority"><method name="CheckAuthorization">
<arg type="(sa{sv})" direction="in"/><arg type="s" direction="in"/><arg type="a{ss}" direction="in"/>
<arg type="u" direction="in"/><arg type="s" direction="in"/><arg type="(bba{ss})" direction="out"/>
</method><method name="CancelCheckAuthorization"><arg type="s" direction="in"/></method></interface></node>'''
pending = []
def authorize(bus, sender, path, interface, method, params, invocation):
    if method == 'CancelCheckAuthorization':
        pending.clear()
        invocation.return_value(None)
        return
    subject, action, details, flags, cancellation = params.unpack()
    assert subject[0] == 'system-bus-name' and subject[1]['name'].startswith(':')
    assert action == 'org.koya.update' and flags == 1
    pending.append((subject[1]['name'], invocation))
policy.register_object('/org/freedesktop/PolicyKit1/Authority', Gio.DBusNodeInfo.new_for_xml(xml).interfaces[0], authorize, None, None)
def approve(client, allowed):
    wait(lambda: bool(pending), 'No Polkit request')
    sender, invocation = pending.pop(0)
    assert sender == client.get_unique_name(), 'Authorization checked the wrong caller'
    invocation.return_value(GLib.Variant('((bba{ss}))', ((allowed, False, {}),)))

with tempfile.TemporaryDirectory(prefix='koya-update-service-') as directory:
    root = pathlib.Path(directory)
    worker = root / 'worker.sh'
    worker.write_text(f'''#!/bin/sh
set -eu
echo 'Fetching installer...'
echo 'Starting installation outside the graphical session...'
sleep 30 &
echo $! >> '{root}/children'
touch '{root}/started'
while [ ! -f '{root}/release' ]; do sleep .02; done
exit "$(cat '{root}/release')"
''')
    service = subprocess.Popen([sys.argv[1], str(worker), str(root / 'update.log')])
    client = connection()
    try:
        def available():
            try: return state(client)['State'] == 'idle'
            except GLib.Error: return False
        wait(available, 'Service did not start')
        duplicate = subprocess.run([sys.argv[1], str(worker), str(root / 'other.log')], capture_output=True, timeout=3)
        assert duplicate.returncode != 0, 'Two updater services own the job'

        call(client, 'Start')
        assert state(client)['State'] == 'authorizing'
        busy(client)
        approve(client, False)
        wait(lambda: state(client)['State'] == 'failed', 'Denial did not finish')
        assert not (root / 'started').exists(), 'Denied request launched installer'

        call(client, 'Start')
        wait(lambda: bool(pending), 'Missing cancellable authorization')
        client.close_sync(None)
        client = connection()
        wait(lambda: state(client)['State'] == 'failed' and not pending, 'Disconnected authorization remained busy')
        assert not (root / 'started').exists()

        call(client, 'Start'); approve(client, True)
        wait(lambda: (root / 'started').exists(), 'Installer did not start')
        assert state(client)['State'] == 'running'
        assert state(client)['Phase'] == 'install'
        assert 'Starting installation' in state(client)['Log']
        first_job = state(client)['Job']
        client.close_sync(None)  # The display manager can destroy the entire GUI.
        client = connection()
        assert state(client)['State'] == 'running'
        busy(client)
        (root / 'release').write_text('0')
        wait(lambda: state(client)['State'] == 'succeeded', 'Installer did not complete')
        for pid in (root / 'children').read_text().split(): os.kill(int(pid), 0)

        # A second request must start while the first installer's daemon lives.
        (root / 'release').write_text('7')
        call(client, 'Start'); approve(client, True)
        wait(lambda: state(client)['State'] == 'failed', 'Second installer failure was not reported')
        assert state(client)['Job'] > first_job
        (root / 'release').write_text('0')
        call(client, 'Start'); approve(client, True)
        wait(lambda: state(client)['State'] == 'succeeded', 'Retry after failure failed')
        (root / 'release').unlink(); (root / 'started').unlink()
        call(client, 'Start'); approve(client, True)
        wait(lambda: (root / 'started').exists(), 'Final installer did not start')
        service.terminate()
        time.sleep(.05)
        assert service.poll() is None, 'Service abandoned its installer on shutdown'
        busy(client)
        (root / 'release').write_text('0')
        wait(lambda: service.poll() is not None, 'Service did not stop after installer completion')
        print('PASS: authorization, duplicate rejection, GUI loss/reconnect, consecutive updates with surviving descendants, failure, retry and graceful shutdown')
    finally:
        service.terminate(); service.wait(timeout=5)
        if (root / 'children').exists():
            for pid in (root / 'children').read_text().split():
                try: os.kill(int(pid), signal.SIGTERM)
                except ProcessLookupError: pass
