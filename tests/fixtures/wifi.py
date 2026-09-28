#!/usr/bin/python3
"""Private NetworkManager transport fixture. Does not touch real networking."""
from gi.repository import Gio, GLib

bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
NM = 'org.freedesktop.NetworkManager'
ROOT = '/org/freedesktop/NetworkManager'
DEVICE = ROOT + '/Devices/1'
ACTIVE = ROOT + '/ActiveConnection/1'
SAVED = ROOT + '/Settings/1'
objects = {
    ROOT: {NM: dict(WirelessEnabled=GLib.Variant('b', True), WirelessHardwareEnabled=GLib.Variant('b', True), State=GLib.Variant('u', 70))},
    DEVICE: {
        NM+'.Device': dict(DeviceType=GLib.Variant('u', 2), State=GLib.Variant('u', 100), ActiveConnection=GLib.Variant('o', ACTIVE),
                          AvailableConnections=GLib.Variant('ao', [SAVED]), StateReason=GLib.Variant('(uu)', (100, 0))),
        NM+'.Device.Wireless': dict(AccessPoints=GLib.Variant('ao', []), ActiveAccessPoint=GLib.Variant('o', ROOT+'/AccessPoint/1'), LastScan=GLib.Variant('x', 1))}}
for index, (name, strength, flags) in enumerate([('Home', 62, 0x100), ('Grün', 91, 0x100), ('Grün', 40, 0x100), ('Open', 55, 0), ('Office', 80, 0x200), ('WPA3', 75, 0x400)], 1):
    path = ROOT+'/AccessPoint/'+str(index)
    objects[path] = {NM+'.AccessPoint': dict(Ssid=GLib.Variant('ay', list(name.encode())), Strength=GLib.Variant('y', strength),
        Flags=GLib.Variant('u', int(bool(flags))), RsnFlags=GLib.Variant('u', flags), WpaFlags=GLib.Variant('u', 0))}
objects[DEVICE][NM+'.Device.Wireless']['AccessPoints'] = GLib.Variant('ao', [path for path in objects if '/AccessPoint/' in path])
profiles = {SAVED: {'connection': {'id': GLib.Variant('s', 'Home'), 'type': GLib.Variant('s', '802-11-wireless')},
                   '802-11-wireless': {'ssid': GLib.Variant('ay', list(b'Home'))},
                   '802-11-wireless-security': {'key-mgmt': GLib.Variant('s', 'wpa-psk')}}}
scans = connects = writes = 0
reject = False

def update(path, iface, name, value):
    objects[path][iface][name] = value
    bus.emit_signal(None, path, 'org.freedesktop.DBus.Properties', 'PropertiesChanged', GLib.Variant('(sa{sv}as)', (iface, {name: value}, [])))

def prop(conn, sender, path, iface, name):
    return objects[path][iface][name]

def setprop(conn, sender, path, iface, name, value):
    if reject: return False
    objects[path][iface][name] = value
    update(path, iface, name, value)
    return True

def connected(ap):
    update(DEVICE, NM+'.Device.Wireless', 'ActiveAccessPoint', GLib.Variant('o', ap))
    update(DEVICE, NM+'.Device', 'ActiveConnection', GLib.Variant('o', ACTIVE))
    update(DEVICE, NM+'.Device', 'State', GLib.Variant('u', 100))

def settings(args):
    settings = {}
    value = args.get_child_value(0)
    for i in range(value.n_children()):
        entry = value.get_child_value(i); group = entry.get_child_value(0).get_string(); nested = entry.get_child_value(1)
        settings[group] = {}
        for j in range(nested.n_children()):
            item = nested.get_child_value(j)
            settings[group][item.get_child_value(0).get_string()] = item.get_child_value(1).get_variant()
    assert settings['802-11-wireless']['ssid'].get_type_string() == 'ay'
    assert settings['connection']['permissions'].get_type_string() == 'as'
    security = settings.get('802-11-wireless-security', {})
    if security.get('key-mgmt', GLib.Variant('s', '')).unpack() in ('wpa-psk', 'sae'):
        assert security['psk-flags'].get_type_string() == 'u'
        if security['psk'].unpack() != 'test-password': raise ValueError('fixture password rejected')
    return settings

