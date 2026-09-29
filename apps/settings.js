import * as UI from 'Helix/UserInterface';
import * as Compositor from 'Koya/Compositor';
import * as Engine from 'Helix/Engine';
import * as Event from 'Helix/Event';
import * as Log from 'Helix/Log';
import { connect, call } from './session.js';
import { WALLPAPERS, wallpaperFor, wallpaperFrame } from './wallpapers.js';
import { configureWallpaper, wallpaperSurface, resizeWallpaper } from './wallpaper-surface.js';
import { windowLayout } from './window-layout.js';
import { haptic } from './haptics.js';
import { button, icon, label, text, row, toggle, backdrop } from './touch-ui.js';
import { CREAM, ORANGE, INK, CARD, TONAL, MUTED, CLEAR, alpha, BAR_HEIGHT, NAV_HEIGHT, GUTTER, SPACE, RADIUS, TYPE, HEADER_HEIGHT, TOUCH } from './theme.js';

const glyph = name => '/rom/assets/launcher/' + name + '.png';
const plural = (count, unit) => count + ' ' + unit + (count === 1 ? '' : 's');
const seconds = value => value === 0 ? 'Never' : value < 60 || value % 60 ? plural(value, 'second') : plural(value / 60, 'minute');
const percent = value => value + '%';
const ms = value => value + ' ms';
const onOff = value => value ? 'on' : 'off';
const categories = {
  screen: { title: 'Screen & sleep',
    summary: state => 'Screen off ' + (state.IdleLockSeconds ? 'after ' + seconds(state.IdleLockSeconds) : 'never'),
    settings: [
      { key: 'AutoRotateEnabled', title: 'Auto-rotate', boolean: true },
      { key: 'IdleLockSeconds', title: 'Screen off after', hint: 'While using the phone', choices: [0, 30, 60, 120, 300, 600], format: seconds },
      { key: 'IdleScreenSeconds', title: 'Swipe screen timeout', hint: 'While the swipe screen is visible', choices: [0, 15, 30, 60, 120], format: seconds },
      { key: 'IdleSuspendSeconds', title: 'Suspend after', hint: 'After the display switches off', choices: [0, 60, 180, 300, 600, 1800], format: seconds },
      { key: 'BrightnessMinPercent', title: 'Minimum brightness', choices: [1, 5, 10, 15, 20, 30], format: percent }
    ] },
  sound: { title: 'Sound & touch',
    summary: state => 'Vibration ' + onOff(state.HapticsEnabled !== false) + ' · volume step ' + percent(state.VolumeStepPercent ?? 5),
    settings: [
      { key: 'HapticsEnabled', title: 'Touch vibration', boolean: true },
      { key: 'VolumeButtonsEnabled', title: 'Volume buttons', boolean: true },
      { key: 'VolumeIndicatorEnabled', title: 'Volume indicator', boolean: true },
      { key: 'VolumeWhileLocked', title: 'Volume while locked', boolean: true },
      { key: 'VolumeStepPercent', title: 'Volume step', choices: [1, 2, 5, 10, 15, 25], format: percent },
      { key: 'VolumeMaxPercent', title: 'Maximum volume', choices: [25, 50, 75, 100], format: percent },
      { key: 'VolumeIndicatorSide', title: 'Indicator side', choices: ['left', 'right'], format: value => value === 'left' ? 'Left' : 'Right' },
      { key: 'VolumeIndicatorTimeoutMs', title: 'Indicator duration', choices: [300, 1000, 1800, 3000, 5000, 10000], format: ms },
      { key: 'VolumeIndicatorPositionPercent', title: 'Indicator position', choices: [0, 25, 50, 75, 100], format: percent },
      { key: 'VolumeIndicatorMargin', title: 'Indicator edge inset', choices: [0, 8, 16, 24, 48, 100], format: value => value + ' px' },
      { key: 'HapticsMinIntervalMs', title: 'Vibration interval', choices: [0, 45, 100, 250, 500, 1000], format: ms }
    ] }
};
const ROW = 72, CHOICE = 60, STATUS = 32;

