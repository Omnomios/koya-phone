import build from '../apps/top-bar.js';
import { Notifications } from '../apps/notifications-model.js';
import * as UI from 'Helix/UserInterface';
import * as Screenshot from 'Koya/Screenshot';
import * as Image from 'Koya/Image';
import * as Compositor from 'Koya/Compositor';
import * as Process from 'Module/process';

export default async () => {
  // Model tests run in Koya's actual JS runtime, with controllable one-shot timers.
  const signals = [], timers = new Map(); let serial = 0;
  const model = new Notifications({ signal: (...args) => signals.push(args),
    schedule: fn => { timers.set(++serial, fn); return serial; }, cancel: id => timers.delete(id) });
  const args = ['App', 0, '', 'Hello', '<b>World</b> &amp; friends', ['default', 'Open'], {}, 100];
  const id = model.notify(':test', args);
  const replacement = model.notify(':test', [...args.slice(0, 1), id, ...args.slice(2)]);
  if (id !== replacement || model.items.length !== 1 || timers.size !== 1 || model.items[0].body !== 'World & friends') throw new Error('Notification replacement/markup/timer model failed');
  [...timers.values()][0]();
  if (model.items[0].active || model.items[0].actions.length || signals[0][4] !== 1) throw new Error('Expiry should retain passive history and emit reason 1');
  const resident = model.notify(':test', ['App', 0, '', 'Resident', '', ['default', 'Open'], { resident: true }, 0]);
  model.invoke(resident, 'default');
  if (!model.records.get(resident).active) throw new Error('Resident notification was closed by its action');
  model.clear();
  if (model.items.length) throw new Error('Clear did not empty notification model');
  model.dispose();
  await build();
  const controller = globalThis.koyaNotifications;
  const changed = controller.model.changed;
  let timer, captured = false;
  controller.model.changed = event => {
    changed(event);
    if (event.type === 'notify' && event.item.app === 'Locked test') {
      setTimeout(() => {
        Process.writeFileText('/tmp/koya-notifications-locked.json', JSON.stringify({ banner: controller.bannerWindow,
          center: controller.centerWindow, retained: controller.model.records.has(event.item.id) }));
      }, 300);
      return;
    }
    if (captured || event.type !== 'notify') return;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      captured = true;
      try {
        const capture = async (win, name) => {
          if (!win) throw new Error('Missing notification ' + name + ' window');
          const info = await Compositor.getWindowInfo(win);
          if (!await Screenshot.capture(win, { id: name, source: 'vulkan', mipmaps: false })) throw new Error('Screenshot unavailable');
          const bytes = await Image.encode(win, { src: '/ram/screenshot/' + name, format: 'png' });
          Process.writeFile('/tmp/koya-notification-' + name + '.png', bytes instanceof ArrayBuffer ? bytes : Uint8Array.from(bytes).buffer);
          return info;
        };
        const banner = await capture(controller.bannerWindow, 'banner');
        await controller.open();
        setTimeout(async () => {
          try {
            const center = await capture(controller.centerWindow, 'center');
            const first = controller.model.items.find(item => item.actions.some(action => action.key === 'default'));
            const frame = await UI.getElementFrame(controller.centerWindow, await UI.getElementById(controller.centerWindow, 'notification-' + first.id));
            if (frame.min.x !== 20 || frame.max.x !== 520 || frame.size.y < 204) throw new Error('Notification card padding/size incorrect: ' + JSON.stringify(frame));
            const items = controller.model.items.map(({ timer, ...item }) => item);
            controller.model.invoke(first.id, 'default');
            Process.writeFileText('/tmp/koya-notifications.json', JSON.stringify({ banner, center, frame, items, unread: controller.model.unread }));
          } catch (error) { Process.writeFileText('/tmp/koya-desktop-error.json', JSON.stringify({ error: String(error) })); }
        }, 400);
      } catch (error) { Process.writeFileText('/tmp/koya-desktop-error.json', JSON.stringify({ error: String(error) })); }
    }, 800);
  };
};
