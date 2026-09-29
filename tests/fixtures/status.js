import { Bus, typed as t, serve, properties, changed, own, daemon, start } from './service.js';
const NM = 'org.freedesktop.NetworkManager', MM = 'org.freedesktop.ModemManager1';
const objects = {
  '/org/freedesktop/NetworkManager': { [NM]: {
    NetworkingEnabled: t('b', true), WirelessEnabled: t('b', true), WirelessHardwareEnabled: t('b', true),
    WwanEnabled: t('b', true), WwanHardwareEnabled: t('b', true), State: t('u', 70),
    Connectivity: t('u', 4), PrimaryConnectionType: t('s', '802-11-wireless') } },
  '/org/freedesktop/NetworkManager/Devices/1': {
    [NM + '.Device']: { State: t('u', 100) },
    [NM + '.Device.Wireless']: { ActiveAccessPoint: t('o', '/org/freedesktop/NetworkManager/AccessPoint/1') } },
  '/org/freedesktop/NetworkManager/AccessPoint/1': { [NM + '.AccessPoint']: {
    Strength: t('y', 76), Ssid: t('ay', Array.from('Koya test', c => c.charCodeAt(0))) } },
  '/org/freedesktop/ModemManager1/Modem/0': {
    [MM + '.Modem']: { State: t('i', 8), SignalQuality: t('(ub)', [47, true]), AccessTechnologies: t('u', 1 << 14) },
    [MM + '.Modem.Modem3gpp']: { RegistrationState: t('u', 1), OperatorName: t('s', 'Test carrier') } }
};
export default start(async () => {
  for (const [path, interfaces] of Object.entries(objects)) properties(path, interfaces);
  for (const path of ['/org/freedesktop', '/org/freedesktop/ModemManager1']) {
    serve(path, 'org.freedesktop.DBus.ObjectManager', call => {
      if (call.member !== 'GetManagedObjects') return call.error('org.freedesktop.DBus.Error.UnknownMethod', call.member);
      const modem = path.endsWith('ModemManager1');
      call.reply('a{oa{sa{sv}}}', Object.fromEntries(Object.entries(objects).filter(([p]) => p.includes('/ModemManager1/') === modem)));
    });
  }
  serve('/org/koya/Test/Status', 'org.koya.Test.Status', async call => {
    if (call.member === 'Update') {
      const [target, changes] = call.args;
      for (const [path, interfaces] of Object.entries(objects)) {
        if (!interfaces[target]) continue;
        for (const [key, value] of Object.entries(changes)) {
          if (!(key in interfaces[target])) throw new Error('Unknown property ' + key);
          interfaces[target][key] = t(interfaces[target][key]._t, value);
        }
        changed(path, target, interfaces[target]); call.reply(''); return;
      }
      return call.error('org.koya.Test.UnknownInterface', target);
    }
    if (call.member === 'Drop') await daemon('ReleaseName', 's', call.args[0]);
    else if (call.member === 'Own') await own(call.args[0]);
    else return call.error('org.freedesktop.DBus.Error.UnknownMethod', call.member);
    call.reply('');
  });
  for (const name of [NM, MM, 'org.koya.Test.Status']) await own(name);
});
