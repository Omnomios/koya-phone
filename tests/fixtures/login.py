#!/usr/bin/python3
# Only used on a private test bus. Never invokes a host power action.
from gi.repository import Gio, GLib
import os
from pathlib import Path
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
active, capability, reject = True, 'yes', False
actions = []
xml = '''<node>
<interface name="org.freedesktop.login1.Manager">
<method name="GetSessionByPID"><arg type="u" direction="in"/><arg type="o" direction="out"/></method>
<method name="CanPowerOff"><arg type="s" direction="out"/></method>
<method name="CanReboot"><arg type="s" direction="out"/></method>
<method name="PowerOff"><arg type="b" direction="in"/></method>
<method name="Reboot"><arg type="b" direction="in"/></method></interface>
<interface name="org.freedesktop.login1.Session"><property name="Active" type="b" access="read"/>
<method name="SetBrightness"><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="u" direction="in"/></method></interface>
<interface name="org.koya.Test.Login">
<method name="Set"><arg type="b" direction="in"/><arg type="s" direction="in"/><arg type="b" direction="in"/></method>
<method name="Actions"><arg type="as" direction="out"/></method>
</interface></node>'''
info = Gio.DBusNodeInfo.new_for_xml(xml)
session = '/org/freedesktop/login1/session/test'
def method(conn, sender, path, iface, member, args, invocation):
    global active, capability, reject
    result = None
    if member == 'GetSessionByPID': result = GLib.Variant('(o)', (session,))
    elif member.startswith('Can'): result = GLib.Variant('(s)', (capability,))
    elif member in ('PowerOff', 'Reboot'):
        assert args.unpack() == (False,), 'Never request interactive authorization'
        if reject:
            invocation.return_dbus_error('org.freedesktop.login1.Inhibited', 'Test inhibitor')
            return
        actions.append(member)
    elif member == 'SetBrightness':
        subsystem, device, level = args.unpack()
        assert subsystem == 'backlight' and device == 'fixture', 'Unexpected brightness device'
        directory = Path(os.environ['KOYA_TEST_BACKLIGHT_DIR'])/device
        assert 1 <= level <= int((directory/'max_brightness').read_text())
        if reject:
            invocation.return_dbus_error('org.freedesktop.DBus.Error.AccessDenied', 'Test brightness rejection')
            return
        (directory/'brightness').write_text(str(level))
    elif member == 'Set':
        active, capability, reject = args.unpack()
        bus.emit_signal(None, session, 'org.freedesktop.DBus.Properties', 'PropertiesChanged', GLib.Variant('(sa{sv}as)', ('org.freedesktop.login1.Session', {'Active': GLib.Variant('b', active)}, [])))
    elif member == 'Actions': result = GLib.Variant('(as)', (actions,))
    invocation.return_value(result)
def prop(*args): return GLib.Variant('b', active)
for interface in info.interfaces:
    bus.register_object(session if interface.name.endswith('.Session') else '/org/freedesktop/login1', interface, method, prop, None)
bus.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'RequestName', GLib.Variant('(su)', ('org.freedesktop.login1', 4)), None, Gio.DBusCallFlags.NONE, 2000, None)
if os.environ.get('KOYA_TEST_HAPTICS') == '1':
    feedback_calls=[]
    feedback=Gio.DBusNodeInfo.new_for_xml('''<node><interface name="org.sigxcpu.Feedback">
    <method name="TriggerFeedback"><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="a{sv}" direction="in"/><arg type="i" direction="in"/><arg type="u" direction="out"/></method>
    <method name="Calls"><arg type="u" direction="out"/></method></interface></node>''')
    def feedback_method(conn, sender, path, iface, member, args, invocation):
        if member == 'TriggerFeedback':
            app, event, hints, timeout = args.unpack()
            assert app == 'org.koya.Shell' and event == 'button-pressed' and hints == {'profile':'quiet'} and timeout == -1
            feedback_calls.append(event)
        invocation.return_value(GLib.Variant('(u)', (len(feedback_calls),)))
    bus.register_object('/org/sigxcpu/Feedback', feedback.interfaces[0], feedback_method, None, None)
    bus.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'RequestName', GLib.Variant('(su)', ('org.sigxcpu.Feedback', 4)), None, Gio.DBusCallFlags.NONE, 2000, None)
GLib.MainLoop().run()
