import { ssidBytes, ssidName } from './wifi-model.js';
// DBus data and display normalization are independent of the native coordinator.
const NM = 'org.freedesktop.NetworkManager', MM = 'org.freedesktop.ModemManager1';
const relevant = new Set(['NetworkingEnabled', 'WirelessEnabled', 'WirelessHardwareEnabled', 'WwanEnabled', 'WwanHardwareEnabled',
  'State', 'Connectivity', 'PrimaryConnectionType', 'ActiveAccessPoint', 'Strength', 'Ssid', 'SignalQuality', 'AccessTechnologies', 'RegistrationState', 'OperatorName']);
export function networkStatus(network = {}, modems = {}, online = false, modemOnline = false) {
  const manager = network['/org/freedesktop/NetworkManager']?.[NM] || {};
  const enabled = online && manager.NetworkingEnabled === true;
  const result = { NetworkAvailable: online, NetworkState: !online ? 'unavailable' : !enabled ? 'disabled' : manager.State >= 50 ? 'connected' : manager.State === 40 ? 'connecting' : 'offline',
    NetworkConnectivity: ({ 4: 'full', 3: 'limited', 2: 'portal', 1: 'none' })[manager.Connectivity] || 'unknown',
    NetworkType: ({ '802-11-wireless': 'wifi', gsm: 'cellular', cdma: 'cellular', '802-3-ethernet': 'ethernet' })[manager.PrimaryConnectionType] || (manager.PrimaryConnectionType ? 'other' : 'none'),
    WifiState: 'unavailable', WifiStrength: -1, WifiSsid: '', CellularState: 'unavailable', CellularStrength: -1, CellularTechnology: '', CellularOperator: '' };
  if (online && (!enabled || !manager.WirelessEnabled || !manager.WirelessHardwareEnabled)) result.WifiState = 'disabled';
  let best = -1;
  for (const interfaces of Object.values(online ? network : {})) {
    const wireless = interfaces[NM + '.Device.Wireless'];
    if (!wireless || result.WifiState === 'disabled') continue;
    const state = interfaces[NM + '.Device']?.State ?? -1;
    const rank = state === 100 ? 3 : state >= 40 && state <= 90 ? 2 : state >= 30 ? 1 : 0;
    if (rank <= best) continue;
    best = rank; result.WifiState = ['unavailable', 'disconnected', 'connecting', 'connected'][rank]; result.WifiStrength = -1; result.WifiSsid = '';
    if (rank !== 3) continue;
    const ap = network[wireless.ActiveAccessPoint]?.[NM + '.AccessPoint'] || {};
    result.WifiStrength = ap.Strength ?? -1;
    result.WifiSsid = ssidName(ssidBytes(ap.Ssid));
  }
  best = -2;
  for (const interfaces of Object.values(modemOnline ? modems : {})) {
    const modem = interfaces[MM + '.Modem'];
    if (!modem || (modem.State ?? -1) <= best) continue;
    const state = best = modem.State ?? -1;
    result.CellularState = state >= 8 ? 'registered' : state === 7 ? 'searching' : state === 2 ? 'locked' : state === 3 || state === 4 ? 'disabled' : state < 0 ? 'failed' : 'offline';
    result.CellularStrength = -1; result.CellularTechnology = ''; result.CellularOperator = '';
    if (state < 8) continue;
    const [quality, recent] = modem.SignalQuality || [-1, false];
    if (recent && quality >= 0 && quality <= 100) result.CellularStrength = quality;
    const access = modem.AccessTechnologies === 0xffffffff ? 0 : modem.AccessTechnologies || 0;
    result.CellularTechnology = access & (1 << 15) ? '5G' : access & ((1 << 14) | (1 << 16) | (1 << 17)) ? '4G' : access & 0x3fe0 ? '3G' : access & 0x1e ? '2G' : '';
    const registration = interfaces[MM + '.Modem.Modem3gpp'] || {};
    if ([5, 7, 10].includes(registration.RegistrationState)) result.CellularState = 'roaming';
    result.CellularOperator = registration.OperatorName || '';
  }
  if (online && (!enabled || !manager.WwanEnabled || !manager.WwanHardwareEnabled)) {
    result.CellularState = 'disabled'; result.CellularStrength = -1; result.CellularTechnology = ''; result.CellularOperator = '';
  }
  return result;
}
export function createNetworkStatus(bus, changed) {
  let closed = false, retry = 0, watching = false, matched = false;
  const services = [{ name: NM, path: '/org/freedesktop', objects: {}, owner: '', generation: 0 },
    { name: MM, path: '/org/freedesktop/ModemManager1', objects: {}, owner: '', generation: 0 }];
  const publish = () => changed(networkStatus(services[0].objects, services[1].objects, !!services[0].owner, !!services[1].owner));
  const read = async service => {
    const token = ++service.generation;
    try {
      const owner = await bus.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'GetNameOwner', 's', service.name);
      const objects = await bus.call(service.name, service.path, 'org.freedesktop.DBus.ObjectManager', 'GetManagedObjects');
      if (closed || token !== service.generation) return;
      service.owner = owner; service.objects = objects;
    } catch (_) { if (closed || token !== service.generation) return; service.owner = ''; service.objects = {}; }
    publish();
  };
  const signal = event => {
    if (closed) return;
    if (event.interface === 'org.freedesktop.DBus.Local' && event.member === 'Disconnected') {
      unavailable(); reconnect(); return;
    }
    if (event.interface === 'org.freedesktop.DBus' && event.member === 'NameOwnerChanged') {
      const service = services.find(value => value.name === event.args[0]);
      if (!service) return;
      ++service.generation; service.owner = event.args[2]; service.objects = {}; publish();
      if (service.owner) read(service);
      return;
    }
    const modem = event.interface === 'org.freedesktop.DBus.Properties' ? event.args[0]?.startsWith(MM + '.') : String(event.args[0] || event.path).startsWith('/org/freedesktop/ModemManager1');
    const service = services[modem ? 1 : 0];
    if (!service.owner || service.owner !== event.sender) return;
    if (event.interface === 'org.freedesktop.DBus.ObjectManager') { read(service); return; }
    if (event.interface !== 'org.freedesktop.DBus.Properties' || event.member !== 'PropertiesChanged') return;
    const [iface, changes, invalidated] = event.args;
    if (!Object.keys(changes || {}).some(key => relevant.has(key)) && !(invalidated || []).some(key => relevant.has(key))) return;
    if (invalidated?.length) { read(service); return; }
    service.objects[event.path] ||= {}; service.objects[event.path][iface] ||= {};
    Object.assign(service.objects[event.path][iface], changes); publish();
  };
  const unavailable = () => {
    for (const service of services) { ++service.generation; service.owner = ''; service.objects = {}; }
    publish();
  };
  const reconnect = () => {
    if (closed || retry) return;
    retry = setTimeout(() => { retry = 0; connect(); }, 1000);
  };
  const connect = async () => {
    try {
      await bus.connect();
      if (closed) return;
      if (!matched) {
        for (const service of services) {
          bus.addMatch("type='signal',sender='org.freedesktop.DBus',interface='org.freedesktop.DBus',member='NameOwnerChanged',arg0='" + service.name + "'");
          bus.addMatch("type='signal',sender='" + service.name + "',interface='org.freedesktop.DBus.Properties'");
          bus.addMatch("type='signal',sender='" + service.name + "',interface='org.freedesktop.DBus.ObjectManager'");
        }
        matched = true;
      }
      await Promise.all(services.map(read));
    } catch (_) { if (!closed) { unavailable(); reconnect(); } }
  };
  return { start: async () => {
    if (!watching) { bus.onSignal(signal); watching = true; }
    await connect();
  }, dispose: () => {
    closed = true; if (retry) clearTimeout(retry);
    bus.offSignal(signal);
    for (const service of services) ++service.generation;
  } };
}