export default async () => {
  const display = (await Compositor.listDisplays())[0];
  if (!display) throw new Error('No display available');
  const requested = { x: Number(display.logical_width || display.width), y: Number(display.logical_height || display.height) - BAR_HEIGHT - NAV_HEIGHT };
  const win = await Compositor.createWindow({ role: 'window', title: 'Settings', appId: 'org.koya.Settings',
    size: requested, display: display.display, msaaSamples: 1, acceptPointerEvents: true });
  await Compositor.setWindowRenderingEnabled(win, false);
  await Compositor.setClearColor(win, ...INK);
  const info = await Compositor.getWindowInfo(win);
  // Before the first configure, window info can report the whole output.
  const size = { x: info.width, y: Math.min(info.height, requested.y) };
  let width = size.x - 2 * GUTTER;
  let stageHeight = size.y - SPACE.s - HEADER_HEIGHT - STATUS;

  // Koya runs one animation per element at a time. Each element keeps a single
  // reusable clip; frames without a time-zero key blend from the current pose,
  // so a new effect interrupts the last one without snapping.
  const clipsOf = new Map();
  const play = (id, frames) => {
    const previous = clipsOf.get(id);
    const job = (async () => {
      const clip = previous && await previous;
      if (clip !== undefined && await UI.updateAnimation(win, id, clip, frames)) { await UI.startAnimation(win, id, clip); return clip; }
      const created = await UI.addAnimation(win, id, frames);
      await UI.startAnimation(win, id, created);
      return created;
    })();
    clipsOf.set(id, job.catch(() => undefined));
    return job.catch(error => Log.error('Settings motion: ' + error));
  };
  const hidden = id => play(id, [{ time: 0, opacity: 0 }]);
  const punch = (id, amount = 1.05) => play(id, [
    { time: 0.08, scale: { x: amount, y: amount }, opacity: 1, ease: 'outQuad' },
    { time: 0.34, scale: { x: 1, y: 1 }, opacity: 1, ease: 'outCubic' }]);
  const shake = id => play(id, [-9, 8, -5, 3, 0].map((x, i) => ({ time: 0.05 * (i + 1), position: { x, y: 0 }, scale: { x: 1, y: 1 }, opacity: 1, ease: 'inOutQuad' })));
  const rise = (id, delay) => play(id, [
    { time: 0, opacity: 0, position: { x: 0, y: 14 } },
    { time: delay, opacity: 0, position: { x: 0, y: 14 } },
    { time: delay + 0.26, opacity: 1, position: { x: 0, y: -2 }, ease: 'outCubic' },
    { time: delay + 0.38, opacity: 1, position: { x: 0, y: 0 }, ease: 'inOutQuad' }]);
  // Scalable layout host: an invisible box, because bare containers ignore
  // their pivot and cannot carry a centred transform for their children.
  const host = (extra = {}) => ({ renderable: { type: 'box', colour: CLEAR, origin: { x: 0.5, y: 0.5 } }, contentAlign: 'fill', inheritAnimation: true, ...extra });

  let state = {}, ready = false, current, section = 'home', pageIndex = 0, choice, changed, statusTimer, closing = false;
  const pending = new Set();
  let queue = Promise.resolve();
  const enqueue = task => { queue = queue.then(task).catch(error => Log.error('Settings UI: ' + error)); return queue; };
  const allowed = () => ready && state.Active && state.ScreenState === 'unlocked';

  const fill = { x: 'auto', y: 'auto' };
  const root = await UI.createElement(win, { layout: { type: 'none' }, item: { size: fill } });
  await UI.attachRoot(win, root);
  // The live wallpaper sits dimmed behind the app, aligned with the desktop,
  // so choosing one shows the result immediately.
  const wall = await backdrop(win, root, size, BAR_HEIGHT);
  const shell = await UI.createElement(win, host({ layout: { type: 'column' }, item: { size: fill } }));
  await UI.attach(win, root, shell);

  // Persistent chrome: back, title and close never rebuild, they react.
  const header = await UI.createElement(win, { layout: { type: 'row', alignItems: 'center', padding: { l: GUTTER - 12, r: GUTTER, t: SPACE.s, b: 0 } },
    item: { size: { x: 'auto', y: HEADER_HEIGHT + SPACE.s } } });
  await UI.attach(win, shell, header);
  const backButton = await button(win, header, '', TOUCH, HEADER_HEIGHT, () => back(), { colour: CLEAR, icon: glyph('previous'), iconSize: 22, radius: RADIUS.control });
  await UI.setElementId(win, backButton, 'settings-back');
  // Unclipped text: the title slides into the back button's slot on the home
  // page, and a clipping label would cut off the part that moves.
  const title = await text(win, header, 'Settings', TYPE.title, 0, HEADER_HEIGHT, CREAM, undefined, 'left');
  await UI.setGrow(win, title, 1);
  const closeButton = await button(win, header, '', TOUCH, HEADER_HEIGHT, () => close(), { colour: CLEAR, icon: glyph('close'), iconSize: 22, radius: RADIUS.control });
  const statusRow = await UI.createElement(win, { layout: { type: 'row', padding: { l: GUTTER, r: GUTTER, t: 0, b: 0 } }, item: { size: { x: 'auto', y: STATUS } } });
  await UI.attach(win, shell, statusRow);
  const status = await label(win, statusRow, '', TYPE.caption, 'auto', STATUS, MUTED);
  // Pages overlap on a clipped stage while they slide past each other.
  const stage = await UI.createElement(win, { layout: { type: 'none' }, clipToBounds: true, item: { size: { x: 'auto', y: 0 }, flexGrow: 1 } });
  await UI.attach(win, shell, stage);

  // Page marker for long lists. It stays in place across page turns: the
  // newly active dot hops and settles while the list slides underneath.
  // A child of the root, attached after the shell, so it always draws above
  // the pages that transitions add to the stage inside the shell.
  const pagerBar = await UI.createElement(win, host({ layout: { type: 'row', justifyContent: 'center', alignItems: 'center' },
    item: { position: { x: 0, y: size.y - GUTTER - TOUCH }, size: { x: 'auto', y: TOUCH } } }));
  await UI.attach(win, root, pagerBar);
  let pagerState;
  // Arrows dim through a wrapper: the button's own press clips would
  // otherwise replace an opacity clip on the button itself.
  const arrowSlot = async (name, step) => {
    const slot = await UI.createElement(win, host({ layout: { type: 'row' }, item: { size: { x: 64, y: TOUCH } } }));
    await UI.attach(win, pagerBar, slot);
    await button(win, slot, '', 64, TOUCH, () => pagerState?.turn(step), { colour: CLEAR, icon: glyph(name), iconSize: 22, radius: RADIUS.control });
    return slot;
  };
  const prevButton = await arrowSlot('previous', -1);
  const dotRow = await UI.createElement(win, { layout: { type: 'row', justifyContent: 'center', alignItems: 'center', gap: 14 }, item: { size: { x: 88, y: TOUCH } } });
  await UI.attach(win, pagerBar, dotRow);
  const nextButton = await arrowSlot('next', 1);
  let dots = [];
  const DOT = 9, DIM = alpha(ORANGE, 0.35);
  const dotPose = (on, animate) => !animate ? [{ time: 0, scale: on ? { x: 1, y: 1 } : { x: 0.7, y: 0.7 }, position: { x: 0, y: 0 }, opacity: 1 }]
    : on ? [{ time: 0.1, scale: { x: 1.35, y: 1.35 }, position: { x: 0, y: -6 }, opacity: 1, ease: 'outCubic' },
        { time: 0.22, scale: { x: 0.9, y: 1.1 }, position: { x: 0, y: 0 }, opacity: 1, ease: 'inQuad' },
        { time: 0.32, scale: { x: 1.08, y: 0.94 }, position: { x: 0, y: 0 }, opacity: 1, ease: 'outQuad' },
        { time: 0.42, scale: { x: 1, y: 1 }, position: { x: 0, y: 0 }, opacity: 1, ease: 'inOutQuad' }]
      : [{ time: 0.16, scale: { x: 0.7, y: 0.7 }, position: { x: 0, y: 0 }, opacity: 1, ease: 'outCubic' }];
  const arrow = (id, enabled) => play(id, [{ time: 0.16, opacity: enabled ? 1 : 0.3, ease: 'outCubic' }]);
  const syncPager = async next => {
    const previous = pagerState;
    pagerState = next;
    if (!next) {
      if (previous) play(pagerBar, [{ time: 0.14, opacity: 0, ease: 'inQuad' }]);
      await UI.setEnabled(win, pagerBar, false).catch(() => {});
      return;
    }
    await UI.setEnabled(win, pagerBar, true);
    const same = previous && previous.group === next.group && previous.count === next.count;
    if (!same) {
      for (const dot of dots) await UI.destroyElement(win, dot);
      dots = [];
      for (let i = 0; i < next.count; i++) {
        const dot = await UI.createElement(win, { renderable: { type: 'circle', aabb: { min: { x: 0, y: 0 }, max: { x: DOT, y: DOT } }, resolution: 24,
          colour: i === next.index ? ORANGE : DIM, origin: { x: 0.5, y: 0.5 } }, item: { size: { x: DOT + 4, y: TOUCH } }, contentAlign: { x: 'center', y: 'center' } });
        await UI.attach(win, dotRow, dot);
        await UI.setHitTarget(win, dot, false);
        play(dot, dotPose(i === next.index, false));
        dots.push(dot);
      }
      play(pagerBar, [{ time: 0, opacity: 0 }, { time: 0.25, opacity: 0 }, { time: 0.45, opacity: 1, ease: 'outCubic' }]);
    } else if (previous.index !== next.index) {
      await Promise.all([UI.setCircleColour(win, dots[previous.index], DIM), UI.setCircleColour(win, dots[next.index], ORANGE)]);
      play(dots[previous.index], dotPose(false, true));
      play(dots[next.index], dotPose(true, true));
    }
    arrow(prevButton, next.index > 0);
    arrow(nextButton, next.index < next.count - 1);
  };
  await UI.setEnabled(win, pagerBar, false);

  let backShown = false, titleText = 'Settings';
  const showBack = visible => {
    if (visible === backShown) return;
    backShown = visible;
    play(backButton, visible
      ? [{ time: 0, opacity: 0, scale: { x: 0.4, y: 0.4 } }, { time: 0.16, opacity: 1, scale: { x: 1.15, y: 1.15 }, ease: 'outCubic' }, { time: 0.3, opacity: 1, scale: { x: 1, y: 1 }, ease: 'inOutQuad' }]
      : [{ time: 0.12, opacity: 0, scale: { x: 0.4, y: 0.4 }, ease: 'inQuad' }]);
  };
  // The title slides into the back button's slot on the home page.
  const titleShift = () => backShown ? 0 : -TOUCH + 12;
  const setTitle = (value, direction) => {
    if (value === titleText) { play(title, [{ time: 0.2, opacity: 1, position: { x: titleShift(), y: 0 }, ease: 'outCubic' }]); return; }
    titleText = value;
    const out = -16 * (direction || 1);
    play(title, [{ time: 0.09, opacity: 0, position: { x: titleShift() + out, y: 0 }, ease: 'inQuad' }]);
    setTimeout(async () => {
      if (titleText !== value) return;
      await UI.setTextString(win, title, value);
      play(title, [{ time: 0, opacity: 0, position: { x: titleShift() - out, y: 0 } },
        { time: 0.2, opacity: 1, position: { x: titleShift(), y: 0 }, ease: 'outCubic' }]);
    }, 95);
  };

  // One status line: the page's hint, or a short-lived reaction to an action.
  let statusText = '', statusTone = MUTED;
  const setStatus = async (value, tone = MUTED, lift = 8) => {
    if (value === statusText && tone === statusTone) return;
    statusText = value; statusTone = tone;
    await Promise.all([UI.setTextString(win, status, value), UI.setTextColour(win, status, tone)]);
    play(status, [{ time: 0, opacity: 0, position: { x: 0, y: lift } }, { time: 0.22, opacity: 1, position: { x: 0, y: 0 }, ease: 'outCubic' }]);
  };
  const hint = () => !ready ? 'Connecting to the shell…' : !allowed() ? 'Unlock the phone to change settings' : current?.hint || '';
  const showHint = () => { clearTimeout(statusTimer); statusTimer = undefined; return setStatus(hint()); };
  const flash = (value, tone) => {
    clearTimeout(statusTimer);
    setStatus(value, tone, tone === ORANGE ? 10 : 8);
    statusTimer = setTimeout(showHint, tone === ORANGE && value !== 'Saved' ? 3200 : 1400);
  };

  // Saves are optimistic: the control reacts on touch and only reverts, with a
  // shake, if the shell rejects the value.
  const save = async (key, value) => {
    if (!allowed() || pending.has(key)) return false;
    pending.add(key);
    try {
      state = await call('SetSetting', 'ss', key, String(value));
      configureWallpaper(state);
      flash('Saved', ORANGE);
      return true;
    } catch (cause) {
      Log.error('Settings save: ' + cause);
      flash('Could not save that change. Try again.', ORANGE);
      return false;
    } finally { pending.delete(key); }
  };

  const chevron = async (parent, height) => {
    const id = await icon(win, parent, glyph('next'), 18, 24, height);
    return { id, nudge: on => play(id, [{ time: on ? 0.08 : 0.2, position: { x: on ? 5 : 0, y: 0 }, ease: on ? 'outQuad' : 'outCubic' }]) };
  };
  // Title, live value and a chevron that leans the way the tap will go.
  const navigate = async (parent, heading, value, height, handler, options = {}) => {
    let arrow;
    const target = await row(win, parent, width, height, handler, { onPress: () => arrow?.nudge(true), onRelease: () => arrow?.nudge(false), ...options });
    const detailWidth = width - 16 - 12 - 24 - SPACE.m - (options.lead || 0);
    if (options.leading) await options.leading(target);
    const detail = await UI.createElement(win, { layout: { type: 'column', justifyContent: 'center' }, item: { size: { x: detailWidth, y: height } } });
    await UI.attach(win, target, detail);
    await label(win, detail, heading, options.headingSize || TYPE.body, detailWidth, options.headingSize ? 32 : 26);
    const valueLabel = await label(win, detail, value, TYPE.caption, detailWidth, 22, MUTED);
    arrow = await chevron(target, height);
    return { target, valueLabel };
  };

  // ---- Pages -------------------------------------------------------------
  const newPage = async () => {
    const el = await UI.createElement(win, host({ layout: { type: 'column', gap: SPACE.s, padding: { l: GUTTER, r: GUTTER, t: SPACE.xs, b: GUTTER } },
      item: { size: { x: size.x, y: stageHeight } } }));
    await UI.attach(win, stage, el);
    await hidden(el);
    return { el, items: [], alive: true, update: () => {} };
  };
  const live = page => () => page.alive && page === current && allowed() && !closing;

  const homePage = async () => {
    const page = await newPage(), ok = live(page);
    page.hint = 'Choose a wallpaper or adjust how the phone behaves';
    const wallpaper = wallpaperFor(state.Wallpaper);
    let name;
    const hero = await navigate(page.el, 'Wallpaper', wallpaper.name, size.x > size.y ? 112 : 136, () => ok() && go('wallpaper', 1), {
      headingSize: TYPE.heading, lead: 52 + 12,
      leading: async target => {
        // Framed live thumbnail: it follows the wallpaper as it changes.
        const frame = await UI.createElement(win, { renderable: { type: 'box', colour: alpha(CREAM, 0.16), cornerRadius: RADIUS.control, cornerResolution: 16 },
          layout: { type: 'column', padding: { l: 2, r: 2, t: 2, b: 2 } }, item: { size: { x: 52, y: 108 } }, contentAlign: 'fill' });
        await UI.attach(win, target, frame);
        await UI.attach(win, frame, await wallpaperSurface(win, { x: 48, y: 104 }));
      }
    });
    name = hero.valueLabel;
    await UI.setElementId(win, hero.target, 'settings-wallpaper');
    page.items.push(hero.target);
    const summaries = {};
    for (const [key, category] of Object.entries(categories)) {
      const entry = await navigate(page.el, category.title, category.summary(state), ROW + 4, () => ok() && go(key, 1));
      await UI.setElementId(win, entry.target, 'settings-' + key);
      summaries[key] = entry.valueLabel;
      page.items.push(entry.target);
    }
    page.update = async () => {
      await UI.setTextString(win, name, wallpaperFor(state.Wallpaper).name);
      for (const [key, category] of Object.entries(categories)) await UI.setTextString(win, summaries[key], category.summary(state));
    };
    return page;
  };

  const wallpaperPage = async () => {
    const page = await newPage(), ok = live(page);
    page.hint = 'Tap a wallpaper to apply it';
    const gap = SPACE.m, columns = size.x > size.y ? WALLPAPERS.length : 2;
    const rows = Math.ceil(WALLPAPERS.length / columns);
    const cardWidth = (width - gap * (columns - 1)) / columns;
    const cardHeight = Math.min(320, (stageHeight - SPACE.xs - GUTTER - gap * (rows - 1)) / rows);
    const inset = SPACE.s, innerWidth = cardWidth - 2 * inset;
    const cards = new Map();
    let selected = state.Wallpaper;
    const ringPose = on => on
      ? [{ time: 0, opacity: 0, scale: { x: 1.1, y: 1.1 } }, { time: 0.18, opacity: 1, scale: { x: 0.985, y: 0.985 }, ease: 'outCubic' }, { time: 0.32, opacity: 1, scale: { x: 1, y: 1 }, ease: 'inOutQuad' }]
      : [{ time: 0.16, opacity: 0, scale: { x: 1.05, y: 1.05 }, ease: 'inQuad' }];
    const mark = async (id, animate = true) => {
      for (const [key, card] of cards) {
        const on = key === id;
        if (card.on === on) continue;
        card.on = on;
        await UI.setTextString(win, card.caption, on ? 'Selected' : 'Tap to apply');
        await UI.setTextColour(win, card.caption, on ? ORANGE : MUTED);
        if (animate) play(card.ring, ringPose(on)); else if (!on) await hidden(card.ring);
      }
    };
    const pick = async wallpaper => {
      if (!ok()) return;
      const card = cards.get(wallpaper.id);
      if (wallpaper.id === selected) { punch(card.frame, 1.03); return; }
      const previous = selected;
      selected = wallpaper.id;
      punch(card.frame, 1.045); mark(wallpaper.id);
      if (await save('Wallpaper', wallpaper.id)) {
        // The backdrop swaps texture; fade it up so the change registers.
        play(wall, [{ time: 0, opacity: 0.25 }, { time: 0.55, opacity: 1, ease: 'outCubic' }]);
      } else if (page.alive) { selected = previous; mark(previous); shake(card.frame); }
    };
    for (let i = 0; i < WALLPAPERS.length; i += columns) {
      const line = await UI.createElement(win, { layout: { type: 'row', gap }, item: { size: { x: width, y: cardHeight } } });
      await UI.attach(win, page.el, line);
      for (const wallpaper of WALLPAPERS.slice(i, i + columns)) {
        // Layout-less frame: the card and its selection ring share its bounds.
        const frame = await UI.createElement(win, host({ item: { size: { x: cardWidth, y: cardHeight } } }));
        await UI.attach(win, line, frame);
        const target = await button(win, frame, '', cardWidth, cardHeight, () => pick(wallpaper), { colour: CARD, radius: RADIUS.surface, gap: 0 });
        await UI.setElementId(win, target, 'wallpaper-' + wallpaper.id);
        const content = await UI.createElement(win, { layout: { type: 'column', padding: { l: inset, r: inset, t: inset, b: inset } }, item: { size: { x: cardWidth, y: cardHeight } } });
        await UI.attach(win, target, content);
        const artSize = { x: innerWidth, y: cardHeight - 2 * inset - 52 };
        await UI.attach(win, content, await UI.createElement(win, {
          renderable: { type: 'sprite', texture: wallpaper.texture, frame: 0, frames: [wallpaperFrame(wallpaper, artSize)] },
          item: { size: artSize }, contentAlign: 'fill' }));
        await text(win, content, wallpaper.name, TYPE.caption, innerWidth, 28, CREAM);
        const caption = await text(win, content, 'Tap to apply', TYPE.caption - 2, innerWidth, 24, MUTED);
        const ring = await UI.createElement(win, {
          renderable: { type: 'box', colour: ORANGE, inset: 3, cornerRadius: RADIUS.surface, cornerResolution: 16, origin: { x: 0.5, y: 0.5 },
            aabb: { min: { x: 0, y: 0 }, max: { x: cardWidth, y: cardHeight } } },
          item: { size: { x: cardWidth, y: cardHeight } }, contentAlign: 'fill' });
        await UI.attach(win, frame, ring);
        await UI.setHitTarget(win, ring, false);
        await hidden(ring);
        cards.set(wallpaper.id, { frame, ring, caption, on: false });
        page.items.push(frame);
      }
    }
    await mark(selected, false);
    const initial = cards.get(selected);
    if (initial) play(initial.ring, [{ time: 0, opacity: 0 }, { time: 0.3, opacity: 0 }, { time: 0.5, opacity: 1, ease: 'outCubic' }]);
    page.update = async () => { if (state.Wallpaper !== selected && !pending.has('Wallpaper')) { selected = state.Wallpaper; await mark(selected); } };
    return page;
  };

  const categoryPage = async key => {
    const page = await newPage(), ok = live(page);
    page.hint = 'Tap a setting to change it';
    const settings = categories[key].settings;
    const listHeight = stageHeight - SPACE.xs - GUTTER - TOUCH - SPACE.s;
    const count = Math.max(1, Math.floor((listHeight + SPACE.s) / (ROW + SPACE.s)));
    const pages = Math.ceil(settings.length / count);
    page.index = Math.min(pageIndex, pages - 1);
    const list = await UI.createElement(win, { layout: { type: 'column', gap: SPACE.s }, item: { size: { x: width, y: listHeight } } });
    await UI.attach(win, page.el, list);
    const switches = {}, values = {};
    for (const setting of settings.slice(page.index * count, (page.index + 1) * count)) {
      if (setting.boolean) {
        let control;
        const flip = async () => {
          if (!ok()) return;
          const next = !(state[setting.key] !== false);
          control.set(next);
          if (!await save(setting.key, next) && page.alive) { control.set(state[setting.key] !== false); shake(target); }
        };
        const target = await row(win, list, width, ROW, flip);
        await UI.setElementId(win, target, 'setting-' + setting.key);
        await label(win, target, setting.title, TYPE.body, width - 16 - 12 - 68 - SPACE.m, ROW);
        control = await toggle(win, target, state[setting.key] !== false, flip);
        switches[setting.key] = control;
        page.items.push(target);
      } else {
        const entry = await navigate(list, setting.title, setting.format(state[setting.key]), ROW, () => {
          if (!ok()) return;
          choice = { ...setting, section: key, page: page.index };
          go('choice', 1);
        });
        await UI.setElementId(win, entry.target, 'setting-' + setting.key);
        values[setting.key] = entry.valueLabel;
        page.items.push(entry.target);
        if (changed === setting.key) page.reveal = async () => {
          // The value just chosen rolls into place in orange, then quiets.
          await UI.setTextColour(win, entry.valueLabel, ORANGE);
          play(entry.valueLabel, [{ time: 0, opacity: 0, position: { x: 0, y: 10 } }, { time: 0.3, opacity: 0, position: { x: 0, y: 10 } },
            { time: 0.55, opacity: 1, position: { x: 0, y: -2 }, ease: 'outCubic' }, { time: 0.7, opacity: 1, position: { x: 0, y: 0 }, ease: 'inOutQuad' }]);
          setTimeout(() => page.alive && UI.setTextColour(win, entry.valueLabel, MUTED).catch(() => {}), 1600);
        };
      }
    }
    changed = undefined;
    // The pager is persistent chrome: only the list turns, the marker reacts.
    if (pages > 1) page.pager = { group: key, count: pages, index: page.index,
      turn: step => { if (ok() && page.index + step >= 0 && page.index + step < pages) go(key, step, page.index + step); } };
    page.update = async () => {
      for (const [settingKey, control] of Object.entries(switches)) if (!pending.has(settingKey)) await control.set(state[settingKey] !== false);
      for (const setting of settings) if (values[setting.key]) await UI.setTextString(win, values[setting.key], setting.format(state[setting.key]));
    };
    return page;
  };

  const choicePage = async () => {
    const page = await newPage(), ok = live(page);
    page.hint = choice.hint || 'Choose a value';
    const values = choice.choices.includes(state[choice.key]) ? choice.choices : [state[choice.key], ...choice.choices];
    const step = CHOICE + SPACE.s;
    const capacity = Math.max(1, Math.floor((stageHeight - SPACE.xs - GUTTER - TOUCH - SPACE.s) / step));
    const pages = Math.ceil(values.length / capacity);
    page.index = Math.min(pageIndex, pages - 1);
    const start = page.index * capacity;
    const visible = values.slice(start, start + capacity);
    if (pages > 1) page.pager = { group: 'choice-' + choice.key, count: pages, index: page.index,
      turn: direction => ok() && go('choice', direction, page.index + direction) };
    // Layout-less frame: a highlight slides between rows beneath the list.
    const frame = await UI.createElement(win, { item: { size: { x: width, y: visible.length * step } } });
    await UI.attach(win, page.el, frame);
    const glow = await UI.createElement(win, {
      renderable: { type: 'box', colour: TONAL, cornerRadius: RADIUS.surface, cornerResolution: 16, origin: { x: 0.5, y: 0.5 },
        aabb: { min: { x: 0, y: 0 }, max: { x: width, y: CHOICE } } },
      item: { size: { x: width, y: CHOICE } }, contentAlign: { x: 'start', y: 'start' }, contentPositioning: 'raw' });
    await UI.attach(win, frame, glow);
    await UI.setHitTarget(win, glow, false);
    const list = await UI.createElement(win, { layout: { type: 'column', gap: SPACE.s }, item: { size: { x: width, y: visible.length * step } } });
    await UI.attach(win, frame, list);
    const rows = [];
    let selected = values.indexOf(state[choice.key]), busy = false;
    const moveGlow = (index, animate = true) => play(glow, animate
      ? [{ time: 0.12, position: { x: 0, y: (index - start) * step }, scale: { x: 1.015, y: 1.08 }, opacity: 1, ease: 'outCubic' },
        { time: 0.28, position: { x: 0, y: (index - start) * step }, scale: { x: 1, y: 1 }, opacity: 1, ease: 'inOutQuad' }]
      : [{ time: 0, position: { x: 0, y: (index - start) * step }, opacity: 1 }]);
    const dot = (entry, on) => play(entry.dot, on
      ? [{ time: 0, scale: { x: 0, y: 0 }, opacity: 1 }, { time: 0.14, scale: { x: 1.35, y: 1.35 }, opacity: 1, ease: 'outCubic' }, { time: 0.28, scale: { x: 1, y: 1 }, opacity: 1, ease: 'inOutQuad' }]
      : [{ time: 0.12, scale: { x: 0, y: 0 }, opacity: 0, ease: 'inQuad' }]);
    const paint = async (index, animate) => {
      for (const [i, entry] of rows.entries()) {
        const on = i + start === index;
        await UI.setTextColour(win, entry.label, on ? ORANGE : CREAM);
        await UI.setCircleColour(win, entry.ring, on ? ORANGE : MUTED);
        if (animate) dot(entry, on); else if (!on) await hidden(entry.dot);
      }
      if (index >= start && index < start + visible.length) moveGlow(index, animate);
      else await hidden(glow);
    };
    const pick = async index => {
      if (!ok() || busy) return;
      const entry = rows[index - start];
      if (index === selected) { punch(entry.target, 1.02); return; }
      busy = true;
      const previous = selected;
      selected = index;
      await paint(index, true);
      punch(entry.target, 1.02);
      if (await save(choice.key, values[index])) {
        // A beat to see the choice land, then back to the list it came from.
        changed = choice.key;
        setTimeout(() => { busy = false; if (page.alive && page === current) go(choice.section, -1, choice.page); }, 420);
      } else {
        busy = false;
        if (!page.alive) return;
        selected = previous;
        await paint(previous, true);
        shake(entry.target);
      }
    };
    for (const [offset, value] of visible.entries()) {
      const index = start + offset;
      const target = await row(win, list, width, CHOICE, () => pick(index), { colour: CLEAR });
      await UI.setElementId(win, target, 'choice-' + value);
      const labelId = await label(win, target, choice.format(value), TYPE.body, width - 16 - 12 - 28 - SPACE.m, CHOICE, CREAM);
      // Radio: a ring with a dot that pops in for the chosen value.
      const radio = await UI.createElement(win, { item: { size: { x: 28, y: CHOICE } } });
      await UI.attach(win, target, radio);
      const ring = await UI.createElement(win, { renderable: { type: 'circle', aabb: { min: { x: 0, y: 0 }, max: { x: 22, y: 22 } }, resolution: 32, inset: 2, colour: MUTED },
        item: { size: { x: 28, y: CHOICE } }, contentAlign: { x: 'center', y: 'center' } });
      await UI.attach(win, radio, ring);
      const dotId = await UI.createElement(win, { renderable: { type: 'circle', aabb: { min: { x: 0, y: 0 }, max: { x: 10, y: 10 } }, resolution: 24, colour: ORANGE, origin: { x: 0.5, y: 0.5 } },
        item: { size: { x: 28, y: CHOICE } }, contentAlign: { x: 'center', y: 'center' } });
      await UI.attach(win, radio, dotId);
      rows.push({ target, label: labelId, ring, dot: dotId });
      page.items.push(target);
    }
    await paint(selected, false);
    if (selected >= start && selected < start + visible.length) play(glow, [{ time: 0, position: { x: 0, y: (selected - start) * step }, opacity: 0 }, { time: 0.25, position: { x: 0, y: (selected - start) * step }, opacity: 0 },
      { time: 0.45, position: { x: 0, y: (selected - start) * step }, opacity: 1, ease: 'outCubic' }]);
    page.update = async () => {
      const index = values.indexOf(state[choice.key]);
      if (!busy && index >= 0 && index !== selected) { selected = index; await paint(index, true); }
    };
    return page;
  };

  // ---- Navigation --------------------------------------------------------
  const titleFor = target => target === 'home' ? 'Settings' : target === 'wallpaper' ? 'Wallpaper' : target === 'choice' ? choice.title : categories[target].title;
  const build = target => target === 'home' ? homePage() : target === 'wallpaper' ? wallpaperPage() : target === 'choice' ? choicePage() : categoryPage(target);

  // Forward pushes in from the right, back from the left; the outgoing page
  // drifts the other way and fades. Rows arrive in a quick stagger.
  const transition = async (target, direction, targetPage = 0, animate = true) => {
    if (closing) return;
    section = target; pageIndex = targetPage;
    const previous = current;
    if (previous && !animate) {
      previous.alive = false;
      await UI.destroyElement(win, previous.el);
    }
    const next = await build(target);
    current = next;
    showBack(target !== 'home');
    setTitle(titleFor(target), direction);
    showHint();
    const travel = size.x * 0.28 * direction;
    if (animate) play(next.el, direction
      ? [{ time: 0, opacity: 0, position: { x: travel, y: 0 } }, { time: 0.3, opacity: allowed() ? 1 : 0.45, position: { x: 0, y: 0 }, ease: 'outCubic' }]
      : [{ time: 0, opacity: 0, position: { x: 0, y: 0 } }, { time: 0.2, opacity: allowed() ? 1 : 0.45, ease: 'outCubic' }]);
    else await play(next.el, [{ time: 0, opacity: allowed() ? 1 : 0.45, position: { x: 0, y: 0 } }]);
    if (animate) {
      next.items.forEach((id, index) => rise(id, 0.05 + index * 0.035));
      next.reveal?.();
    }
    await syncPager(next.pager);
    if (previous && animate) {
      previous.alive = false;
      play(previous.el, [{ time: 0.22, opacity: 0, position: { x: -travel * 0.6, y: 0 }, ease: 'inQuad' }]);
      setTimeout(() => UI.destroyElement(win, previous.el).catch(error => Log.error('Settings page: ' + error)), 260);
    }
  };
  const go = (target, direction, targetPage = 0) => { haptic(); return enqueue(() => transition(target, direction, targetPage)); };
  const back = () => {
    if (section === 'home' || closing) return;
    return go(section === 'choice' ? choice.section : 'home', -1, section === 'choice' ? choice.page : 0);
  };
  // Quit straight away: Hyprland animates closing windows from their last
  // frame. Fading our own content first left only the window's clear colour,
  // which showed as a flat green frame before the window disappeared.
  const close = () => {
    if (closing) return;
    closing = true;
    Engine.quit();
  };

  Event.on('keyDown', event => {
    if (event.id !== win || ![1, 27, 65307].includes(Number(event.key))) return;
    if (section === 'home') close(); else back();
  });

  windowLayout(win, next => enqueue(async () => {
    if (next.x === size.x && next.y === size.y) return;
    await Compositor.setWindowRenderingEnabled(win, false);
    try {
      Object.assign(size, next);
      width = size.x - 2 * GUTTER;
      stageHeight = size.y - SPACE.s - HEADER_HEIGHT - STATUS;
      await Promise.all([
        UI.setLayoutPosition(win, pagerBar, { x: 0, y: size.y - GUTTER - TOUCH }),
        resizeWallpaper(win, wall, { x: size.x, y: size.y + BAR_HEIGHT })
      ]);
      // Rotation is a relayout, so replace the page in the same frame rather
      // than replaying navigation with overlapping old and new pages.
      if (ready && current) await transition(section, 0, current.index || 0, false);
    } finally { await Compositor.setWindowRenderingEnabled(win, true); }
  }));

  await hidden(backButton);
  play(title, [{ time: 0, opacity: 0, position: { x: titleShift(), y: 6 } }, { time: 0.3, opacity: 1, position: { x: titleShift(), y: 0 }, ease: 'outCubic' }]);
  await setStatus(hint());
  await Compositor.setWindowRenderingEnabled(win, true);
  let wasAllowed = false;
  connect('settings', next => {
    state = next;
    configureWallpaper(state);
    const first = !ready;
    ready = true;
    return enqueue(async () => {
      if (first) { await transition('home', 0); return; }
      await current?.update();
      if (allowed() !== wasAllowed && current) play(current.el, [{ time: 0.2, opacity: allowed() ? 1 : 0.45, ease: 'outCubic' }]);
      if (!statusTimer) await showHint();
    }).then(() => { wasAllowed = allowed(); });
  });
  globalThis.koyaSettings = { window: win, settled: () => queue.then(() => new Promise(resolve => setTimeout(resolve, 450))),
    open: value => go(value, 1), save,
    get state() { return state; }, get ready() { return ready; }, get busy() { return pending.size > 0; } };
  return win;
};
