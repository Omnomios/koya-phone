#!/usr/bin/python3
import sys
from gi.repository import Gio, GLib
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
name = sys.argv[1]
xml = '''<node><interface name="org.koya.Test.Component"><method name="Action"><arg type="s" direction="in"/></method>
<method name="Launch"><arg type="s" direction="in"/><arg type="u" direction="in"/></method></interface></node>'''
info = Gio.DBusNodeInfo.new_for_xml(xml)
def method(conn, sender, path, iface, member, args, invocation):
    def done(conn, result, data):
        try:
            conn.call_finish(result)
            invocation.return_value(None)
        except GLib.Error as e:
            invocation.return_dbus_error('org.koya.Test.Error', str(e))
    target = 'LaunchApplication' if member == 'Launch' else args.unpack()[0]
    parameters = args if member == 'Launch' else None
    bus.call('org.koya.Shell1', '/org/koya/Shell1', 'org.koya.Shell1', target, parameters, None, Gio.DBusCallFlags.NONE, 15000, None, done, None)
bus.register_object('/org/koya/Test/Component', info.interfaces[0], method, None, None)
bus.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'RequestName', GLib.Variant('(su)', ('org.koya.Test.' + name.replace('-', '_'), 4)), None, Gio.DBusCallFlags.NONE, 2000, None)
bus.call_sync('org.koya.Shell1', '/org/koya/Shell1', 'org.koya.Shell1', 'Ready', GLib.Variant('(s)', (name,)), None, Gio.DBusCallFlags.NONE, 2000, None)
GLib.MainLoop().run()
