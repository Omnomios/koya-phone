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
import { button, icon, text, label, row, pill, backdrop, sheetHeader } from './touch-ui.js';
import { clips } from './motion.js';
import { call } from './session.js';
import { decodeDesktop, nextDesktop } from './desktop-model.js';
import { CREAM, ORANGE, INK, CARD, MUTED, CLEAR, alpha, BAR_HEIGHT, GUTTER, SPACE, RADIUS, TYPE, HEADER_HEIGHT, TOUCH, TRAILING_INSET } from './theme.js';

const GHOST = { colour: CLEAR };
// Notification card anatomy. Heights derive from content so short
// notifications do not carry empty space.
const CARD_PAD = 16, CARD_HEADER = 32, CARD_SUMMARY = 28, CARD_LINE = 24, CARD_BODY = 2 * CARD_LINE, ACTION = 40, TILE = 72;
const BANNER_HEIGHT = CARD_PAD * 2 + CARD_HEADER + CARD_SUMMARY + CARD_BODY + SPACE.xs * 2;
const shellIcon = name => '/rom/assets/launcher/' + name + '.png';
const preview = (value, limit) => value.length > limit ? value.slice(0, limit - 1).trimEnd() + '…' : value;

export function createNotifications(display, onUnread = () => {}) {
  const size = { x: Number(display.logical_width || display.width), y: Number(display.logical_height || display.height) };
  let width = size.x - 2 * GUTTER;
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
  const appIcon = item => icons.get(item.icon) || apps.find(app => app.id === item.desktop + '.desktop' || app.id === item.desktop || app.name === item.app)?.icon || shellIcon('bell');
  const actionsFor = item => item.active ? item.actions.filter(action => action.key !== 'default') : [];
  const bodyOf = item => item.body.replace(/\s+/g, ' ').trim();
  const actionRows = item => Math.ceil(actionsFor(item).length / 2);
  // Tappable text region: below the header row, above any action buttons.
  // Source Sans averages about half an em per character: one or two lines.
  const bodyHeight = item => !bodyOf(item) ? 0 : preview(bodyOf(item), 110).length * (TYPE.caption + 1) * 0.5 > width - 2 * CARD_PAD ? CARD_BODY : CARD_LINE;
  const textEnd = item => CARD_PAD + CARD_HEADER + SPACE.xs + CARD_SUMMARY + (bodyOf(item) ? SPACE.xs + bodyHeight(item) : 0);
  const heightFor = item => textEnd(item) + CARD_PAD
    + (actionRows(item) ? SPACE.s + actionRows(item) * ACTION + (actionRows(item) - 1) * SPACE.s : 0);
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
    const win = surface.win, height = compact ? BANNER_HEIGHT : heightFor(item), end = textEnd(item);
    let motion;
    const inText = point => point.y >= CARD_PAD + CARD_HEADER && point.y < end;
    const node = await UI.createElement(win, {
      renderable: { type: 'box', colour: compact ? CLEAR : CARD, cornerRadius: RADIUS.surface, cornerResolution: 16, origin: { x: 0.5, y: 0.5 } },
      layout: { type: 'column', gap: SPACE.xs, padding: { l: CARD_PAD, r: TRAILING_INSET - 20, t: CARD_PAD, b: CARD_PAD } },
      item: { size: { x: w, y: height } }, inheritAnimation: true, contentAlign: 'fill',
      onMouseDown: (_, point) => { if (inText(point) && unlocked()) { haptic(); motion?.play('press'); } },
      onMouseUp: () => motion?.play('release'),
      onMouseExit: () => motion?.play('release'),
      onMouseClick: (_, point) => { if (inText(point) && unlocked()) activate(item); }
    });
    await UI.attach(win, parent, node);
    await UI.setElementId(win, node, 'notification-' + item.id);
    motion = await clips(win, node, {
      press: [{ time: 0.07, scale: { x: 0.98, y: 0.98 }, ease: 'outQuad' }],
      release: [{ time: 0.10, scale: { x: 1.008, y: 1.008 }, ease: 'outCubic' },
        { time: 0.23, scale: { x: 1, y: 1 }, ease: 'outCubic' }]
    });
    const inner = w - CARD_PAD - (TRAILING_INSET - 20), text = w - 2 * CARD_PAD;
    const header = await UI.createElement(win, { layout: { type: 'row', gap: SPACE.s, alignItems: 'center' }, item: { size: { x: inner, y: CARD_HEADER } } });
    await UI.attach(win, node, header);
    await icon(win, header, appIcon(item), 20, 20, CARD_HEADER);
    await label(win, header, preview(item.app, 32), TYPE.caption, inner - 20 - SPACE.s * 2 - 40, CARD_HEADER, item.urgency === 2 ? ORANGE : MUTED);
    await button(win, header, '', 40, CARD_HEADER, () => unlocked() && dismiss(item.id), { ...GHOST, icon: shellIcon('close'), iconSize: 16, radius: RADIUS.control });
    await label(win, node, preview(item.summary || item.app, compact ? 42 : 80), TYPE.heading - 1, text, CARD_SUMMARY);
    if (bodyOf(item) || compact) await label(win, node, preview(bodyOf(item), 110), TYPE.caption + 1, text, compact ? CARD_BODY : bodyHeight(item), alpha(CREAM, 0.82));
    if (!compact && actionRows(item)) {
      const actions = actionsFor(item);
      const list = await UI.createElement(win, { layout: { type: 'column', gap: SPACE.s, padding: { l: 0, r: 0, t: SPACE.xs, b: 0 } },
        item: { size: { x: text, y: SPACE.xs + actionRows(item) * ACTION + (actionRows(item) - 1) * SPACE.s } } });
      await UI.attach(win, node, list);
      for (let i = 0; i < actions.length; i += 2) {
        const line = await UI.createElement(win, { layout: { type: 'row', gap: SPACE.s }, item: { size: { x: text, y: ACTION } } });
        await UI.attach(win, list, line);
        for (const action of actions.slice(i, i + 2)) await pill(win, line, preview(action.label, 26), (text - SPACE.s) / 2,
          () => { if (unlocked()) { model.invoke(item.id, action.key); closeCenter(); endBanner(); } },
          { height: ACTION, labelColour: ORANGE });
      }
    }
  };
  const pages = () => {
    const result = [[]]; let used = 0;
    const available = listHeight() + SPACE.m;
    for (const item of model.items.filter(item => !item.transient)) {
      const height = heightFor(item) + SPACE.m;
      if (used && used + height > available) { result.push([]); used = 0; }
      result[result.length - 1].push(item); used += height;
    }
    return result;
  };
  // The shade covers both bars. Keep the top bar's strip clear for the notch.
  const TOP = BAR_HEIGHT + SPACE.s;
  const listHeight = () => size.y - TOP - GUTTER - HEADER_HEIGHT - 2 * TILE - 4 * SPACE.m - TOUCH;
  const buildCenter = async () => {
    center = await notificationSurface(display, 'koya-notifications', size, { x: 0, y: 0 }, alpha(INK, 0.98), 'exclusive');
    await UI.setElementId(center.win, center.root, 'notifications-root');
    await backdrop(center.win, center.root, size);
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
      centerBoard = await UI.createElement(win, { layout: { type: 'column', gap: SPACE.m, padding: { l: GUTTER, r: GUTTER, t: TOP, b: GUTTER } }, item: { size } });
      await UI.attach(win, center.root, centerBoard);
      const items = groups[page];
      await sheetHeader(win, centerBoard, 'Notifications', width, [
        ...(model.records.size ? [{ icon: shellIcon('clear'), handler: () => unlocked() && model.clear() }] : []),
        { icon: shellIcon('close'), handler: closeCenter }
      ]);
      await brightness.attach(win, centerBoard, width);
      // Quick settings share one row anatomy: icon column, title and status.
      const connected = state.WifiState === 'connected' && state.WifiSsid;
      const wifi = await row(win, centerBoard, width, TILE, openWifi, { right: TRAILING_INSET - 20 });
      await UI.setElementId(win, wifi, 'notifications-wifi');
      await icon(win, wifi, '/rom/assets/status/' + (connected ? 'wifi-3' : 'wifi-off') + '.png', 26, 36, TILE);
      const detail = await UI.createElement(win, { layout: { type: 'column', justifyContent: 'center' }, item: { size: { x: width - 16 - 36 - 12 * 2 - 40 - (TRAILING_INSET - 20), y: TILE } } });
      await UI.attach(win, wifi, detail);
      await label(win, detail, 'Wi-Fi', TYPE.body, width - 120, 26);
      await label(win, detail, connected ? preview(state.WifiSsid, 32) : state.WifiState === 'connecting' ? 'Connecting…' : 'Not connected', TYPE.caption, width - 120, 22, connected ? ORANGE : MUTED);
      await icon(win, wifi, shellIcon('next'), 18, 40, TILE);
      const list = await UI.createElement(win, { layout: { type: 'column', gap: SPACE.m }, item: { size: { x: width, y: listHeight() } } });
      await UI.attach(win, centerBoard, list);
      if (!items.length) {
        await UI.attach(win, list, await UI.createElement(win, { item: { size: { x: width, y: Math.max(0, listHeight() / 2 - 110) } } }));
        await icon(win, list, shellIcon('bell'), 48, width, 72);
        await text(win, list, 'All caught up', TYPE.body, width, 32, MUTED);
      }
      for (const item of items) await card(center, list, item, width, false);
      if (groups.length > 1) {
        const footer = await UI.createElement(win, { layout: { type: 'row', justifyContent: 'center', alignItems: 'center' }, item: { size: { x: width, y: TOUCH } } });
        await UI.attach(win, centerBoard, footer);
        await button(win, footer, '', 64, TOUCH, () => { if (page > 0) { page--; enqueue(paintCenter); } }, { ...GHOST, icon: shellIcon('previous'), iconSize: 22, radius: RADIUS.control });
        await text(win, footer, (page + 1) + ' / ' + groups.length, TYPE.caption, 80, TOUCH, MUTED);
        await button(win, footer, '', 64, TOUCH, () => { if (page + 1 < groups.length) { page++; enqueue(paintCenter); } }, { ...GHOST, icon: shellIcon('next'), iconSize: 22, radius: RADIUS.control });
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
      toast = await notificationSurface(display, 'koya-notification-banner', { x: width, y: BANNER_HEIGHT },
        { x: GUTTER, y: BAR_HEIGHT + SPACE.s }, CARD);
      await toast.prepare();
    }
    const key = item.id + ':' + item.revision + ':' + iconVersion;
    const changed = bannerKey !== key;
    if (changed) {
      bannerKey = key;
      await toast.paint(async () => {
        if (toastBoard) await UI.destroyElement(toast.win, toastBoard);
        toastBoard = await UI.createElement(toast.win, { item: { size: { x: width, y: BANNER_HEIGHT } } });
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
  return { start, model, brightness,
    resize: next => enqueue(async () => {
      if (size.x === next.x && size.y === next.y) return;
      Object.assign(size, next); width = size.x - 2 * GUTTER;
      for (const surface of [center, toast]) if (surface && !surface.closed) await Compositor.destroyWindow(surface.win);
      center = toast = centerBoard = toastBoard = undefined;
      centerKey = bannerKey = undefined;
      await reconcile();
    }), open: openCenter, close: closeCenter, onApplications: refreshApps,
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
