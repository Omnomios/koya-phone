import * as Compositor from 'Koya/Compositor';
import * as UI from 'Helix/UserInterface';
import * as Event from 'Helix/Event';
import * as Log from 'Helix/Log';
import * as Process from 'Module/process';
import * as Assets from 'Koya/Assets';
import { call } from './session.js';
import { clips } from './motion.js';
import { text, button } from './touch-ui.js';
import { CREAM, ORANGE, INK, BAR_HEIGHT, NAV_HEIGHT } from './theme.js';
import { decodeDesktop, nextDesktop, appWindow, desktopCards } from './desktop-model.js';

async function createView(display, initialMode, initialApps, initialSnapshot, onRefresh, trace) {
  const win = await Compositor.createWindow({
    role: 'overlay', anchor: 'top-left', display: display.display,
    size: { x: Number(display.logical_width || display.width), y: Number(display.logical_height || display.height) },
    exclusiveZone: -1, namespace: 'koya-desktop-view', msaaSamples: 1,
    transparent: true, renderingEnabled: false, keyboardInteractivity: 'none', acceptPointerEvents: false
  });
  try {
  await Compositor.setWindowRenderingEnabled(win, false);
  await Compositor.setClearColor(win, 0, 0, 0, 0);
  const info = await Compositor.getWindowInfo(win);
  trace('window created');
  const root = await UI.createElement(win, {
    renderable: { type: 'box', colour: [INK[0], INK[1], INK[2], 0.98] },
    contentAlign: 'fill',
    item: { size: { x: info.width, y: info.height } }
  });
  await UI.attachRoot(win, root);
  await UI.setElementId(win, root, 'desktop-view-root');
  await UI.setInheritAnimation(win, root, true);
  const backdrop = await UI.createElement(win, {
    renderable: { type: 'sprite', texture: '/rom/assets/earthy-green-wallpaper.png', frame: 0,
      frames: [{ size: { x: info.width, y: info.height }, aabb: { min: { x: 0, y: 0 }, max: { x: 864, y: 1821 } }, colour: [0.15,0.19,0.17,1] }] },
    item: { size: { x: info.width, y: info.height } }, contentAlign: 'fill'
  });
  await UI.attach(win, root, backdrop);
  const content = await UI.createElement(win, {
    layout: { type: 'column', gap: 24, padding: { l: 28, r: 28, t: BAR_HEIGHT + 20, b: NAV_HEIGHT + 20 } },
    item: { size: { x: info.width, y: info.height } }
  });
  await UI.attach(win, root, content);
  const motion = await clips(win, root, {
    enter: [{ time: 0, opacity: 0, position: { x: 0, y: 16 } }, { time: 0.22, opacity: 1, position: { x: 0, y: 0 }, ease: 'outCubic' }],
    leave: [{ time: 0.08, opacity: 0, position: { x: 0, y: 14 }, ease: 'inQuad' }],
    hide: [{ time: 0.06, opacity: 0, position: { x: 0, y: 14 }, ease: 'inQuad' },
      { time: 0.10, opacity: 0, position: { x: 0, y: 14 } }],
    park: [{ time: 0, opacity: 0, position: { x: 0, y: 16 } },
      { time: 0.06, opacity: 0, position: { x: 0, y: 16 } }],
    restore: [{ time: 0.18, opacity: 1, position: { x: 0, y: 0 }, ease: 'outCubic' }]
  });
  await UI.setAnimationTime(win, root, motion.ids.enter, 0);
  let board, mode = initialMode, page = 0, apps = initialApps, snapshot = await initialSnapshot, busy = false, message = '';
  let shown = false, entering = false, pendingPaint = false, closed = false, fetching = false;
  let pendingLaunch;
  let parked;
  const finishParking = async () => {
    if (!parked) return;
    await Compositor.setWindowRenderingEnabled(win, false);
    const resolve = parked; parked = null; resolve();
  };
  await motion.onEnd('park', finishParking);
  await motion.onEnd('hide', finishParking);
  // Hold a fully transparent buffer for several frames before freezing it.
  // Disabling rendering alone would leave the last opaque buffer on screen.
  const park = async immediate => {
    let fallback;
    const done = new Promise(resolve => { parked = resolve; });
    fallback = setTimeout(() => {
      Log.error('Drawer hide animation did not finish; destroying its window');
      Compositor.destroyWindow(win).then(() => { closed = true; const resolve = parked; parked = null; resolve?.(); });
    }, 500);
    try {
      await Compositor.setWindowRenderingEnabled(win, true);
      await motion.play(immediate ? 'park' : 'hide');
      await done;
    } finally { clearTimeout(fallback); }
  };
  const width = info.width - 56;
  const ghost = { colour: [0,0,0,0] };
  const shellIcon = name => '/rom/assets/launcher/' + name + '.png';
  trace('window shell built');
  const leave = async action => {
    if (busy || closed || !shown) return;
    busy = true;
    // Send the command in the input callback. Visual motion must never gate
    // application state changes. The controller closes the window separately.
    try { await Promise.all([action(), motion.play('leave')]); }
    catch (error) {
      if (closed || !shown) return;
      busy = false; message = 'Unable to complete that action'; Log.error('Desktop action: ' + error);
      await motion.play('restore'); await render();
    }
  };
  const dismiss = () => leave(() => call('DismissDesktopView'));
  const header = await UI.createElement(win, { layout: { type: 'row', gap: 8 }, item: { size: { x: width, y: 52 } } });
  await UI.attach(win, content, header);
  const title = await text(win, header, mode === 'apps' ? 'Apps' : 'Desktops', 32, width - 92, 52);
  await UI.setContentAlign(win, title, { x: 'start', y: 'center' });
  const indicator = await UI.createElement(win, {
    renderable: { type: 'circle', aabb: { min: { x: 0, y: 0 }, max: { x: 6, y: 6 } },
      resolution: 16, colour: ORANGE, origin: { x: 0.5, y: 0.5 } },
    item: { size: { x: 24, y: 52 } }, contentAlign: { x: 'center', y: 'center' }
  });
  await UI.attach(win, header, indicator);
  await UI.setElementId(win, indicator, 'desktop-refresh-indicator');
  await UI.setEnabled(win, indicator, false);
  const loading = await clips(win, indicator, {
    pulse: [{ time: 0, opacity: 0.35, scale: { x: 0.8, y: 0.8 } },
      { time: 0.4, opacity: 1, scale: { x: 1, y: 1 }, ease: 'inOutQuad' },
      { time: 0.8, opacity: 0.35, scale: { x: 0.8, y: 0.8 }, ease: 'inOutQuad', looping: true }]
  });
  await button(win, header, '', 52, 52, dismiss, { ...ghost, icon: shellIcon('close'), iconSize: 23 });
  const launch = async (app, feedback) => {
    if (busy || closed || !shown || pendingLaunch) return;
    const existing = !fetching && appWindow(app, snapshot.clients);
    if (existing) { await leave(() => call('FocusWindow', 's', existing.address)); return; }
    const pending = { app, addresses: new Set(snapshot.clients.map(client => client.address)), feedback };
    pendingLaunch = pending;
    feedback.begin().catch(error => Log.error('Launch feedback: ' + error));
    try {
      // Feedback is immediate, but workspace allocation must use the refreshed
      // state if the user taps an app before the outstanding query completes.
      if (fetching) await onRefresh();
      if (pendingLaunch !== pending || !shown) return;
      pending.workspace = nextDesktop(snapshot);
      pending.addresses = new Set(snapshot.clients.map(client => client.address));
      await call('LaunchApplication', 'su', app.id, pending.workspace);
    }
    catch (error) {
      if (closed || !shown || pendingLaunch !== pending) return;
      pendingLaunch = null; await feedback.end();
      message = 'Unable to open ' + app.name; Log.error('Launch: ' + error); await render();
    }
  };
  let painting = false, paintDirty = false;
  const render = async () => {
    if (closed) return;
    if (entering || pendingLaunch) { pendingPaint = true; return; }
    if (painting) { paintDirty = true; return; }
    painting = true;
    pendingPaint = false;
    try {
      if (shown) await Compositor.setWindowRenderingEnabled(win, false);
      do { paintDirty = false; await paint(); } while (paintDirty && !busy);
    } finally {
      if (shown && !closed) await Compositor.setWindowRenderingEnabled(win, true);
      painting = false;
    }
  };
  const paint = async () => {
    if (busy || !snapshot) return;
    await UI.setTextString(win, title, mode === 'apps' ? 'Apps' : 'Desktops');
    if (board) await UI.destroyElement(win, board);
    board = await UI.createElement(win, {
      layout: { type: 'column', gap: 24 }, item: { size: { x: width, y: info.height - BAR_HEIGHT - NAV_HEIGHT - 40 - 76 } }
    });
    await UI.attach(win, content, board);
    if (message) await text(win, board, message, 17, width, 32, ORANGE);
    const columns = Math.max(1, Math.floor((width + 20) / 152));
    const tileWidth = (width - 20 * (columns - 1)) / columns;
    const tileHeight = 148;
    const available = info.height - BAR_HEIGHT - NAV_HEIGHT - 40 - 52 - 24 - (message ? 56 : 0);
    const rows = Math.max(1, Math.floor((available - 76 + 24) / (tileHeight + 24)));
    const capacity = columns * rows;
    const items = mode === 'apps' ? apps : desktopCards(snapshot);
    const pages = Math.max(1, Math.ceil(items.length/capacity));
    page = Math.min(page, pages - 1);
    const visible = items.slice(page*capacity, (page+1)*capacity);
    const visibleRows = Math.max(1, Math.ceil(visible.length/columns));
    const grid = await UI.createElement(win, {
      layout: { type: 'grid', gridColumns: columns, gridRows: visibleRows, columnGap: 20, rowGap: 24, gridAlignItems: 'start', gridJustifyItems: 'start' },
      item: { size: { x: width, y: visibleRows*(tileHeight+24)-24 } }
    });
    await UI.attach(win, board, grid);
    await UI.setElementId(win, grid, 'desktop-view-grid');
    for (const item of visible) {
      if (mode === 'apps') {
        let feedback;
        const target = await button(win, grid, item.name, tileWidth, tileHeight, () => launch(item, feedback),
          { ...ghost, icon: item.icon || shellIcon('application'), iconSize: 80, size: 17, labelHeight: 40, gap: 12,
            onFeedback: value => { feedback = value; } });
        await UI.setElementId(win, target, 'desktop-app-' + item.id);
      } else {
        const card = await UI.createElement(win, { layout: { type: 'column', gap: 8 }, item: { size: { x: tileWidth, y: tileHeight } } });
        await UI.attach(win, grid, card);
        const primary = item.windows.find(window => window.focusHistoryID === 0) || item.windows[0];
        const app = primary && apps.find(candidate => appWindow(candidate, [primary]));
        const label = app?.name || (primary ? (primary.title || primary.class).substring(0,28) : 'Empty');
        const select = () => leave(() => primary ? call('FocusWindow', 's', primary.address) : call('SwitchDesktop', 'u', item.id));
        const target = await button(win, card, '', tileWidth, 92, select, {
          ...ghost, icon: app?.icon || shellIcon('application'), iconSize: 64
        });
        await UI.setElementId(win, target, 'desktop-card-' + item.id);
        const caption = await UI.createElement(win, { layout: { type: 'row', gap: 8 }, item: { size: { x: tileWidth, y: 48 } } });
        await UI.attach(win, card, caption);
        await button(win, caption, label, tileWidth - (primary ? 56 : 0), 48, select,
          { ...ghost, size: 17, labelHeight: 40, accent: item.active ? ORANGE : CREAM });
        if (primary) await button(win, caption, '', 48, 48, async () => {
          if (busy) return;
          try { await call('CloseWindow', 's', primary.address); await onRefresh(); }
          catch (error) { message = 'Unable to close window'; Log.error(String(error)); await render(); }
        }, { ...ghost, icon: shellIcon('close'), iconSize: 18 });
      }
    }
    if (!items.length) await text(win, grid, mode === 'apps' ? 'No applications installed' : '', 20, width, 80);
    if (pages > 1) {
      const footer = await UI.createElement(win, { layout: { type: 'row', gap: 8 }, item: { size: { x: width, y: 52 } } });
      await UI.attach(win, board, footer);
      await button(win, footer, '', 52, 52, () => { if (!busy && page > 0) { page--; render(); } }, { ...ghost, icon: shellIcon('previous'), iconSize: 24 });
      await text(win, footer, Array.from({ length: pages }, (_, i) => i === page ? '●' : '○').join('  '), 14, width - 120, 52, ORANGE);
      await button(win, footer, '', 52, 52, () => { if (!busy && page+1 < pages) { page++; render(); } }, { ...ghost, icon: shellIcon('next'), iconSize: 24 });
    }
  };
  await motion.onEnd('enter', async () => {
    entering = false;
    if (pendingPaint && !busy && !closed && shown) { pendingPaint = false; await render(); }
  });
  await render();
  trace('content built');
  let key = JSON.stringify([mode, apps, mode === 'apps' ? null : snapshot]);
  return {
    win, dismiss,
    get shown() { return shown; },
    get closed() { return closed; },
    prepare: async () => { await park(true); trace('window prepared'); },
    setFetching: async value => {
      if (closed || fetching === value) return;
      fetching = value;
      await UI.setEnabled(win, indicator, value);
      if (value && shown) await loading.play('pulse');
      else if (!value) await UI.stopAnimation(win, indicator);
    },
    show: async () => {
      if (shown) return;
      busy = false;
      if (pendingPaint) { pendingPaint = false; await render(); }
      // The parked buffer is already transparent. Starting the authored
      // entrance resets its pose, without an extra hold/reset round trip.
      shown = entering = true;
      await Compositor.setWindowRenderingEnabled(win, true);
      await motion.play('enter');
      trace('entrance started');
      await Promise.all([Compositor.setKeyboardInteractivity(win, 'exclusive'), Compositor.setPointerEvents(win, true),
        fetching ? loading.play('pulse') : Promise.resolve()]);
      await call('DesktopViewVisible', 'b', true);
      trace('shown');
    },
    update: async (nextMode, nextApps, nextSnapshot) => {
      if (closed) return;
      snapshot = nextSnapshot;
      if (pendingLaunch) {
        const opened = snapshot.clients.find(client => !pendingLaunch.addresses.has(client.address) && client.workspace.id === pendingLaunch.workspace)
          || appWindow(pendingLaunch.app, snapshot.clients);
        if (opened) {
          const launch = pendingLaunch; pendingLaunch = null; pendingPaint = false;
          await launch.feedback.end();
          await leave(() => call('FocusWindow', 's', opened.address));
          return;
        }
        if (nextMode !== mode) { await pendingLaunch.feedback.end(); pendingLaunch = null; }
      }
      // App tiles read the live snapshot in their handlers; desktop events
      // need not rebuild an otherwise unchanged application grid.
      const nextKey = JSON.stringify([nextMode, nextApps, nextMode === 'apps' ? null : nextSnapshot]);
      if (nextKey === key || (busy && shown)) return;
      if (nextMode !== mode) { page = 0; message = ''; }
      mode = nextMode; apps = nextApps; snapshot = nextSnapshot; key = nextKey;
      await render();
    },
    hide: async immediate => {
      if (!shown) return;
      shown = false; busy = true; entering = false;
      if (pendingLaunch) await pendingLaunch.feedback.end();
      pendingLaunch = null;
      await UI.stopAnimation(win, indicator);
      await Promise.all([Compositor.setPointerEvents(win, false), Compositor.setKeyboardInteractivity(win, 'none')]);
      await park(immediate);
      busy = false;
      await call('DesktopViewVisible', 'b', false);
      trace('window parked');
    }
  };
  } catch (error) {
    await Compositor.destroyWindow(win);
    throw error;
  }
}

