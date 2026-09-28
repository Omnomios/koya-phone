#!/usr/bin/python3
"""Squeekboard visibility contract on a private test bus."""
from gi.repository import Gio, GLib
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
visible = False
delay = False
fail = False
xml = '''<node>
<interface name="sm.puri.OSK0"><method name="SetVisible"><arg type="b" direction="in"/></method><property name="Visible" type="b" access="read"/></interface>
<interface name="org.koya.Test.Keyboard"><method name="Visible"><arg type="b" direction="in"/></method><method name="DelayNext"/><method name="FailNext"/></interface>
</node>'''
info = Gio.DBusNodeInfo.new_for_xml(xml)
def update(value):
    global visible
    if value != visible:
        visible = value
        bus.emit_signal(None, '/sm/puri/OSK0', 'org.freedesktop.DBus.Properties', 'PropertiesChanged',
                        GLib.Variant('(sa{sv}as)', ('sm.puri.OSK0', {'Visible': GLib.Variant('b', visible)}, [])))
def method(conn, sender, path, iface, name, args, invocation):
    global delay, fail
    if name == 'DelayNext': delay = True
    elif name == 'FailNext': fail = True
    elif name == 'Visible': update(args.unpack()[0])
    else:
        if fail:
            fail = False
            invocation.return_dbus_error('sm.puri.OSK0.Error', 'Test keyboard rejected visibility')
            return
        value = args.unpack()[0]
        def finish():
            update(value); invocation.return_value(None)
            return GLib.SOURCE_REMOVE
        if delay:
            delay = False
            GLib.timeout_add(150, finish)
        else: finish()
        return
    invocation.return_value(None)
for interface in info.interfaces:
    bus.register_object('/sm/puri/OSK0', interface, method, lambda *_: GLib.Variant('b', visible), None)
bus.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'RequestName',
              GLib.Variant('(su)', ('sm.puri.OSK0', 4)), None, Gio.DBusCallFlags.NONE, 2000, None)
GLib.MainLoop().run()
