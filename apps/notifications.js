import { session as Bus } from 'Module/dbus';
import * as UI from 'Helix/UserInterface';
import * as Compositor from 'Koya/Compositor';
import * as Assets from 'Koya/Assets';
import * as Event from 'Helix/Event';
import * as Process from 'Module/process';
import * as Log from 'Helix/Log';
import { Notifications } from './notifications-model.js';
import { notificationSurface } from './notification-surface.js';
import { createBrightness } from './brightness.js';
import { haptic } from './haptics.js';
import { button, icon, text } from './touch-ui.js';
import { clips } from './motion.js';
import { call } from './session.js';
import { decodeDesktop, nextDesktop } from './desktop-model.js';
import { FONT, CREAM, ORANGE, INK, BAR_HEIGHT, NAV_HEIGHT } from './theme.js';

const GHOST = { colour: [0, 0, 0, 0] };
const MUTED = [0.66, 0.72, 0.66, 1];
const CARD = [0.095, 0.18, 0.14, 1];
const shellIcon = name => '/rom/assets/launcher/' + name + '.png';
const preview = (value, limit) => value.length > limit ? value.slice(0, limit - 1).trimEnd() + '…' : value;

export function createNotifications(display, onUnread = () => {}) {
  const size = { x: Number(display.logical_width || display.width), y: Number(display.logical_height || display.height) };
  const width = size.x - 40;
  let state = {}, center, toast, centerBoard, toastBoard, apps = [], connected = false;
  let requested = false, page = 0, banner, bannerTimer, bannerKey, centerKey, pendingBanner;
  const icons = new Map(); let iconVersion = 0;
  const mountIcons = () => Assets.mount(Process.getEnv('XDG_CACHE_HOME', Process.getEnv('HOME', '') + '/.cache') + '/koya/icons', '/rom');
  const resolveIcon = async item => {
    if (!item.icon || icons.has(item.icon)) return;
    icons.set(item.icon, '');
    try {
      const texture = await call('ResolveIcon', 's', item.icon);
      if (texture) { await mountIcons(); icons.set(item.icon, texture); iconVersion++; enqueue(reconcile); }
    } catch (error) { Log.error('Notification icon: ' + error); }
  };
  let queue = Promise.resolve();
  const enqueue = job => {
    const next = queue.then(job);
    queue = next.catch(error => Log.error('Notifications: ' + error));
    return next;
  };
  const unlocked = () => state.Active && state.ScreenState === 'unlocked' && state.PowerMenuState === 'closed';
  const brightness = createBrightness(() => requested && unlocked());
  const bannersAllowed = () => unlocked() && state.DesktopView === 'closed' && !requested;
  const emit = (sender, member, id, action, reason) => {
    call('EmitNotification', 'ssusu', sender, member, id, action, reason).catch(error => Log.error('Notification signal: ' + error));
  };
  const model = new Notifications({ signal: emit, changed: event => {
    if (event.type === 'notify') {
      if (event.item.urgency > 0) pendingBanner = event.item.id;
      resolveIcon(event.item);
    }
    onUnread(model.unread, model.records.size);
    enqueue(reconcile);
  } });
  const dismiss = id => { model.close(id); if (banner === id) endBanner(); };
  const activate = item => {
    if (item.active && item.actions.some(action => action.key === 'default')) {
      model.invoke(item.id, 'default'); closeCenter(); endBanner();
    } else openCenter();
  };
  const label = async (win, parent, value, fontSize, w, h, colour = CREAM) => {
    const node = await UI.createElement(win, {
      renderable: { type: 'text', string: value, size: fontSize, font: FONT, colour, layoutMode: 'word-wrap' },
      item: { size: { x: w, y: h } }, contentAlign: { x: 'start', y: 'center' }, clipToBounds: true
    });
    await UI.attach(win, parent, node);
    await UI.setTextVerticalAlign(win, node, 'center');
    return node;
  };
  const appIcon = item => icons.get(item.icon) || apps.find(app => app.id === item.desktop + '.desktop' || app.id === item.desktop || app.name === item.app)?.icon || shellIcon('bell');
  const actionsFor = item => item.active ? item.actions.filter(action => action.key !== 'default') : [];
  const heightFor = item => 204 + Math.ceil(actionsFor(item).length / 2) * 56;
  let openingWifi = false;
  const openWifi = async () => {
    if (!unlocked() || openingWifi) return;
    openingWifi = true;
    try {
      const desktop = decodeDesktop(await call('GetDesktopState'));
      const existing = desktop.clients.find(client => (client.initialClass || client.class) === 'org.koya.Wifi');
      if (existing) await call('FocusWindow', 's', existing.address);
      else await call('LaunchApplication', 'su', 'koya-wifi.desktop', nextDesktop(desktop));
      closeCenter();
    } catch (error) { Log.error('Open Wi-Fi: ' + error); }
    finally { openingWifi = false; }
  };
  const card = async (surface, parent, item, w, compact) => {
    const win = surface.win, height = compact ? 184 : heightFor(item);
    let motion;
    const node = await UI.createElement(win, {
      renderable: { type: 'box', colour: compact ? [0, 0, 0, 0] : CARD, cornerRadius: 18, origin: { x: 0.5, y: 0.5 } },
      layout: { type: 'column', gap: 8, padding: { l: 16, r: 16, t: 12, b: 12 } },
      item: { size: { x: w, y: height } }, inheritAnimation: true, contentAlign: 'fill',
      onMouseDown: (_, point) => { if (point.y >= 56 && point.y < 172 && unlocked()) { haptic(); motion?.play('press'); } },
      onMouseUp: () => motion?.play('release'),
      onMouseExit: () => motion?.play('release'),
      onMouseClick: (_, point) => { if (point.y >= 56 && point.y < 172 && unlocked()) activate(item); }
    });
    await UI.attach(win, parent, node);
    await UI.setElementId(win, node, 'notification-' + item.id);
    motion = await clips(win, node, {
      press: [{ time: 0.07, scale: { x: 0.98, y: 0.98 }, ease: 'outQuad' }],
      release: [{ time: 0.10, scale: { x: 1.008, y: 1.008 }, ease: 'outCubic' },
        { time: 0.23, scale: { x: 1, y: 1 }, ease: 'outCubic' }]
    });
    const inner = w - 32;
    const header = await UI.createElement(win, { layout: { type: 'row', gap: 8, alignItems: 'center' }, item: { size: { x: inner, y: 44 } } });
    await UI.attach(win, node, header);
    await icon(win, header, appIcon(item), 28, 32, 44);
    await label(win, header, preview(item.app, 32), 15, inner - 96, 44, item.urgency === 2 ? ORANGE : MUTED);
    await button(win, header, '', 48, 44, () => unlocked() && dismiss(item.id), { ...GHOST, icon: shellIcon('close'), iconSize: 19 });
    await label(win, node, preview(item.summary || item.app, compact ? 42 : 80), 22, inner, compact ? 32 : 52);
    await label(win, node, preview(item.body.replace(/\s+/g, ' '), 110), 18, inner, 44);
    if (!compact) {
      const actions = actionsFor(item);
      for (let i = 0; i < actions.length; i += 2) {
        const row = await UI.createElement(win, { layout: { type: 'row', gap: 12 }, item: { size: { x: inner, y: 48 } } });
        await UI.attach(win, node, row);
        for (const action of actions.slice(i, i + 2)) await button(win, row, preview(action.label, 26), (inner - 12) / 2, 48,
          () => { if (unlocked()) { model.invoke(item.id, action.key); closeCenter(); endBanner(); } },
          { ...GHOST, size: 18, labelColour: ORANGE, labelHeight: 42 });
      }
    }
  };
  const pages = () => {
    const result = [[]]; let used = 0;
    const available = size.y - BAR_HEIGHT - NAV_HEIGHT - 360;
    for (const item of model.items.filter(item => !item.transient)) {
      const height = heightFor(item) + 12;
      if (used && used + height > available) { result.push([]); used = 0; }
      result[result.length - 1].push(item); used += height;
    }
    return result;
  };
  const buildCenter = async () => {
    center = await notificationSurface(display, 'koya-notifications', size, { x: 0, y: 0 }, [...INK.slice(0, 3), 0.98], 'exclusive');
    await UI.setElementId(center.win, center.root, 'notifications-root');
    await center.prepare();
  };
  const paintCenter = async () => {
    const groups = pages(); page = Math.min(page, groups.length - 1);
    const key = JSON.stringify([page, model.items, iconVersion, apps.map(app => app.icon), state.WifiSsid, state.WifiState]);
    if (centerKey === key) return;
    centerKey = key;
    await center.paint(async () => {
      if (centerBoard) await UI.destroyElement(center.win, centerBoard);
      const win = center.win;
      centerBoard = await UI.createElement(win, { layout: { type: 'column', gap: 12, padding: { l: 20, r: 20, t: BAR_HEIGHT + 12, b: NAV_HEIGHT + 12 } }, item: { size } });
      await UI.attach(win, center.root, centerBoard);
      const header = await UI.createElement(win, { layout: { type: 'row', gap: 8 }, item: { size: { x: width, y: 56 } } });
      await UI.attach(win, centerBoard, header);
      await label(win, header, 'Notifications', 28, width - 120, 56);
      await button(win, header, '', 52, 56, () => unlocked() && model.clear(), { ...GHOST, icon: shellIcon('clear'), iconSize: 24 });
      await button(win, header, '', 52, 56, closeCenter, { ...GHOST, icon: shellIcon('close'), iconSize: 24 });
      await brightness.attach(win, centerBoard, width);
      const wifi = await button(win, centerBoard, state.WifiState === 'connected' && state.WifiSsid ? 'Wi-Fi · ' + preview(state.WifiSsid, 28) : 'Wi-Fi', width, 72,
        openWifi, { colour: CARD, labelHeight: 48, size: 22 });
      await UI.setElementId(win, wifi, 'notifications-wifi');
      const list = await UI.createElement(win, { layout: { type: 'column', gap: 12 }, item: { size: { x: width, y: size.y - BAR_HEIGHT - NAV_HEIGHT - 372 } } });
      await UI.attach(win, centerBoard, list);
      if (!groups[page].length) {
        await icon(win, list, shellIcon('bell'), 60, width, 140);
        await text(win, list, 'All caught up', 24, width, 48, CREAM);
      }
      for (const item of groups[page]) await card(center, list, item, width, false);
      if (groups.length > 1) {
        const footer = await UI.createElement(win, { layout: { type: 'row', justifyContent: 'center', gap: 16 }, item: { size: { x: width, y: 56 } } });
        await UI.attach(win, centerBoard, footer);
        await button(win, footer, '‹', 64, 56, () => { if (page > 0) { page--; enqueue(paintCenter); } }, { ...GHOST, size: 30 });
        await text(win, footer, (page + 1) + ' / ' + groups.length, 17, 80, 56, MUTED);
        await button(win, footer, '›', 64, 56, () => { if (page + 1 < groups.length) { page++; enqueue(paintCenter); } }, { ...GHOST, size: 30 });
      }
    });
  };
  const endBanner = () => {
    clearTimeout(bannerTimer); bannerTimer = undefined; banner = undefined; bannerKey = undefined;
    enqueue(reconcile);
  };
  const showBanner = async item => {
    if (!toast || toast.closed) {
      toastBoard = undefined;
      toast = await notificationSurface(display, 'koya-notification-banner', { x: width, y: 184 },
        { x: 20, y: BAR_HEIGHT + 12 }, CARD);
      await toast.prepare();
    }
    const key = item.id + ':' + item.revision + ':' + iconVersion;
    const changed = bannerKey !== key;
    if (changed) {
      bannerKey = key;
      await toast.paint(async () => {
        if (toastBoard) await UI.destroyElement(toast.win, toastBoard);
        toastBoard = await UI.createElement(toast.win, { item: { size: { x: width, y: 184 } } });
        await UI.attach(toast.win, toast.root, toastBoard);
        await card(toast, toastBoard, item, width, true);
      });
    }
    if (!bannersAllowed() || !model.records.has(item.id)) return;
    if (!toast.shown) await toast.show();
    if (changed || !bannerTimer) {
      clearTimeout(bannerTimer);
      // One timeout per banner; unrelated shell events do not reset it.
      bannerTimer = setTimeout(endBanner, item.urgency === 2 ? 8000 : 5000);
    }
  };
  async function reconcile() {
    if (!unlocked()) requested = false;
    if (!requested && center?.shown) await center.hide(!unlocked());
    if ((!bannersAllowed() || !banner || !model.records.get(banner)?.active) && toast?.shown) await toast.hide(!unlocked());
    if (!unlocked()) return;
    if (requested) {
      if (!center || center.closed) { centerBoard = undefined; centerKey = undefined; await buildCenter(); }
      await paintCenter();
      if (requested && unlocked() && !center.shown) await center.show();
      return;
    }
    if (!bannersAllowed()) return;
    if (pendingBanner) { banner = pendingBanner; pendingBanner = undefined; bannerKey = undefined; }
    const item = model.records.get(banner);
    if (item?.active) await showBanner(item);
  }
  function closeCenter() { requested = false; enqueue(reconcile); }
  async function openCenter() {
    if (!unlocked()) return;
    requested = true; page = 0; banner = pendingBanner = undefined; clearTimeout(bannerTimer);
    model.read();
    brightness.refresh();
    // Shell coordination uses the existing platform calls; notification state
    // stays local to this Koya process.
    call('DismissDesktopView').catch(error => Log.error(String(error)));
    if (state.KeyboardAvailable) Bus.call('sm.puri.OSK0', '/sm/puri/OSK0', 'sm.puri.OSK0', 'SetVisible', 'b', false).catch(error => Log.error(String(error)));
    return enqueue(reconcile);
  }
  Event.on('keyDown', event => { if (center?.shown && event.id === center.win && Number(event.key) === 27) closeCenter(); });
  const refreshApps = async () => {
    apps = await call('GetApplications');
    await mountIcons();
    iconVersion++;
    enqueue(reconcile);
  };
  const start = async () => {
    if (connected) return;
    Bus.onSignal(event => {
      if (event.interface !== 'org.koya.Shell1' || event.member !== 'NotificationRequest') return;
      const request = JSON.parse(event.args[0]);
      let reply;
      try { reply = model.request(request.Sender, request.Method, request.Arguments); }
      catch (error) { reply = { Error: String(error.message || error) }; }
      Bus.callComplex('org.koya.Shell1', '/org/koya/Shell1', 'org.koya.Shell1', 'ReplyNotification', 'ua{sv}', request.Token, reply)
        .catch(error => Log.error('Notification reply: ' + error));
    });
    await Bus.addMatch("type='signal',sender='org.koya.Shell1',interface='org.koya.Shell1',member='NotificationRequest'");
    await call('RegisterNotifications'); connected = true;
    await brightness.start();
    refreshApps().catch(error => Log.error('Notification icons: ' + error));
  };
  return { start, model, brightness, open: openCenter, close: closeCenter, onApplications: refreshApps,
    onState: next => {
      state = next;
      if (!unlocked() || next.DesktopView !== 'closed') requested = false;
      brightness.onState(next);
      return enqueue(reconcile);
    },
    get bannerWindow() { return toast?.shown ? toast.win : undefined; },
    get centerWindow() { return center?.shown ? center.win : undefined; }
  };
}
