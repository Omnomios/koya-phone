import build from '../apps/wifi.js';
import { validPassword } from '../apps/wifi-model.js';
import { system as Bus } from 'Module/dbus';
import * as UI from 'Helix/UserInterface';
import * as Screenshot from 'Koya/Screenshot';
import * as Image from 'Koya/Image';
import * as Process from 'Module/process';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export default async () => {
  const win = await build({ keyboard: false });
  setTimeout(async () => {
    try {
      const app = globalThis.koyaWifi, backend = app.backend;
      const wait = async predicate => { for (let i=0; i<100 && !predicate(); i++) await pause(20); if (!predicate()) throw new Error('Wi-Fi state did not settle'); };
      await wait(() => !backend.state.loading && !backend.state.scanning);
      const list = backend.state.networks;
      if (list.length !== 5 || list[0].name !== 'Home' || !list[0].connected) throw new Error('Network grouping/active state failed: ' + backend.readError);
      if (!await backend.connect(list[0])) throw new Error('Saved profile activation failed');
      await wait(() => !backend.state.working);
      const network = list.find(item => item.name === 'Grün');
      if (!network || network.Strength !== 91 || network.ssid.length !== 5) throw new Error('SSID bytes or strongest AP selection failed');
      if (list.find(item => item.name === 'Office').supported) throw new Error('Unsupported enterprise network enabled');
      if (validPassword('wpa-psk', 'short') || !validPassword('sae', 'x')) throw new Error('Password validation failed');
      const capture = async name => {
        await pause(300);
        if (!await Screenshot.capture(win, { id: name, source: 'vulkan', mipmaps: false })) throw new Error('Capture unavailable');
        const bytes = await Image.encode(win, { src: '/ram/screenshot/'+name, format: 'png' });
        Process.writeFile('/tmp/koya-wifi-'+name+'.png', bytes instanceof ArrayBuffer ? bytes : Uint8Array.from(bytes).buffer);
      };
      await capture('list');
      await app.openForm(network); await app.setPassword('test-password');
      await pause(100); // Layout is recomputed before presentation.
      const frame = await UI.getElementFrame(win, await UI.getElementById(win, 'wifi-password'));
      if (frame.size.y !== 72) throw new Error('Password field touch area too small');
      await capture('password');
      if (await backend.connect(network, 'wrong-password')) throw new Error('Rejected credentials were accepted');
      if (!backend.state.error) throw new Error('Credential failure not shown');
      await app.submit();
      await wait(() => backend.state.networks.some(item => item.name === 'Grün' && item.connected));
      if (app.password !== '') throw new Error('Password retained after submission');
      await backend.disconnect(); await wait(() => backend.state.deviceState === 30);
      await backend.connect(network, 'test-password'); // Retry updates our profile instead of duplicating it.
      await wait(() => !backend.state.working);
      const counts = await Bus.call('org.freedesktop.NetworkManager', '/org/freedesktop/NetworkManager', 'org.koya.Test.Wifi', 'Counts');
      if (counts.Profiles !== 2 || counts.Connects !== 3 || counts.Writes !== 2) throw new Error('Profile retry duplicated a saved connection: ' + JSON.stringify(counts));
      await backend.toggle(); if (backend.state.enabled) throw new Error('Wi-Fi switch did not turn off');
      await backend.toggle(); if (!backend.state.enabled) throw new Error('Wi-Fi switch did not turn on');
      await Bus.call('org.freedesktop.NetworkManager', '/org/freedesktop/NetworkManager', 'org.koya.Test.Wifi', 'Reject', 'b', true);
      await backend.disconnect(); if (!/authorised/.test(backend.state.error)) throw new Error('Permission denial not shown');
      backend.dispose();
      Process.writeFileText('/tmp/koya-wifi.json', JSON.stringify({ passed: true, frame }));
    } catch (error) { globalThis.koyaWifi?.backend.dispose(); Process.writeFileText('/tmp/koya-desktop-error.json', JSON.stringify({ error: String(error) })); }
  }, 800);
};
