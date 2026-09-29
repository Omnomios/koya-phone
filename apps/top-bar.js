import * as Compositor from 'Koya/Compositor';
import * as UI from 'Helix/UserInterface';
import * as Log from 'Helix/Log';
import { connect, call } from './session.js';
import { suspendPolicy } from './suspend.js';
import { FONT, BAR_HEIGHT, CREAM, ORANGE, CLEAR, GUTTER } from './theme.js';
import { icon, text, button } from './touch-ui.js';
import { topBarStatus } from './status-model.js';
import { createNotifications } from './notifications.js';
import { createVolume } from './volume.js';

const formatTime = () => {
  const now = new Date();
  return String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
};
export default async (options = {}) => {
  const displays = await Compositor.listDisplays();
  const win = await Compositor.createWindow({
    role: 'bar', edge: 'top', thickness: BAR_HEIGHT, reserveSpace: true,
    display: displays.length ? displays[0].display : '', namespace: 'koya-top-bar',
    msaaSamples: 1, keyboardInteractivity: 'none', acceptPointerEvents: true
  });
  const info = await Compositor.getWindowInfo(win);
  if (info.role !== 'bar') throw new Error('Top bar requires layer-shell');
  await Compositor.setClearColor(win, 0, 0, 0, 1);
  const surface = await UI.createElement(win, { item: { size: { x: info.width, y: BAR_HEIGHT } } });
  await UI.attachRoot(win, surface);
  const root = await UI.createElement(win, {
    layout: { type: 'row', justifyContent: 'start', alignItems: 'center', padding: { l: GUTTER, r: GUTTER - 4, t: 0, b: 0 } },
    item: { size: { x: info.width, y: BAR_HEIGHT } }
  });
  await UI.attach(win, surface, root);
  let displayed = formatTime();
  const clock = await UI.createElement(win, {
    renderable: { type: 'text', string: displayed, size: 21, font: FONT, colour: CREAM, justify: 'left', vAlign: 'center', metricsBasis: 'line' },
    item: { size: { x: 64, y: BAR_HEIGHT } }, contentAlign: { x: 'start', y: 'center' }
  });
  await UI.attach(win, root, clock);
  await UI.setElementId(win, clock, 'top-bar-clock');
  let bell, bellButton, unread = false, hasNotifications = false;
  const notifications = createNotifications(displays[0], (count, total) => {
    const nextUnread = count > 0, nextVisible = total > 0;
    const updates = [];
    if (unread !== nextUnread) updates.push(UI.setTexture(win, bell,
      '/rom/assets/launcher/bell' + (nextUnread ? '-active' : '') + '.png'));
    if (hasNotifications !== nextVisible) updates.push(UI.setEnabled(win, bellButton, nextVisible));
    unread = nextUnread; hasNotifications = nextVisible;
    Promise.all(updates)
      .catch(error => Log.error('Notification indicator: ' + error));
  });
  const volume = createVolume(displays[0], options.volume);
  const sleep = suspendPolicy(() => call('Suspend'), message => Log.error(message));
  bellButton = await button(win, root, '', 44, BAR_HEIGHT, () => notifications.open(), {
    colour: CLEAR, icon: '/rom/assets/launcher/bell.png', iconSize: 20,
    onIcon: value => { bell = value; }
  });
  await UI.setEnabled(win, bellButton, false);
  const spacer = await UI.createElement(win, { item: { flexGrow: 1 } });
  await UI.attach(win, root, spacer);
  const indicators = await UI.createElement(win, {
    layout: { type: 'row', gap: 10, alignItems: 'center', justifyContent: 'end' }, item: { size: { x: 229, y: BAR_HEIGHT } }
  });
  await UI.attach(win, root, indicators);
  const texture = name => '/rom/assets/status/' + name + '.png';
  const wifi = await icon(win, indicators, texture('wifi-off'), 24, 24, BAR_HEIGHT);
  const wired = await icon(win, indicators, texture('ethernet'), 24, 24, BAR_HEIGHT);
  const warning = await text(win, indicators, '!', 18, 10, BAR_HEIGHT, ORANGE);
  const cellular = await UI.createElement(win, { layout: { type: 'row', gap: 3, alignItems: 'center' }, item: { size: { x: 24, y: BAR_HEIGHT } } });
  await UI.attach(win, indicators, cellular);
  const cell = await icon(win, cellular, texture('cell-off'), 24, 24, BAR_HEIGHT);
  const technology = await text(win, cellular, '', 14, 25, BAR_HEIGHT);
  const battery = await UI.createElement(win, { layout: { type: 'row', gap: 5, alignItems: 'center' }, item: { size: { x: 79, y: BAR_HEIGHT } } });
  await UI.attach(win, indicators, battery);
  const batteryGlyph = await UI.createElement(win, { item: { size: { x: 30, y: BAR_HEIGHT } }, contentAlign: 'fill' });
  await UI.attach(win, battery, batteryGlyph);
  const level = await icon(win, batteryGlyph, texture('battery-unknown'), 30, 30, BAR_HEIGHT);
  const charging = await icon(win, batteryGlyph, texture('charging'), 26, 30, BAR_HEIGHT);
  const percentage = await text(win, battery, '—', 18, 44, BAR_HEIGHT);
  await UI.setElementId(win, indicators, 'top-bar-status');
  await UI.setElementId(win, percentage, 'top-bar-battery-percent');
  await Promise.all([UI.setEnabled(win, charging, false), UI.setEnabled(win, wired, false), UI.setEnabled(win, warning, false), UI.setEnabled(win, technology, false)]);
  // One target covers the entire bar, including icons and side padding. Keep
  // it above the visual row so child targets cannot interrupt the gesture.
  let drag;
  const openPanel = () => notifications.open().catch(error => Log.error('Top bar gesture: ' + error));
  const move = point => {
    if (!drag) return;
    const dx = Math.abs(point.x - drag.x), dy = point.y - drag.y;
    // Recognise early in this short surface, including a final point outside
    // its bounds. A swipe need not fit entirely inside the 40px bar.
    if (dy >= 6 && dy > dx) { drag = undefined; openPanel(); }
  };
  const target = await UI.createElement(win, {
    item: { size: { x: info.width, y: BAR_HEIGHT } },
    onMouseDown: point => { drag = { x: point.x, y: point.y }; },
    onMouseMove: move,
    onMouseUp: point => { move(point); drag = undefined; },
    onMouseExit: point => { move(point); drag = undefined; },
    onMouseClick: () => { drag = undefined; openPanel(); }
  });
  await UI.attach(win, surface, target);
  await UI.setElementId(win, target, 'top-bar-gesture');
  let previous = topBarStatus({});
  let updates = Promise.resolve();
  const updateStatus = state => {
    const value = topBarStatus(state);
    // Serialize actual changes; unrelated session events never redraw the bar.
    updates = updates.then(async () => {
      const changed = (key, apply) => value[key] !== previous[key] ? apply() : Promise.resolve();
      await Promise.all([
        changed('wifiIcon', () => UI.setTexture(win, wifi, texture(value.wifiIcon))),
        changed('cellIcon', () => UI.setTexture(win, cell, texture(value.cellIcon))),
        changed('batteryIcon', () => UI.setTexture(win, level, texture(value.batteryIcon))),
        changed('cellText', () => Promise.all([
          UI.setTextString(win, technology, value.cellText),
          UI.setEnabled(win, technology, !!value.cellText),
          // Reserve the technology label's width only while it has content.
          UI.setLayoutSize(win, cellular, { x: value.cellText ? 52 : 24, y: BAR_HEIGHT })
        ])),
        changed('batteryText', () => UI.setTextString(win, percentage, value.batteryText)),
        changed('batteryLow', () => UI.setTextColour(win, percentage, value.batteryLow ? ORANGE : CREAM)),
        changed('roaming', () => UI.setTextColour(win, technology, value.roaming ? ORANGE : CREAM)),
        changed('charging', () => UI.setEnabled(win, charging, value.charging)),
        changed('wired', () => UI.setEnabled(win, wired, value.wired)),
        changed('warning', () => UI.setEnabled(win, warning, value.warning))
      ]);
      previous = value;
    }).catch(error => Log.error('Top bar status: ' + error));
    return updates;
  };
  const refresh = async () => {
    try {
      const time = formatTime();
      if (time !== displayed) { await UI.setTextString(win, clock, time); displayed = time; }
    } catch (error) { Log.error('Clock update: ' + error); }
    setTimeout(refresh, 60000 - Date.now() % 60000);
  };
  setTimeout(refresh, 60000 - Date.now() % 60000);
  connect('top-bar', value => {
    sleep.onState(value);
    return Promise.all([updateStatus(value), notifications.onState(value), volume.onState(value)]);
  },
    undefined, notifications.onApplications, () => notifications.start().catch(error => Log.error('Notification service: ' + error)), volume.onButton);
  // Read-only handle for focused screenshot/integration fixtures.
  globalThis.koyaNotifications = notifications;
  globalThis.koyaVolume = volume;
  return win;
};
