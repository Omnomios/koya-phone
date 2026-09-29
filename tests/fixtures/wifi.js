import { typed as t, serve, properties, changed, own, start } from './service.js';
const NM = 'org.freedesktop.NetworkManager', ROOT = '/org/freedesktop/NetworkManager';
const DEVICE = ROOT + '/Devices/1', ACTIVE = ROOT + '/ActiveConnection/1', SAVED = ROOT + '/Settings/1';
const bytes = text => Array.from(text).flatMap(c => {
  const n = c.codePointAt(0);
  return n < 128 ? [n] : [0xc0 | (n >> 6), 0x80 | (n & 63)];
});
const objects = {
  [ROOT]: { [NM]: { WirelessEnabled: t('b', true), WirelessHardwareEnabled: t('b', true), State: t('u', 70) } },
  [DEVICE]: {
    [NM + '.Device']: { DeviceType: t('u', 2), State: t('u', 100), ActiveConnection: t('o', ACTIVE), AvailableConnections: t('ao', [SAVED]), StateReason: t('(uu)', [100, 0]) },
    [NM + '.Device.Wireless']: { AccessPoints: t('ao', []), ActiveAccessPoint: t('o', ROOT + '/AccessPoint/1'), LastScan: t('x', 1) } }
};
for (const [index, [name, strength, flags]] of [['Home', 62, 0x100], ['Grün', 91, 0x100], ['Grün', 40, 0x100], ['Open', 55, 0], ['Office', 80, 0x200], ['WPA3', 75, 0x400]].entries()) {
  objects[ROOT + '/AccessPoint/' + (index + 1)] = { [NM + '.AccessPoint']: {
    Ssid: t('ay', bytes(name)), Strength: t('y', strength), Flags: t('u', flags ? 1 : 0), RsnFlags: t('u', flags), WpaFlags: t('u', 0) } };
}
objects[DEVICE][NM + '.Device.Wireless'].AccessPoints = t('ao', Object.keys(objects).filter(path => path.includes('/AccessPoint/')));
const profiles = { [SAVED]: { connection: { id: t('s', 'Home'), type: t('s', '802-11-wireless') },
  '802-11-wireless': { ssid: t('ay', bytes('Home')) }, '802-11-wireless-security': { 'key-mgmt': t('s', 'wpa-psk') } } };
let scans = 0, connects = 0, writes = 0, reject = false;
function update(path, iface, key, value) { objects[path][iface][key] = value; changed(path, iface, {[key]: value}); }
function connected(ap) {
  update(DEVICE, NM + '.Device.Wireless', 'ActiveAccessPoint', t('o', ap));
  update(DEVICE, NM + '.Device', 'ActiveConnection', t('o', ACTIVE));
  update(DEVICE, NM + '.Device', 'State', t('u', 100));
}
function settings(input) {
  if (!Array.isArray(input['802-11-wireless'].ssid) || !Array.isArray(input.connection.permissions)) throw new Error('Invalid profile arrays');
  const security = input['802-11-wireless-security'] || {};
  if (['wpa-psk', 'sae'].includes(security['key-mgmt']) && security.psk !== 'test-password') return null;
  // Retain the profile schema when returning decoded arguments as variants.
  return Object.fromEntries(Object.entries(input).map(([group, props]) => [group,
    Object.fromEntries(Object.entries(props).map(([key, value]) => [key,
      t(key === 'ssid' ? 'ay' : key === 'permissions' ? 'as' : key === 'psk-flags' ? 'u' : typeof value === 'boolean' ? 'b' : typeof value === 'number' ? 'i' : 's', value)]))]));
}
function registerProfile(path) { serve(path, NM + '.Settings.Connection', method); }
function method(call) {
  const {member, path, args} = call;
  if (reject && ['ActivateConnection', 'AddAndActivateConnection', 'RequestScan', 'Disconnect'].includes(member)) return call.error(NM + '.PermissionDenied', 'Not authorized');
  if (member === 'GetDevices') return call.reply('ao', [DEVICE]);
  if (member === 'RequestScan') { scans++; update(DEVICE, NM + '.Device.Wireless', 'LastScan', t('x', 1 + scans)); }
  else if (member === 'GetSettings') return call.reply('a{sa{sv}}', profiles[path]);
  else if (member === 'Update' || member === 'AddAndActivateConnection') {
    const profile = settings(args[0]);
    if (!profile) return call.error(NM + '.NoSecrets', 'Password rejected');
    writes++;
    if (member === 'Update') profiles[path] = profile;
    else {
      connects++; const name = ROOT + '/Settings/' + (1 + writes); profiles[name] = profile; registerProfile(name);
      update(DEVICE, NM + '.Device', 'AvailableConnections', t('ao', Object.keys(profiles)));
      connected(args[2]); return call.reply('oo', name, ACTIVE);
    }
  } else if (member === 'ActivateConnection') {
    const [profile, device, ap] = args;
    if (device !== DEVICE) throw new Error('Unexpected device');
    if (profile === '/' && !Object.values(profiles).some(p => JSON.stringify(p['802-11-wireless'].ssid._v) === JSON.stringify(objects[ap][NM + '.AccessPoint'].Ssid._v))) return call.error(NM + '.UnknownConnection', 'No compatible saved profile');
    connects++; connected(ap); return call.reply('o', ACTIVE);
  } else if (member === 'Disconnect') {
    update(DEVICE, NM + '.Device.Wireless', 'ActiveAccessPoint', t('o', '/'));
    update(DEVICE, NM + '.Device', 'ActiveConnection', t('o', '/')); update(DEVICE, NM + '.Device', 'State', t('u', 30));
  } else if (member === 'GetManagedObjects') return call.reply('a{oa{sa{sv}}}', objects);
  else if (member === 'Counts') return call.reply('a{sv}', {Scans: t('u', scans), Connects: t('u', connects), Writes: t('u', writes), Profiles: t('u', Object.keys(profiles).length)});
  else if (member === 'Reject') reject = args[0];
  else return call.error('org.freedesktop.DBus.Error.UnknownMethod', member);
  call.reply('');
}
export default start(async () => {
  for (const [path, interfaces] of Object.entries(objects)) {
    properties(path, interfaces, (call, iface, key, value) => {
      if (reject || iface !== NM || key !== 'WirelessEnabled') return call.error(NM + '.PermissionDenied', 'Not authorized');
      update(path, iface, key, t('b', value)); call.reply('');
    });
    for (const iface of Object.keys(interfaces)) serve(path, iface, method);
  }
  registerProfile(SAVED); serve('/org/freedesktop', 'org.freedesktop.DBus.ObjectManager', method);
  serve(ROOT, 'org.koya.Test.Wifi', method); await own(NM);
});