export function createDrawerController(display) {
  const tracePath = Process.getEnv('KOYA_DESKTOP_TRACE_FILE', '');
  const timings = [];
  const trace = stage => {
    if (!tracePath) return;
    timings.push({ stage, at: Date.now() });
    Process.writeFileText(tracePath, JSON.stringify(timings));
  };
  trace('bootstrap');
  let view, state, apps, mode = 'apps', stale = true, fetching, fetchingApps, revision = 0;
  let snapshot = { workspaces: [{ id: 1 }], clients: [], active: { id: 1 } };
  let queue = Promise.resolve();
  const enqueue = job => {
    const next = queue.then(job);
    queue = next.catch(error => Log.error('Desktop view: ' + error));
    return next;
  };
  const loadApps = async () => {
    const nextApps = (await call('GetApplications')).sort((a,b) => a.name.localeCompare(b.name));
    // Re-index after app installation; existing GPU textures remain cached.
    const cacheHome = Process.getEnv('XDG_CACHE_HOME', Process.getEnv('HOME', '') + '/.cache');
    await Assets.mount(cacheHome + '/koya/icons', '/rom');
    apps = nextApps;
    trace('applications loaded');
  };
  const fetchSnapshot = () => {
    if (fetching) return fetching;
    if (!state?.Active || state.ScreenState !== 'unlocked') return Promise.resolve();
    const generation = revision;
    trace('desktop refresh started');
    // The query never occupies the window lifecycle queue. Opening, dismissal
    // and locking can all proceed while the D-Bus reply is outstanding.
    fetching = call('GetDesktopState').then(value => {
      snapshot = decodeDesktop(value);
      stale = revision !== generation;
      trace('desktops loaded');
      return enqueue(async () => {
        if (view && !view.closed) await view.update(mode, apps, snapshot);
      });
    }).catch(error => {
      stale = true;
      Log.error('Desktop refresh: ' + error);
    }).finally(async () => {
      fetching = null;
      await enqueue(async () => {
        if (view && !view.closed) await view.setFetching(!!fetching);
        trace('desktop refresh finished');
      });
      // An event during this request gets one follow-up; failures wait for a
      // new event or tap instead of starting a retry loop.
      if (revision !== generation && stale) fetchSnapshot();
    });
    enqueue(async () => { if (view && !view.closed) await view.setFetching(true); });
    return fetching;
  };
  const refresh = () => { stale = true; revision++; return fetchSnapshot(); };
  Event.on('keyDown', event => {
    if (view?.shown && event.id === view.win && Number(event.key) === 27) view.dismiss();
  });
  const onState = next => {
    state = next;
    return enqueue(async () => {
    trace('shell state received');
    if (state.DesktopView !== 'closed' && !view?.shown) stale = true;
    if (stale) fetchSnapshot();
    if (!apps) {
      await loadApps();
    }
    next = state;
    const visible = next.Active && next.ScreenState === 'unlocked' && next.PowerMenuState === 'closed' && next.DesktopView !== 'closed';
    if (!visible && view?.shown) {
      await view.hide(!next.Active || next.ScreenState !== 'unlocked' || next.PowerMenuState !== 'closed');
    }
    if (!next.Active || next.ScreenState !== 'unlocked' || next.PowerMenuState !== 'closed') {
      return;
    }
    if (visible) mode = next.DesktopView;
    if (view?.closed) view = null;
    if (!view) {
      view = await createView(display, mode, apps, snapshot, refresh, trace);
      await view.prepare();
    }
    // Recheck after asynchronous preparation so a lock or dismissal wins over
    // an earlier tap. An already prepared drawer only starts its entrance clip.
    const show = state.Active && state.ScreenState === 'unlocked' && state.PowerMenuState === 'closed' && state.DesktopView !== 'closed';
    if (show) mode = state.DesktopView;
    await view.update(mode, apps, snapshot);
    await view.setFetching(!!fetching);
    if (show && !view.shown) {
      try { await view.show(); }
      catch (error) { await view.hide(true); throw error; }
    }
    });
  };
  const onApplications = () => {
    if (fetchingApps) return fetchingApps;
    // Query outside the lifecycle queue so cached apps appear immediately and
    // closing/locking never waits for desktop discovery or icon resolution.
    fetchingApps = loadApps().then(() => enqueue(async () => {
      if (view && !view.closed) await view.update(mode, apps, snapshot);
    })).catch(error => Log.error('Application refresh: ' + error))
      .finally(() => { fetchingApps = null; });
    return fetchingApps;
  };
  return {
    onState, onDesktop: refresh, onApplications,
    request: mode => {
      trace('tap requested ' + mode); stale = true;
      const opening = onState({ ...state, DesktopView: mode });
      if (mode === 'apps') opening.then(onApplications).catch(error => Log.error('App drawer: ' + error));
      return opening;
    },
    get window() { return view?.shown ? view.win : undefined; },
    get preparedWindow() { return view?.closed ? undefined : view?.win; }
  };
}
