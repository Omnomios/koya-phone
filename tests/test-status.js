import { Bus, Process, runtime, fixture, coordinator, call, state, waitState, wait, sleep, assert, run } from './check.js';
const NM = 'org.freedesktop.NetworkManager', MM = 'org.freedesktop.ModemManager1';
const control = (method, signature, ...args) => Bus.callComplex('org.koya.Test.Status', '/org/koya/Test/Status', 'org.koya.Test.Status', method, signature, ...args);
const update = (iface, props) => control('Update', 'sa{sv}', iface, props);
const battery = () => Bus.call('org.koya.Shell1', '/org/koya/Shell1', 'org.koya.Shell1.Test', 'PowerSupplyChanged');
const write = (path, value) => Process.writeFileText(runtime + '/power/' + path, value + '\n');
export default run(async () => {
  fixture('login'); fixture('status'); coordinator();
  await waitState(s => s['top-barStatus'] === 'ready' && s.BatteryPercent === 73 && s.WifiStrength === 76 && s.CellularTechnology === '4G');
  const initial = await state();
  assert(initial.NetworkConnectivity === 'full' && initial.WifiSsid === 'Koya test' && initial.CellularStrength === 47 && initial.CellularOperator === 'Test carrier', JSON.stringify(initial));
  write('usb/online', '1'); write('battery/status', 'Charging'); await battery();
  await waitState(s => s.ExternalPower && s.BatteryState === 'charging');
  write('battery/capacity', '14'); await battery(); await waitState(s => s.BatteryPercent === 14);
  await update(NM + '.AccessPoint', { Strength: {_t: 'y', _v: 22} }); await waitState(s => s.WifiStrength === 22);
  await update(NM, { Connectivity: {_t: 'u', _v: 2} }); await waitState(s => s.NetworkConnectivity === 'portal');
  await update(NM, { WirelessEnabled: false }); await waitState(s => s.WifiState === 'disabled' && s.WifiStrength === -1 && s.WifiSsid === '');
  await update(MM + '.Modem.Modem3gpp', { RegistrationState: {_t: 'u', _v: 5} }); await waitState(s => s.CellularState === 'roaming');
  await update(MM + '.Modem', { SignalQuality: {_t: '(ub)', _v: [90, false]} }); await waitState(s => s.CellularStrength === -1);
  for (const name of [NM, MM]) {
    await control('Drop', 's', name);
    await waitState(s => name === NM ? !s.NetworkAvailable && s.WifiState === 'unavailable' : s.CellularState === 'unavailable');
    await control('Own', 's', name); await waitState(s => s.NetworkAvailable && s.CellularState === 'roaming');
  }
  write('battery/capacity', 'invalid'); await battery(); await waitState(s => s.BatteryPresent && s.BatteryPercent === -1);
  write('battery/present', '0'); await battery(); await waitState(s => !s.BatteryPresent);
  await sleep(150);
  const events = [];
  Bus.addMatch("type='signal',interface='org.koya.Shell1',member='StateChanged'");
  Bus.onSignal(sig => { if (sig.member === 'StateChanged') events.push(sig); });
  await call('GetState'); await battery(); await sleep(150);
  assert(events.length === 0, 'Unchanged battery event emitted a redraw notification');
});
