#!/usr/bin/python3
"""Read-only NM/MM object trees and property events on a private test bus."""
from gi.repository import Gio, GLib

bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
NM = 'org.freedesktop.NetworkManager'
MM = 'org.freedesktop.ModemManager1'
objects = {
    '/org/freedesktop/NetworkManager': {NM: {
        'NetworkingEnabled': GLib.Variant('b', True), 'WirelessEnabled': GLib.Variant('b', True),
        'WirelessHardwareEnabled': GLib.Variant('b', True), 'WwanEnabled': GLib.Variant('b', True),
        'WwanHardwareEnabled': GLib.Variant('b', True), 'State': GLib.Variant('u', 70),
        'Connectivity': GLib.Variant('u', 4), 'PrimaryConnectionType': GLib.Variant('s', '802-11-wireless')}},
    '/org/freedesktop/NetworkManager/Devices/1': {
        NM+'.Device': {'State': GLib.Variant('u', 100)},
        NM+'.Device.Wireless': {'ActiveAccessPoint': GLib.Variant('o', '/org/freedesktop/NetworkManager/AccessPoint/1')}},
    '/org/freedesktop/NetworkManager/AccessPoint/1': {NM+'.AccessPoint': {
        'Strength': GLib.Variant('y', 76), 'Ssid': GLib.Variant('ay', list(b'Koya test'))}},
    '/org/freedesktop/ModemManager1/Modem/0': {
        MM+'.Modem': {'State': GLib.Variant('i', 8), 'SignalQuality': GLib.Variant('(ub)', (47, True)),
                     'AccessTechnologies': GLib.Variant('u', 1 << 14)},
        MM+'.Modem.Modem3gpp': {'RegistrationState': GLib.Variant('u', 1), 'OperatorName': GLib.Variant('s', 'Test carrier')}}
}

def method(conn, sender, path, iface, member, args, invocation):
    if member == 'GetManagedObjects':
        modem = path.endswith('ModemManager1')
        result = {p: interfaces for p, interfaces in objects.items() if ('/ModemManager1/' in p) == modem}
        invocation.return_value(GLib.Variant('(a{oa{sa{sv}}})', (result,)))
    elif member == 'Update':
        target = args.get_child_value(0).get_string()
        changes = args.get_child_value(1)
        for object_path, interfaces in objects.items():
            if target in interfaces:
                for index in range(changes.n_children()):
                    entry = changes.get_child_value(index)
                    interfaces[target][entry.get_child_value(0).get_string()] = entry.get_child_value(1).get_variant()
                bus.emit_signal(None, object_path, 'org.freedesktop.DBus.Properties', 'PropertiesChanged',
                    GLib.Variant('(sa{sv}as)', (target, interfaces[target], [])))
                invocation.return_value(None)
                return
        invocation.return_dbus_error('org.koya.Test.UnknownInterface', target)
    else:
        name = args.unpack()[0]
        daemon_method = 'ReleaseName' if member == 'Drop' else 'RequestName'
        value = GLib.Variant('(s)', (name,)) if member == 'Drop' else GLib.Variant('(su)', (name, 4))
        bus.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', daemon_method,
                      value, None, Gio.DBusCallFlags.NONE, 2000, None)
        invocation.return_value(None)

def prop(conn, sender, path, iface, name):
    return objects[path][iface][name]

for path, interfaces in objects.items():
    for name, properties in interfaces.items():
        xml = '<node><interface name="'+name+'">'+''.join('<property name="'+key+'" type="'+value.get_type_string()+'" access="read"/>' for key,value in properties.items())+'</interface></node>'
        info = Gio.DBusNodeInfo.new_for_xml(xml)
        bus.register_object(path, info.interfaces[0], None, prop, None)
manager_xml = '<node><interface name="org.freedesktop.DBus.ObjectManager"><method name="GetManagedObjects"><arg type="a{oa{sa{sv}}}" direction="out"/></method><signal name="InterfacesAdded"><arg type="o"/><arg type="a{sa{sv}}"/></signal><signal name="InterfacesRemoved"><arg type="o"/><arg type="as"/></signal></interface></node>'
info = Gio.DBusNodeInfo.new_for_xml(manager_xml)
for path in ('/org/freedesktop', '/org/freedesktop/ModemManager1'):
    bus.register_object(path, info.interfaces[0], method, None, None)
control_xml = '<node><interface name="org.koya.Test.Status"><method name="Update"><arg type="s" direction="in"/><arg type="a{sv}" direction="in"/></method><method name="Drop"><arg type="s" direction="in"/></method><method name="Own"><arg type="s" direction="in"/></method></interface></node>'
info = Gio.DBusNodeInfo.new_for_xml(control_xml)
bus.register_object('/org/koya/Test/Status', info.interfaces[0], method, None, None)
for name in (NM, MM, 'org.koya.Test.Status'):
    bus.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'RequestName', GLib.Variant('(su)', (name, 4)), None, Gio.DBusCallFlags.NONE, 2000, None)
GLib.MainLoop().run()
