import build from '../apps/top-bar.js';
import { topBarStatus } from '../apps/status-model.js';
import { call } from '../apps/session.js';
import * as UI from 'Helix/UserInterface';
import * as Compositor from 'Koya/Compositor';
import * as Screenshot from 'Koya/Screenshot';
import * as Image from 'Koya/Image';
import * as Process from 'Module/process';

export default async () => {
  const win = await build();
  setTimeout(async () => {
    try {
      const state = await call('GetState');
      const status = topBarStatus(state);
      if (status.batteryText !== '73%' || !status.charging || status.wifiIcon !== 'wifi-3' || status.cellIcon !== 'cell-2' || status.cellText !== '4G') throw new Error('Live status was not projected correctly');
      const low = topBarStatus({ BatteryPresent: true, BatteryPercent: 14, BatteryState: 'discharging' });
      const unknown = topBarStatus({ BatteryPresent: true, BatteryPercent: -1 });
      const portal = topBarStatus({ NetworkState: 'connected', NetworkConnectivity: 'portal' });
      if (!low.batteryLow || unknown.batteryText !== '—' || unknown.batteryIcon !== 'battery-unknown' || !portal.warning) throw new Error('Status edge cases failed');
      const info = await Compositor.getWindowInfo(win);
      const frame = await UI.getElementFrame(win, await UI.getElementById(win, 'top-bar-status'));
      const percentage = await UI.getElementFrame(win, await UI.getElementById(win, 'top-bar-battery-percent'));
      if (!await Screenshot.capture(win, { id: 'top-bar', source: 'vulkan', mipmaps: false })) throw new Error('Capture unavailable');
      const png = await Image.encode(win, { src: '/ram/screenshot/top-bar', format: 'png' });
      Process.writeFile('/tmp/koya-top-bar.png', png instanceof ArrayBuffer ? png : Uint8Array.from(png).buffer);
      Process.writeFileText('/tmp/koya-top-bar.json', JSON.stringify({ info, frame, percentage, status }));
    } catch (error) { Process.writeFileText('/tmp/koya-desktop-error.json', JSON.stringify({ error: String(error) })); }
  }, 1000);
};