def method(conn, sender, path, iface, member, args, invocation):
    global scans, connects, writes, reject
    result = None
    try:
        if reject and member in ('ActivateConnection', 'AddAndActivateConnection', 'RequestScan', 'Disconnect'):
            invocation.return_dbus_error(NM+'.PermissionDenied', 'Not authorized'); return
        if member == 'GetDevices': result = GLib.Variant('(ao)', ([DEVICE],))
        elif member == 'RequestScan':
            scans += 1
            update(DEVICE, NM+'.Device.Wireless', 'LastScan', GLib.Variant('x', 1+scans))
        elif member == 'GetSettings': result = GLib.Variant('(a{sa{sv}})', (profiles[path],))
        elif member == 'Update': profiles[path] = settings(args); writes += 1
        elif member == 'AddAndActivateConnection':
            new = settings(args); writes += 1; connects += 1
            profile = ROOT+'/Settings/'+str(1+writes)
            profiles[profile] = new; register_profile(profile)
            update(DEVICE, NM+'.Device', 'AvailableConnections', GLib.Variant('ao', list(profiles)))
            connected(args.unpack()[2]); result = GLib.Variant('(oo)', (profile, ACTIVE))
        elif member == 'ActivateConnection':
            profile, device, ap = args.unpack()
            if profile == '/':
                ssid = objects[ap][NM+'.AccessPoint']['Ssid'].unpack()
                if not any(entry['802-11-wireless']['ssid'].unpack() == ssid for entry in profiles.values()):
                    invocation.return_dbus_error(NM+'.UnknownConnection', 'No compatible saved profile'); return
            connects += 1; connected(ap); result = GLib.Variant('(o)', (ACTIVE,))
        elif member == 'Disconnect':
            update(DEVICE, NM+'.Device.Wireless', 'ActiveAccessPoint', GLib.Variant('o', '/'))
            update(DEVICE, NM+'.Device', 'ActiveConnection', GLib.Variant('o', '/'))
            update(DEVICE, NM+'.Device', 'State', GLib.Variant('u', 30))
        elif member == 'GetManagedObjects': result = GLib.Variant('(a{oa{sa{sv}}})', (objects,))
        elif member == 'Counts': result = GLib.Variant('(a{sv})', ({'Scans': GLib.Variant('u', scans), 'Connects': GLib.Variant('u', connects), 'Writes': GLib.Variant('u', writes), 'Profiles': GLib.Variant('u', len(profiles))},))
        elif member == 'Reject': reject = args.unpack()[0]
        invocation.return_value(result)
    except ValueError:
        invocation.return_dbus_error(NM+'.NoSecrets', 'Password rejected')

def register(path, xml):
    for iface in Gio.DBusNodeInfo.new_for_xml('<node>'+xml+'</node>').interfaces:
        bus.register_object(path, iface, method, prop, setprop)

def register_profile(path):
    register(path, '<interface name="'+NM+'.Settings.Connection"><method name="GetSettings"><arg type="a{sa{sv}}" direction="out"/></method><method name="Update"><arg type="a{sa{sv}}" direction="in"/></method></interface>')

for path, interfaces in objects.items():
    for iface, properties in interfaces.items():
        methods = ''
        if iface == NM: methods = '<method name="GetDevices"><arg type="ao" direction="out"/></method><method name="ActivateConnection"><arg type="o" direction="in"/><arg type="o" direction="in"/><arg type="o" direction="in"/><arg type="o" direction="out"/></method><method name="AddAndActivateConnection"><arg type="a{sa{sv}}" direction="in"/><arg type="o" direction="in"/><arg type="o" direction="in"/><arg type="o" direction="out"/><arg type="o" direction="out"/></method>'
        elif iface.endswith('.Device.Wireless'): methods = '<method name="RequestScan"><arg type="a{sv}" direction="in"/></method>'
        elif iface.endswith('.Device'): methods = '<method name="Disconnect"/>'
        register(path, '<interface name="'+iface+'">'+methods+''.join('<property name="'+key+'" type="'+value.get_type_string()+'" access="'+('readwrite' if key=='WirelessEnabled' else 'read')+'"/>' for key,value in properties.items())+'</interface>')
register_profile(SAVED)
register('/org/freedesktop', '<interface name="org.freedesktop.DBus.ObjectManager"><method name="GetManagedObjects"><arg type="a{oa{sa{sv}}}" direction="out"/></method></interface>')
register(ROOT, '<interface name="org.koya.Test.Wifi"><method name="Counts"><arg type="a{sv}" direction="out"/></method><method name="Reject"><arg type="b" direction="in"/></method></interface>')
bus.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'RequestName', GLib.Variant('(su)', (NM, 4)), None, Gio.DBusCallFlags.NONE, 2000, None)
GLib.MainLoop().run()
