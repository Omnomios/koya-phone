import * as Compositor from 'Koya/Compositor';
import * as UI from 'Helix/UserInterface';
import * as Log from 'Helix/Log';
import { connect, call } from './session.js';
import { button } from './touch-ui.js';
import { clips } from './motion.js';
import { NAV_HEIGHT, ORANGE } from './theme.js';
import { createDrawerController } from './desktop-view.js';

export default async () => {
  const display = (await Compositor.listDisplays())[0];
  const win = await Compositor.createWindow({
    role: 'bar', edge: 'bottom', thickness: NAV_HEIGHT, reserveSpace: true,
    display: display.display, namespace: 'koya-navigation', msaaSamples: 1,
    keyboardInteractivity: 'none', acceptPointerEvents: true
  });
  const info = await Compositor.getWindowInfo(win);
  // Full-height targets with no top/bottom dead strip. At 2x on this phone,
  // 72 logical pixels is about 9 mm and a 12-pixel gap is about 1.5 mm.
  const targetGap = 12;
  await Compositor.setClearColor(win, 0, 0, 0, 1);
  const root = await UI.createElement(win, {
    layout: { type: 'row', justifyContent: 'center', alignItems: 'center', gap: targetGap },
    item: { size: { x: info.width, y: NAV_HEIGHT } }
  });
  await UI.attachRoot(win, root);
  const drawers = createDrawerController(display);
  let state = {};
  let keyboardIcon, keyboardVisible = false;
  const feedback = {};
  let waiting;
  const stopWaiting = () => {
    if (!waiting) return;
    const current = waiting; waiting = null;
    feedback[current]?.end().catch(error => Log.error('Navigation feedback: ' + error));
  };
  const invoke = async (method, signature = '', ...args) => {
    if (!state.Active || state.ScreenState !== 'unlocked' || state.PowerMenuState !== 'closed') return;
    // The drawer leaves navigation visible: its own button closes it again.
    if (method === 'ShowDesktopView' && state.DesktopView === args[0]) {
      try { await call('DismissDesktopView'); } catch (error) { Log.error('Navigation: ' + error); }
      return;
    }
    try {
      if (method === 'ShowDesktopView' && !state.DesktopViewMapped) {
        stopWaiting(); waiting = args[0];
        feedback[waiting]?.begin().catch(error => Log.error('Navigation feedback: ' + error));
      }
      const reply = call(method, signature, ...args);
      if (method === 'ShowDesktopView') drawers.request(args[0]).catch(error => {
        stopWaiting(); Log.error('Drawer: ' + error);
        call('DismissDesktopView').catch(error => Log.error('Dismiss drawer: ' + error));
      });
      await reply;
    } catch (error) {
      stopWaiting();
      await drawers.onState(state);
      Log.error('Navigation: ' + error);
    }
  };
  const width = (info.width - targetGap * 3) / 4;
  // A short pill under Apps, Desktops and Keyboard shows which is open.
  const marks = {}, active = {};
  const mark = async (parent, name) => {
    const id = await UI.createElement(win, {
      renderable: { type: 'box', colour: ORANGE, origin: { x: 0.5, y: 0.5 } },
      item: { size: { x: 18, y: 3 } }, contentAlign: 'fill'
    });
    await UI.attach(win, parent, id);
    await UI.setElementId(win, id, 'navigation-' + name + '-active');
    marks[name] = await clips(win, id, {
      on: [{ time: 0.2, opacity: 1, scale: { x: 1, y: 1 }, ease: 'outCubic' }],
      off: [{ time: 0.14, opacity: 0, scale: { x: 0, y: 1 }, ease: 'inQuad' }],
      hidden: [{ time: 0, opacity: 0, scale: { x: 0, y: 1 } }]
    });
    await UI.setAnimationTime(win, id, marks[name].ids.hidden, 0);
    active[name] = false;
  };
  const setActive = (name, value) => {
    if (!marks[name] || active[name] === value) return;
    active[name] = value;
    marks[name].play(value ? 'on' : 'off').catch(error => Log.error('Navigation indicator: ' + error));
  };
  for (const [name, action] of [['apps', () => invoke('ShowDesktopView', 's', 'apps')],
    ['home', () => invoke('SwitchDesktop', 'u', 1)], ['desktops', () => invoke('ShowDesktopView', 's', 'desktops')],
    ['keyboard', () => invoke('ToggleKeyboard')]]) {
    const target = await button(win, root, '', width, NAV_HEIGHT, action,
      { colour: [0,0,0,0], radius: 0, icon: '/rom/assets/launcher/' + name + '.png', iconSize: 27,
        feedbackMotion: { squash: 0.86, peak: 1.2, lift: 9 },
        pressScale: 0.86, releaseScale: 1.12,
        ...(name === 'keyboard' ? { onIcon: value => { keyboardIcon = value; } } : {}),
        gap: 7,
        ...(name === 'apps' || name === 'desktops' ? { onFeedback: value => { feedback[name] = value; } } : {}) });
    await UI.setElementId(win, target, 'navigation-' + name);
    // Every target reserves the mark's row so all four icons share a baseline.
    await mark(target, name);
  }
  connect('navigation', value => {
    state = value;
    if (keyboardVisible !== !!value.KeyboardVisible) {
      keyboardVisible = !!value.KeyboardVisible;
      UI.setTexture(win, keyboardIcon, '/rom/assets/launcher/keyboard' + (keyboardVisible ? '-active' : '') + '.png')
        .catch(error => Log.error('Keyboard indicator: ' + error));
    }
    const open = value.Active && value.ScreenState === 'unlocked';
    setActive('apps', open && value.DesktopView === 'apps');
    setActive('desktops', open && value.DesktopView === 'desktops');
    setActive('keyboard', open && keyboardVisible);
    if (value.DesktopViewMapped || value.DesktopView === 'closed' || !value.Active || value.ScreenState !== 'unlocked') stopWaiting();
    return drawers.onState(value);
  }, drawers.onDesktop, drawers.onApplications);
  return { window: win, drawers };
};
