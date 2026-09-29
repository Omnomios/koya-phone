import { Bus, fixture, wait, assert, equal, run } from './check.js';
import { wifiNetwork } from '../apps/wifi-network.js';
import { validPassword } from '../apps/wifi-model.js';
const NM = 'org.freedesktop.NetworkManager', path = '/org/freedesktop/NetworkManager';
const control = (method, signature = '', ...args) => Bus.call(NM, path, 'org.koya.Test.Wifi', method, signature, ...args);
export default run(async () => {
  fixture('wifi');
  await wait(async () => { await control('Counts'); return true; });
  const backend = wifiNetwork();
  try {
    await backend.start(); await wait(() => !backend.state.loading && !backend.state.scanning);
    const list = backend.state.networks;
    assert(list.length === 5 && list[0].name === 'Home' && list[0].connected, 'Network grouping: ' + backend.readError);
    assert(await backend.connect(list[0]), 'Saved profile activation failed'); await wait(() => !backend.state.working);
    const network = list.find(item => item.name === 'Grün');
    assert(network && network.Strength === 91 && network.ssid.length === 5, 'SSID bytes or strongest AP selection');
    assert(!list.find(item => item.name === 'Office').supported, 'Enterprise network enabled');
    assert(!validPassword('wpa-psk', 'short') && validPassword('sae', 'x'), 'Password validation');
    assert(!await backend.connect(network, 'wrong-password'), 'Rejected credentials accepted'); assert(backend.state.error);
    assert(await backend.connect(network, 'test-password')); await wait(() => backend.state.networks.some(item => item.name === 'Grün' && item.connected));
    await backend.disconnect(); await wait(() => backend.state.deviceState === 30);
    assert(await backend.connect(network, 'test-password')); await wait(() => !backend.state.working);
    const counts = await control('Counts'); equal([counts.Profiles, counts.Connects, counts.Writes], [2, 3, 2], 'Profile retry duplicated saved connection');
    await backend.toggle(); assert(!backend.state.enabled); await backend.toggle(); assert(backend.state.enabled);
    await control('Reject', 'b', true); await backend.disconnect(); assert(/authorised/.test(backend.state.error), 'Permission denial not shown');
  } finally { backend.dispose(); }
});
