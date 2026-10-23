#!/usr/bin/env python3
import os
from gi.repository import Gio, GLib

assert os.environ['XDG_RUNTIME_DIR'] in os.environ['DBUS_SESSION_BUS_ADDRESS'], 'Private bus required'
bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
root, path = '/org/freedesktop/login1', '/org/freedesktop/login1/session/test'
active, reject, held, locked = True, False, False, False
inhibitors, pending = {}, []
xml = '''<node><interface name="org.freedesktop.login1.Manager">
<method name="GetSessionByPID"><arg type="u" direction="in"/><arg type="o" direction="out"/></method>
<method name="CanSuspend"><arg type="s" direction="out"/></method>
<method name="CanPowerOff"><arg type="s" direction="out"/></method><method name="CanReboot"><arg type="s" direction="out"/></method>
<method name="Inhibit"><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="h" direction="out"/></method>
<method name="ListInhibitors"><arg type="a(ssssuu)" direction="out"/></method>
<signal name="PrepareForSleep"><arg type="b"/></signal></interface>
<interface name="org.koya.Test.Sleep">
<method name="Prepare"><arg type="b" direction="in"/></method><method name="Active"><arg type="b" direction="in"/></method>
<method name="RejectInhibit"><arg type="b" direction="in"/></method><method name="HoldInhibit"><arg type="b" direction="in"/></method>
<method name="LockedHint"><arg type="b" direction="out"/></method></interface></node>'''
session_xml = '''<node><interface name="org.freedesktop.DBus.Properties"><method name="Get"><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="v" direction="out"/></method>
<signal name="PropertiesChanged"><arg type="s"/><arg type="a{sv}"/><arg type="as"/></signal></interface>
<interface name="org.freedesktop.login1.Session"><method name="SetLockedHint"><arg type="b" direction="in"/></method></interface></node>'''

def inhibit(invocation, values):
    read, write = os.pipe2(os.O_CLOEXEC | os.O_NONBLOCK)
    inhibitors[read] = (*values, os.getuid(), os.getpid())
    def released(fd, condition):
        inhibitors.pop(fd, None)
        os.close(fd)
        return GLib.SOURCE_REMOVE
    GLib.io_add_watch(read, GLib.IO_HUP, released)
    fds = Gio.UnixFDList.new()
    index = fds.append(write)
    os.close(write)
    invocation.return_value_with_unix_fd_list(GLib.Variant('(h)', (index,)), fds)

def method(connection, sender, object_path, interface, name, parameters, invocation):
    global active, reject, held, locked
    values = parameters.unpack()
    if name == 'GetSessionByPID': return invocation.return_value(GLib.Variant('(o)', (path,)))
    if name.startswith('Can'): return invocation.return_value(GLib.Variant('(s)', ('yes',)))
    if name == 'Get': return invocation.return_value(GLib.Variant('(v)', (GLib.Variant('b', active),)))
    if name == 'SetLockedHint': locked = values[0]
    elif name == 'LockedHint': return invocation.return_value(GLib.Variant('(b)', (locked,)))
    elif name == 'ListInhibitors': return invocation.return_value(GLib.Variant('(a(ssssuu))', (list(inhibitors.values()),)))
    elif name == 'Inhibit':
        if values[3] == 'block' and reject:
            return invocation.return_dbus_error('org.freedesktop.DBus.Error.AccessDenied', 'Test inhibitor denial')
        if values[3] == 'block' and held: pending.append((invocation, values))
        else: inhibit(invocation, values)
        return
    elif name == 'Prepare': bus.emit_signal(None, root, 'org.freedesktop.login1.Manager', 'PrepareForSleep', parameters)
    elif name == 'Active':
        active = values[0]
        bus.emit_signal(None, path, 'org.freedesktop.DBus.Properties', 'PropertiesChanged',
                        GLib.Variant('(sa{sv}as)', ('org.freedesktop.login1.Session', {'Active': GLib.Variant('b', active)}, [])))
    elif name == 'RejectInhibit': reject = values[0]
    elif name == 'HoldInhibit':
        held = values[0]
        if not held:
            for request, args in pending: inhibit(request, args)
            pending.clear()
    else: return invocation.return_dbus_error('org.freedesktop.DBus.Error.UnknownMethod', name)
    invocation.return_value(None)

for location, document in [(root, xml), (path, session_xml)]:
    for interface in Gio.DBusNodeInfo.new_for_xml(document).interfaces:
        bus.register_object(location, interface, method, None, None)
bus.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'RequestName',
              GLib.Variant('(su)', ('org.freedesktop.login1', 4)), None, Gio.DBusCallFlags.NONE, 2000, None)
GLib.MainLoop().run()
