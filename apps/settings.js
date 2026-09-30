import * as UI from 'Helix/UserInterface';
import * as Log from 'Helix/Log';
import { connect, call } from './session.js';
import { WALLPAPERS, wallpaperFor, wallpaperFrame } from './wallpapers.js';
import { configureWallpaper, wallpaperSurface } from './wallpaper-surface.js';
import { appFrame } from './app-frame.js';
import { button, label, text, row, toggle } from './touch-ui.js';
import { CREAM, ORANGE, CARD, TONAL, MUTED, CLEAR, alpha, GUTTER, SPACE, RADIUS, TYPE, TOUCH } from './theme.js';

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
const ROW = 72, CHOICE = 60;

export default async () => {
  let state = {}, ready = false, section = 'home', pageIndex = 0, choice, changed;
  const pending = new Set();
  const allowed = () => ready && state.Active && state.ScreenState === 'unlocked';
  const frame = await appFrame({ title: 'Settings', appId: 'org.koya.Settings',
    hint: () => !ready ? 'Connecting to the shell…' : !allowed() ? 'Unlock the phone to change settings' : '',
    onBack: () => back() });
  const { win, play, hidden, punch, shake, rise, host, flash, wall } = frame;
  // Page geometry follows the window, including after a rotation.
  const metric = { get width() { return frame.width; }, get stageHeight() { return frame.stageHeight; } };
  const live = page => { const alive = frame.live(page); return () => alive() && allowed(); };

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

  // ---- Pages -------------------------------------------------------------
  const homePage = async () => {
    const page = await frame.newPage(), ok = live(page);
    page.hint = 'Choose a wallpaper or adjust how the phone behaves';
    const wallpaper = wallpaperFor(state.Wallpaper);
    let name;
    const hero = await frame.navigate(page.el, 'Wallpaper', wallpaper.name, frame.size.x > frame.size.y ? 112 : 136, () => ok() && go('wallpaper', 1), {
      headingSize: TYPE.heading, lead: 52 + 12,
      leading: async target => {
        // Framed live thumbnail: it follows the wallpaper as it changes.
        const thumb = await UI.createElement(win, { renderable: { type: 'box', colour: alpha(CREAM, 0.16), cornerRadius: RADIUS.control, cornerResolution: 16 },
          layout: { type: 'column', padding: { l: 2, r: 2, t: 2, b: 2 } }, item: { size: { x: 52, y: 108 } }, contentAlign: 'fill' });
        await UI.attach(win, target, thumb);
        await UI.attach(win, thumb, await wallpaperSurface(win, { x: 48, y: 104 }));
      }
    });
    name = hero.valueLabel;
    await UI.setElementId(win, hero.target, 'settings-wallpaper');
    page.items.push(hero.target);
    const summaries = {};
    for (const [key, category] of Object.entries(categories)) {
      const entry = await frame.navigate(page.el, category.title, category.summary(state), ROW + 4, () => ok() && go(key, 1));
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
    const page = await frame.newPage(), ok = live(page);
    page.hint = 'Tap a wallpaper to apply it';
    const gap = SPACE.m, columns = frame.size.x > frame.size.y ? WALLPAPERS.length : 2;
    const rows = Math.ceil(WALLPAPERS.length / columns);
    const cardWidth = (metric.width - gap * (columns - 1)) / columns;
    const cardHeight = Math.min(320, (metric.stageHeight - SPACE.xs - GUTTER - gap * (rows - 1)) / rows);
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
      const line = await UI.createElement(win, { layout: { type: 'row', gap }, item: { size: { x: metric.width, y: cardHeight } } });
      await UI.attach(win, page.el, line);
      for (const wallpaper of WALLPAPERS.slice(i, i + columns)) {
        // Layout-less frame: the card and its selection ring share its bounds.
        const cardFrame = await UI.createElement(win, host({ item: { size: { x: cardWidth, y: cardHeight } } }));
        await UI.attach(win, line, cardFrame);
        const target = await button(win, cardFrame, '', cardWidth, cardHeight, () => pick(wallpaper), { colour: CARD, radius: RADIUS.surface, gap: 0 });
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
        await UI.attach(win, cardFrame, ring);
        await UI.setHitTarget(win, ring, false);
        await hidden(ring);
        cards.set(wallpaper.id, { frame: cardFrame, ring, caption, on: false });
        page.items.push(cardFrame);
      }
    }
    await mark(selected, false);
    const initial = cards.get(selected);
    if (initial) play(initial.ring, [{ time: 0, opacity: 0 }, { time: 0.3, opacity: 0 }, { time: 0.5, opacity: 1, ease: 'outCubic' }]);
    page.update = async () => { if (state.Wallpaper !== selected && !pending.has('Wallpaper')) { selected = state.Wallpaper; await mark(selected); } };
    return page;
  };

  const categoryPage = async key => {
    const page = await frame.newPage(), ok = live(page);
    page.hint = 'Tap a setting to change it';
    const settings = categories[key].settings;
    const listHeight = metric.stageHeight - SPACE.xs - GUTTER - TOUCH - SPACE.s;
    const count = Math.max(1, Math.floor((listHeight + SPACE.s) / (ROW + SPACE.s)));
    const pages = Math.ceil(settings.length / count);
    page.index = Math.min(pageIndex, pages - 1);
    const list = await UI.createElement(win, { layout: { type: 'column', gap: SPACE.s }, item: { size: { x: metric.width, y: listHeight } } });
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
        const target = await row(win, list, metric.width, ROW, flip);
        await UI.setElementId(win, target, 'setting-' + setting.key);
        await label(win, target, setting.title, TYPE.body, metric.width - 16 - 12 - 68 - SPACE.m, ROW);
        control = await toggle(win, target, state[setting.key] !== false, flip);
        switches[setting.key] = control;
        page.items.push(target);
      } else {
        const entry = await frame.navigate(list, setting.title, setting.format(state[setting.key]), ROW, () => {
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
    const page = await frame.newPage(), ok = live(page);
    page.hint = choice.hint || 'Choose a value';
    const values = choice.choices.includes(state[choice.key]) ? choice.choices : [state[choice.key], ...choice.choices];
    const step = CHOICE + SPACE.s;
    const capacity = Math.max(1, Math.floor((metric.stageHeight - SPACE.xs - GUTTER - TOUCH - SPACE.s) / step));
    const pages = Math.ceil(values.length / capacity);
    page.index = Math.min(pageIndex, pages - 1);
    const start = page.index * capacity;
    const visible = values.slice(start, start + capacity);
    if (pages > 1) page.pager = { group: 'choice-' + choice.key, count: pages, index: page.index,
      turn: direction => ok() && go('choice', direction, page.index + direction) };
    // Layout-less frame: a highlight slides between rows beneath the list.
    const listFrame = await UI.createElement(win, { item: { size: { x: metric.width, y: visible.length * step } } });
    await UI.attach(win, page.el, listFrame);
    const glow = await UI.createElement(win, {
      renderable: { type: 'box', colour: TONAL, cornerRadius: RADIUS.surface, cornerResolution: 16, origin: { x: 0.5, y: 0.5 },
        aabb: { min: { x: 0, y: 0 }, max: { x: metric.width, y: CHOICE } } },
      item: { size: { x: metric.width, y: CHOICE } }, contentAlign: { x: 'start', y: 'start' }, contentPositioning: 'raw' });
    await UI.attach(win, listFrame, glow);
    await UI.setHitTarget(win, glow, false);
    const list = await UI.createElement(win, { layout: { type: 'column', gap: SPACE.s }, item: { size: { x: metric.width, y: visible.length * step } } });
    await UI.attach(win, listFrame, list);
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
      const target = await row(win, list, metric.width, CHOICE, () => pick(index), { colour: CLEAR });
      await UI.setElementId(win, target, 'choice-' + value);
      const labelId = await label(win, target, choice.format(value), TYPE.body, metric.width - 16 - 12 - 28 - SPACE.m, CHOICE, CREAM);
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
  const go = (target, direction, targetPage = 0) => {
    section = target; pageIndex = targetPage;
    return frame.go(() => build(target), { title: titleFor(target), direction, back: target !== 'home', dim: !allowed() });
  };
  const back = () => {
    if (section === 'home' || frame.closing) return;
    return go(section === 'choice' ? choice.section : 'home', -1, section === 'choice' ? choice.page : 0);
  };

  let wasAllowed = false;
  connect('settings', next => {
    state = next;
    configureWallpaper(state);
    const first = !ready;
    ready = true;
    return frame.enqueue(async () => {
      if (first) { await frame.show(() => build('home'), { title: 'Settings', dim: !allowed() }); return; }
      await frame.current?.update();
      if (allowed() !== wasAllowed) frame.setDim(!allowed());
      await frame.refreshHint();
    }).then(() => { wasAllowed = allowed(); });
  });
  globalThis.koyaSettings = { window: win, settled: () => frame.settled.then(() => new Promise(resolve => setTimeout(resolve, 450))),
    open: value => go(value, 1), save,
    get state() { return state; }, get ready() { return ready; }, get busy() { return pending.size > 0; } };
  return win;
};
