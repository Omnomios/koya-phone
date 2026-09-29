import * as Compositor from 'Koya/Compositor';
import * as UI from 'Helix/UserInterface';
import * as Event from 'Helix/Event';
import * as Log from 'Helix/Log';
import { connect, call } from './session.js';
import { clips, buttonMotion } from './motion.js';
import { windowLayout } from './window-layout.js';
import { haptic } from './haptics.js';
import { text as textElement, label as labelElement } from './touch-ui.js';
import { CREAM, INK, MUTED, DISABLED, CARD_PRESSED, GUTTER, SPACE, RADIUS, TYPE } from './theme.js';
const ACTIONS = [
  { label: 'Power off', icon: 'power-off', method: 'PowerOff', capability: 'CanPowerOff', pending: 'Powering off…' },
  { label: 'Restart', icon: 'restart', method: 'Reboot', capability: 'CanReboot', pending: 'Restarting…' },
  { label: 'Lock', icon: 'lock' }
];

export default async () => {
  const displays = await Compositor.listDisplays();
  const display = displays[0];
  if (!display) throw new Error('No display available');
  const win = await Compositor.createWindow({
    role: 'overlay', anchor: 'fill', display: display.display,
    size: { x: Number(display.logical_width || display.width), y: Number(display.logical_height || display.height) },
    exclusiveZone: -1, namespace: 'koya-power-menu', msaaSamples: 1, transparent: true,
    keyboardInteractivity: 'exclusive', acceptPointerEvents: true
  });
  const info = await Compositor.getWindowInfo(win);
  if (info.role !== 'overlay') throw new Error('Power menu requires layer-shell');
  await Compositor.setWindowRenderingEnabled(win, false);
  await Compositor.setClearColor(win, 0, 0, 0, 0);

  let state = {};
  let requesting = false;
  let closing = false;
  let closeTimer;
  let screenMotion;
  let statusMotion;
  let selected = 2; // Start keyboard navigation on Lock.
  let keyboardFocus = false;
  let pressed = -1;
  let messageText = 'Tap outside to close';
  let status;
  const buttons = [];
  const busy = () => closing || requesting || state.PowerMenuState === 'pending';
  const available = index => !busy() && (!ACTIONS[index].method || state[ACTIONS[index].capability] === 'yes');
  const setMessage = async value => {
    if (value === messageText) return;
    messageText = value;
    await UI.setTextString(win, status, value);
    if (statusMotion && !closing) await statusMotion.play('change');
  };
  const paint = async () => {
    for (let i = 0; i < buttons.length; i++) {
      const button = buttons[i];
      const enabled = available(i);
      const style = !enabled ? 'disabled' : pressed === i ? 'pressed'
        : keyboardFocus && selected === i ? 'focused' : 'rest';
      if (button.style !== style) {
        button.style = style;
        await button.colourMotion.play(style);
      }
      if (button.enabled !== enabled) {
        button.enabled = enabled;
        await UI.setTextColour(win, button.label, enabled ? CREAM : DISABLED);
      }
    }
  };
  const text = (parent, value, size, width, height, colour = CREAM, align = 'center') => align === 'start'
    ? labelElement(win, parent, value, size, width, height, colour)
    : textElement(win, parent, value, size, width, height, colour);
  const click = async (element, handler) => {
    await UI.setHitTarget(win, element, true);
    await UI.setOnMouseClick(win, element, handler);
  };
  let closeSent = false;
  const finishDismiss = async () => {
    if (closeSent) return;
    closeSent = true;
    clearTimeout(closeTimer);
    try { await call('DismissPowerMenu'); }
    catch (error) {
      closeSent = false;
      closing = false;
      await screenMotion.play('restore');
      await paint();
      Log.error(String(error));
    }
  };
  const dismiss = async () => {
    if (busy()) return;
    closing = true;
    // Callback is the normal path; one bounded fallback prevents a missing
    // animation callback from leaving an invisible overlay capturing input.
    closeTimer = setTimeout(finishDismiss, 600);
    await screenMotion.play('exit');
  };
  let root, activate;
  const build = async () => {
    if (root !== undefined) await UI.destroyElement(win, root);
    buttons.length = 0;
    // Portrait: full-width rows within thumb reach, icon then label. Wide
    // displays use a row of square tiles rather than three short rows.
    const horizontal = info.width > info.height;
    const gap = horizontal ? 20 : SPACE.m;
    const square = Math.floor(Math.min(160, (info.width - 48 - 2 * gap) / 3, info.height - 90));
    const tile = horizontal ? { x: square, y: square } : { x: Math.min(420, info.width - 2 * GUTTER), y: 80 };
    const groupWidth = horizontal ? 3 * tile.x + 2 * gap : tile.x;
    const groupHeight = horizontal ? tile.y : 3 * tile.y + 2 * gap;
    const iconSize = horizontal ? Math.round(square * 0.42) : 36;
    const labelSize = horizontal ? Math.round(Math.min(22, square * 0.15)) : TYPE.heading;
    root = await UI.createElement(win, {
      renderable: { type: 'box', colour: [0.015, 0.035, 0.025, 0.7] },
      contentAlign: 'fill',
      layout: { type: 'column', justifyContent: 'center', gap: SPACE.l,
        padding: { l: (info.width - groupWidth) / 2, r: (info.width - groupWidth) / 2, t: 0, b: 0 } },
      item: { size: { x: info.width, y: info.height } }
    });
    await UI.attachRoot(win, root);
    await UI.setElementId(win, root, 'power-menu-root');
    screenMotion = await clips(win, root, {
      enter: [{ time: 0, opacity: 0 }, { time: 0.22, opacity: 1, ease: 'outCubic' }],
      restore: [{ time: 0.16, opacity: 1, ease: 'outCubic' }],
      exit: [{ time: 0.18, opacity: 0, ease: 'inQuad' }]
    });
    await screenMotion.onEnd('exit', finishDismiss);
    await click(root, dismiss);
    const group = await UI.createElement(win, {
      layout: { type: horizontal ? 'row' : 'column', gap },
      item: { size: { x: groupWidth, y: groupHeight } }
    });
    await UI.attach(win, root, group);

    activate = async index => {
      if (!available(index)) return;
      const action = ACTIONS[index];
      if (!action.method) {
        try { await call('Lock'); }
        catch (error) { await setMessage('Unable to lock'); Log.error(String(error)); }
        return;
      }
      requesting = true;
      await paint();
      await setMessage(action.pending);
      try { await call(action.method); }
      catch (error) {
        requesting = false;
        await paint();
        await buttons[index].motion.play('notice');
        Log.error('Power action: ' + error);
        await setMessage('Unable to ' + (index === 0 ? 'power off' : 'restart'));
      }
    };

    for (const [index, action] of ACTIONS.entries()) {
      // Koya hit-tests the fixed layout. This group is for shared visual motion,
      // not a separate hit area; its own element receives the pointer callbacks.
      const moving = await UI.createElement(win, { item: { size: tile } });
      await UI.attach(win, group, moving);
      await UI.setInheritAnimation(win, moving, true);
      await UI.setElementId(win, moving, 'power-menu-motion-' + index);
      const motion = await buttonMotion(win, moving, tile, index);
      const button = await UI.createElement(win, {
        renderable: { type: 'box', colour: INK, cornerRadius: RADIUS.surface, cornerResolution: 16 },
        layout: horizontal ? { type: 'column', justifyContent: 'center', gap: 12 }
          : { type: 'row', alignItems: 'center', gap: SPACE.l, padding: { l: SPACE.xl, r: SPACE.l, t: 0, b: 0 } },
        item: { size: tile }, contentAlign: 'fill'
      });
      await UI.attach(win, moving, button);
      const colourMotion = await clips(win, button, {
        rest: [{ time: 0.18, colour: INK, ease: 'outCubic' }],
        pressed: [{ time: 0.06, colour: CARD_PRESSED, ease: 'outQuad' }],
        focused: [{ time: 0.12, colour: [0.15, 0.25, 0.18, 1], ease: 'outCubic' }],
        disabled: [{ time: 0.16, colour: [0.06, 0.085, 0.07, 1], ease: 'outCubic' }]
      });
      const icon = await UI.createElement(win, {
        renderable: {
          type: 'sprite', texture: '/rom/assets/power-menu/' + action.icon + '.png', frame: 0,
          frames: [{ size: { x: iconSize, y: iconSize }, origin: { x: 0, y: 0 },
            aabb: { min: { x: 0, y: 0 }, max: { x: 160, y: 160 } }, colour: [1, 1, 1, 1] }]
        },
        item: { size: horizontal ? { x: tile.x, y: iconSize } : { x: iconSize, y: tile.y } }, contentAlign: { x: 'center', y: 'center' }
      });
      await UI.attach(win, button, icon);
      const label = horizontal ? await text(button, action.label, labelSize, tile.x, 32)
        : await text(button, action.label, labelSize, tile.x - SPACE.xl - SPACE.l * 2 - iconSize, tile.y, CREAM, 'start');
      buttons.push({ button, label, motion, colourMotion });
      await click(moving, async () => {
        pressed = -1;
        await activate(index);
        await paint();
      });
      await UI.setOnMouseDown(win, moving, async () => {
        if (!available(index)) return;
        haptic();
        keyboardFocus = false;
        pressed = index;
        await motion.play('press');
        await paint();
      });
      const release = async (cancel = false) => {
        if (pressed !== index) return;
        pressed = -1;
        if (!closing) await motion.play(cancel ? 'settle' : 'release');
        await paint();
      };
      await UI.setOnMouseUp(win, moving, () => release());
      await UI.setOnMouseExit(win, moving, () => release(true));
    }
    status = await text(root, messageText, TYPE.caption, groupWidth, 32, MUTED);
    statusMotion = await clips(win, status, {
      enter: [{ time: 0, opacity: 0, position: { x: 0, y: 12 } },
        { time: 0.16, opacity: 0, position: { x: 0, y: 12 } },
        { time: 0.4, opacity: 1, position: { x: 0, y: 0 }, ease: 'outCubic' }],
      change: [{ time: 0, opacity: 0.3, position: { x: 0, y: 5 } },
        { time: 0.18, opacity: 1, position: { x: 0, y: 0 }, ease: 'outCubic' }]
    });
    await paint();
  };
  await build();
  let layoutQueue = Promise.resolve();
  windowLayout(win, size => {
    layoutQueue = layoutQueue.then(async () => {
      info.width = size.x; info.height = size.y;
      if (closing || requesting) return;
      await Compositor.setWindowRenderingEnabled(win, false);
      try {
        await build();
        await screenMotion.play('restore');
        for (const button of buttons) await button.motion.play('settle');
        await statusMotion.play('change');
      }
      finally { await Compositor.setWindowRenderingEnabled(win, true); }
    });
    return layoutQueue;
  });
  Event.on('keyDown', async ({ key, id }) => {
    if (id !== win) return;
    if ([27, 65307, 'Escape'].includes(key)) return dismiss();
    if ([9, 65289, 65364, 65363, 'Tab', 'ArrowDown', 'ArrowRight'].includes(key)) selected = (selected + 1) % 3;
    else if ([65362, 65361, 'ArrowUp', 'ArrowLeft'].includes(key)) selected = (selected + 2) % 3;
    else if ([13, 65293, 32, 'Enter', ' '].includes(key)) {
      if (!available(selected)) return;
      await buttons[selected].motion.play('release');
      return activate(selected);
    }
    else return;
    if (busy()) return;
    keyboardFocus = true;
    for (let i = 0; i < buttons.length; i++) await buttons[i].motion.play(i === selected ? 'focus' : 'settle');
    await paint();
  });
  await screenMotion.play('enter');
  for (const button of buttons) await button.motion.play('enter');
  await statusMotion.play('enter');
  await Compositor.setWindowRenderingEnabled(win, true);
  connect('power-menu', async next => {
    state = next;
    await paint();
    if (busy()) return;
    if (state.LastError) await setMessage('Action unavailable');
    else if (state.CanPowerOff !== 'yes' && state.CanReboot !== 'yes') await setMessage('Power actions unavailable');
  });
  return win;
};
