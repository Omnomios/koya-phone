import { system as System } from 'Module/dbus';
import { createNetworkStatus } from '../apps/network-status.js';
import { Process, root, runtime, spawn, stop, wait, assert, run } from './check.js';

export default run(async () => {
  let snapshot = {};
  const status = createNetworkStatus(System, value => { snapshot = value; });
  const address = Process.getEnv('DBUS_SYSTEM_BUS_ADDRESS');
  assert(address === 'unix:path=' + runtime + '/system-bus', 'Expected an isolated system bus');
  await status.start();
  assert(!snapshot.NetworkAvailable, 'Missing bus must report unavailable');
  const daemon = () => spawn('dbus-daemon', ['--session', '--nofork', '--address=' + address]);
  const services = () => spawn('env', ['DBUS_SESSION_BUS_ADDRESS=' + address, 'KOYA_TEST_ENTRY=status', root + '/tests/fixtures/koya-fixture.sh']);
  let bus = daemon();
  await wait(() => Process.exists(runtime + '/system-bus'), 'Test bus did not start');
  let fixture = services();
  await wait(() => snapshot.WifiStrength === 76 && snapshot.CellularTechnology === '4G', 'Initial bus recovery failed');
  await stop(bus);
  await wait(() => !snapshot.NetworkAvailable && snapshot.WifiState === 'unavailable' && snapshot.CellularState === 'unavailable', 'Disconnected bus retained stale status');
  await stop(fixture);
  bus = daemon();
  await wait(() => Process.exists(runtime + '/system-bus'), 'Test bus did not restart');
  fixture = services();
  await wait(() => snapshot.WifiStrength === 76 && snapshot.CellularTechnology === '4G', 'Restarted bus recovery failed');
  await System.callComplex('org.koya.Test.Status', '/org/koya/Test/Status', 'org.koya.Test.Status', 'Update', 'sa{sv}',
    'org.freedesktop.NetworkManager.AccessPoint', { Strength: { _t: 'y', _v: 18 } });
  await wait(() => snapshot.WifiStrength === 18, 'Restart did not restore property subscriptions');
  status.dispose();
  await stop(bus); await stop(fixture);
});
