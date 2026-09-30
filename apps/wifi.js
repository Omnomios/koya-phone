import * as UI from 'Helix/UserInterface';
import * as Compositor from 'Koya/Compositor';
import * as Event from 'Helix/Event';
import * as Log from 'Helix/Log';
import { appFrame } from './app-frame.js';
import { wifiNetwork } from './wifi-network.js';
import { keyboardVisible } from './session-keyboard.js';
import { icon, text, label, pill, toggle } from './touch-ui.js';
import { clips } from './motion.js';
import { FONT, CREAM, ORANGE, INK, CARD, MUTED, GUTTER, SPACE, RADIUS, TYPE, TOUCH } from './theme.js';

const ROW = 72, SLOT = 24;
const idOf = network => network.path.split('/').pop();
const bars = network => Math.max(0, Math.min(3, Math.ceil(Number(network.Strength) * 3 / 100)));
const signal = network => '/rom/assets/status/wifi-' + bars(network) + '.png';
const quality = strength => strength >= 75 ? 'Excellent' : strength >= 50 ? 'Good' : strength >= 25 ? 'Fair' : 'Weak';
const securityName = kind => ({ open: 'None', 'wpa-psk': 'WPA/WPA2 Personal', sae: 'WPA3 Personal', owe: 'Enhanced Open',
  wep: 'WEP', enterprise: 'Enterprise' })[kind] || kind;
const statusOf = network => network.connected ? 'Connected' : network.saved ? 'Saved' : network.security === 'open' ? 'Open'
  : network.security === 'owe' ? 'Encrypted' : !network.supported ? 'Needs setup on another device' : 'Password required';

export default async (options = {}) => {
  let latest = { networks: [], loading: true }, form, detail, password = '', preedit = '', reveal = false, focused = false, submitted = false;
  let field, entry, focusRing, caret, caretBlink, caretRunning = false, manualKeyboard = false, listPage = 0, connectFeedback;
  let backend;
  const frame = await appFrame({ title: 'Wi-Fi', appId: 'org.koya.Wifi', name: 'Wi-Fi',
    hint: () => latest.loading ? 'Finding networks…' : latest.working && latest.message ? latest.message
      : latest.hardware === false ? 'Wi-Fi is blocked by the device' : latest.enabled === false && !form && !detail ? 'Wi-Fi is off' : '',
    onBack: () => back(),
    onClose: () => { backend?.dispose(); keyboard(false); } });
  const { win, play, hidden, punch, shake, flash, host } = frame;

  // ---- Password field (text input, caret and on-screen keyboard) --------
  const keyboard = async (visible, newFocus = false, changeCause = 'other') => {
    if (options.keyboard === false) return;
    try {
      const supported = await Compositor.setTextInput(win, visible ? {
        enabled: true, newFocus, inputId: field, cursorElement: field, changeCause,
        contentPurpose: 8, contentHint: 64 | 128
        // Passwords stay local: never provide surroundingText to input methods.
      } : { enabled: false });
      if (visible && !supported) { manualKeyboard = true; await keyboardVisible(true); }
      else if (!visible && manualKeyboard) { manualKeyboard = false; await keyboardVisible(false); }
    } catch (error) { Log.error('Wi-Fi text input: ' + error); }
  };
  const updateField = async (changeCause = 'other') => {
    if (!field) return;
    const value = password + preedit;
    const display = value ? reveal ? value : '•'.repeat(Array.from(value).length) : focused ? '' : 'Password';
    await UI.setTextString(win, field, display);
    await UI.setTextColour(win, field, value || focused ? CREAM : MUTED);
    await UI.setEnabled(win, focusRing, focused);
    const position = await UI.getTextCaretPosition(win, field, focused ? Array.from(display).length : 0);
    const x = Number(position?.x || 0), scroll = Math.max(0, x - (frame.width - 36));
    await UI.setPosition(win, field, { x: -scroll, y: 0 });
    await UI.setPosition(win, caret, { x: x - scroll, y: 0 });
    const blinking = focused && !!form && !latest.working;
    await UI.setEnabled(win, caret, blinking);
    if (blinking !== caretRunning) {
      caretRunning = blinking;
      if (blinking) await caretBlink.play('blink');
      else await UI.stopAnimation(win, caret);
    }
    // Editable state is sent without waiting on a fallback D-Bus keyboard call.
    keyboard(blinking, false, changeCause);
  };
  const focusField = async () => {
    if (!form || latest.working) return;
    const newFocus = !focused;
    focused = true;
    await updateField();
    if (newFocus) { keyboard(true, true); punch(entry, 1.02); }
  };
  const submit = async () => {
    if (!form || latest.working) return;
    const network = form, secret = password;
    submitted = true; focused = false;
    await frame.enqueue(updateField);
    connectFeedback?.begin().catch(() => {});
    const accepted = await backend.connect(network, secret);
    if (form !== network) return;
    if (!accepted) {
      connectFeedback?.end().catch(() => {});
      await frame.enqueue(updateField);
      if (latest.error) { flash(latest.error, ORANGE, 4000); shake(entry); }
    }
  };

  // ---- Pages -------------------------------------------------------------
  const listPageBuild = async () => {
    const page = await frame.newPage(), ok = frame.live(page);
    page.hint = 'Tap a network to connect';
    // Wide screens: the switch and scan controls on the left, the list on the
    // right with the full height. Portrait stacks them in the page column.
    const wide = frame.size.x > frame.size.y;
    const width = wide ? (frame.width - SPACE.l) / 2 : frame.width;
    let controls = page.el, listParent = page.el;
    if (wide) {
      const columns = await UI.createElement(win, { layout: { type: 'row', gap: SPACE.l }, item: { size: { x: frame.width, y: frame.stageHeight - SPACE.xs - GUTTER } } });
      await UI.attach(win, page.el, columns);
      controls = await UI.createElement(win, { layout: { type: 'column', gap: SPACE.s }, item: { size: { x: width, y: frame.stageHeight - SPACE.xs - GUTTER } } });
      listParent = await UI.createElement(win, { layout: { type: 'column', gap: SPACE.s }, item: { size: { x: width, y: frame.stageHeight - SPACE.xs - GUTTER } } });
      await UI.attach(win, columns, controls);
      await UI.attach(win, columns, listParent);
    }
    // Master switch: the same row anatomy as a Settings toggle.
    let power;
    const flipPower = () => {
      if (!ok() || latest.working || latest.hardware === false) { shake(powerRow.target); return; }
      power.set(!latest.enabled);
      backend.toggle();
    };
    const powerRow = await frame.navigate(controls, 'Wi-Fi', '', ROW, flipPower, { width, trailing: 68,
      trailingBuild: async target => { power = await toggle(win, target, !!latest.enabled, flipPower); await UI.setElementId(win, power.id, 'wifi-power'); return power; } });
    page.items.push(powerRow.target);
    let refresh, scanning;
    const heading = await frame.section(controls, 'Available networks', 112, async line => {
      refresh = await pill(win, line, 'Refresh', 112, () => {
        if (!ok() || !latest.enabled || latest.scanning || latest.working) { if (refresh) punch(refresh, 1.03); return; }
        backend.scan();
      }, { labelColour: ORANGE, height: 36, onFeedback: value => { scanning = value; } });
      await UI.setElementId(win, refresh, 'wifi-refresh');
      return refresh;
    }, width);
    page.items.push(heading.line);
    // Power row, section line and the pager's reserved strip are fixed.
    const listHeight = frame.stageHeight - SPACE.xs - GUTTER - TOUCH - SPACE.s - (wide ? 0 : ROW + 40 + 2 * SPACE.s);
    const count = Math.max(1, Math.floor((listHeight + SPACE.s) / (ROW + SPACE.s)));
    const box = await UI.createElement(win, host({ layout: { type: 'column', gap: SPACE.s }, item: { size: { x: width, y: listHeight } } }));
    await UI.attach(win, listParent, box);
    let shape, rows = new Map(), wasScanning = false;
    const powerText = () => latest.hardware === false ? 'Blocked by the device' : !latest.enabled ? 'Off'
      : latest.networks.find(item => item.connected) ? 'Connected to ' + latest.networks.find(item => item.connected).name : 'On · not connected';
    // Rows rebuild only when the list's shape changes; signal, captions and
    // the switch otherwise update in place, so the list never flickers.
    const buildRows = async animate => {
      const pages = Math.max(1, Math.ceil(latest.networks.length / count));
      listPage = Math.min(listPage, pages - 1);
      const visible = latest.enabled ? latest.networks.slice(listPage * count, (listPage + 1) * count) : [];
      for (const child of rows.values()) await UI.destroyElement(win, child.target);
      if (rows.empty) await UI.destroyElement(win, rows.empty);
      rows = new Map();
      if (!visible.length) {
        rows.empty = await text(win, box, latest.loading ? '' : latest.enabled ? 'No networks found' : 'Turn Wi-Fi on to find networks', TYPE.body, width, 120, MUTED);
      }
      for (const [index, network] of visible.entries()) {
        let rowIcon;
        const trailing = await frame.navigate(box, network.name, statusOf(network), ROW, () => select(network), {
          width, lead: 36 + 12, trailing: 2 * SLOT, valueColour: network.connected ? ORANGE : MUTED,
          leading: async target => { rowIcon = await icon(win, target, signal(network), 26, 36, ROW); },
          trailingBuild: async target => {
            // Every row ends in the same two slots: lock, then chevron. Locks
            // line up whether or not a network has details to open.
            const slots = await UI.createElement(win, { layout: { type: 'row', alignItems: 'center' }, item: { size: { x: 2 * SLOT, y: ROW } } });
            await UI.attach(win, target, slots);
            const lock = await UI.createElement(win, { item: { size: { x: SLOT, y: ROW } } });
            await UI.attach(win, slots, lock);
            if (network.security !== 'open') await icon(win, lock, '/rom/assets/power-menu/lock.png', 16, SLOT, ROW);
            return network.connected || network.saved ? frame.chevron(slots, ROW) : undefined;
          } });
        await UI.setElementId(win, trailing.target, 'wifi-network-' + idOf(network));
        rows.set(network.key, { target: trailing.target, caption: trailing.valueLabel, icon: rowIcon, network });
        if (animate) frame.rise(trailing.target, 0.03 + index * 0.03);
        else page.items.push(trailing.target);
      }
      page.pager = pages > 1 ? { group: 'wifi', count: pages, index: listPage,
        turn: step => { if (ok() && listPage + step >= 0 && listPage + step < pages) { listPage += step; frame.go(listPageBuild, { title: 'Wi-Fi', direction: step }); } } } : undefined;
      // A rebuild in place can change the page count; the marker follows.
      if (animate) await frame.syncPager(page.pager);
      shape = shapeOf();
    };
    const shapeOf = () => JSON.stringify([latest.enabled, latest.loading, listPage, latest.networks.map(item => [item.key, item.connected, !!item.saved])]);
    await buildRows(false);
    page.update = async () => {
      if (!page.alive) return;
      await UI.setTextString(win, powerRow.valueLabel, powerText());
      await UI.setTextColour(win, powerRow.valueLabel, latest.networks.some(item => item.connected) && latest.enabled ? ORANGE : MUTED);
      if (!latest.working) await power.set(!!latest.enabled);
      await UI.setTextString(win, heading.caption, latest.scanning ? 'Scanning for networks…' : 'Available networks');
      if (latest.scanning !== wasScanning) {
        wasScanning = latest.scanning;
        latest.scanning ? scanning?.begin().catch(() => {}) : scanning?.end().catch(() => {});
      }
      if (shapeOf() !== shape) {
        await buildRows(true);
        return;
      }
      for (const entryRow of rows.values()) {
        const network = latest.networks.find(item => item.key === entryRow.network.key) || entryRow.network;
        entryRow.network = network;
        await UI.setTextString(win, entryRow.caption, latest.working && latest.message?.includes(network.name) ? 'Connecting…' : statusOf(network));
        await UI.setTexture(win, entryRow.icon, signal(network));
      }
    };
    await UI.setTextString(win, powerRow.valueLabel, powerText());
    await UI.setTextColour(win, powerRow.valueLabel, latest.networks.some(item => item.connected) && latest.enabled ? ORANGE : MUTED);
    page.dispose = () => scanning?.end().catch(() => {});
    return page;
  };

  const detailPageBuild = async () => {
    const page = await frame.newPage(SPACE.m), ok = frame.live(page), width = frame.width;
    const network = () => latest.networks.find(item => item.key === detail.key) || detail;
    page.hint = network().connected ? 'Connected' : 'Saved network';
    // Facts first, in one quiet card; actions below it.
    const card = await UI.createElement(win, { renderable: { type: 'box', colour: CARD, cornerRadius: RADIUS.surface, cornerResolution: 16 },
      layout: { type: 'column', padding: { l: 16, r: 16, t: SPACE.xs, b: SPACE.xs } }, item: { size: { x: width, y: 3 * 48 + 2 * SPACE.xs } }, contentAlign: 'fill' });
    await UI.attach(win, page.el, card);
    const facts = {};
    for (const key of ['Status', 'Signal', 'Security']) {
      const line = await UI.createElement(win, { layout: { type: 'row', alignItems: 'center' }, item: { size: { x: width - 32, y: 48 } } });
      await UI.attach(win, card, line);
      await label(win, line, key, TYPE.body, (width - 32) / 2, 48, MUTED);
      facts[key] = await text(win, line, '', TYPE.body, (width - 32) / 2, 48, CREAM, undefined, 'right');
    }
    page.items.push(card);
    const paint = async () => {
      const current = network();
      await UI.setTextString(win, facts.Status, current.connected ? 'Connected' : latest.working ? 'Connecting…' : 'Not connected');
      await UI.setTextColour(win, facts.Status, current.connected ? ORANGE : CREAM);
      await UI.setTextString(win, facts.Signal, quality(Number(current.Strength)) + ' · ' + Number(current.Strength) + '%');
      await UI.setTextString(win, facts.Security, securityName(current.security));
    };
    await paint();
    const actions = await UI.createElement(win, host({ layout: { type: 'column', gap: SPACE.s }, item: { size: { x: width, y: 56 + TOUCH + SPACE.s } } }));
    await UI.attach(win, page.el, actions);
    let primaryFeedback, connected = network().connected;
    const primary = async () => {
      if (!ok() || latest.working) return;
      primaryFeedback?.begin().catch(() => {});
      if (network().connected) await backend.disconnect();
      else if (!await backend.connect(network()) && network().password) { primaryFeedback?.end().catch(() => {}); openForm(network()); return; }
      primaryFeedback?.end().catch(() => {});
      if (latest.error) { flash(latest.error, ORANGE, 4000); shake(actions); }
    };
    const primaryButton = await pill(win, actions, connected ? 'Disconnect' : 'Connect', width, primary,
      connected ? { height: 56, labelColour: ORANGE, size: TYPE.body + 1 } : { colour: ORANGE, labelColour: INK, height: 56, size: TYPE.body + 1,
        onFeedback: value => { primaryFeedback = value; } });
    if (connected) await UI.setElementId(win, primaryButton, 'wifi-disconnect-' + idOf(detail));
    const forget = await pill(win, actions, 'Forget network', width, async () => {
      if (!ok() || latest.working) return;
      const name = network().name;
      await backend.forget(network());
      if (latest.error) { flash(latest.error, ORANGE, 4000); shake(actions); return; }
      detail = undefined;
      frame.go(listPageBuild, { title: 'Wi-Fi', direction: -1 });
      setTimeout(() => flash('Forgot ' + name, ORANGE), 320);
    });
    await UI.setElementId(win, forget, 'wifi-forget-' + idOf(detail));
    page.items.push(actions);
    page.update = async () => {
      if (!page.alive) return;
      await paint();
      // The primary action changes meaning with the connection: rebuild it.
      if (network().connected !== connected) frame.go(detailPageBuild, { title: network().name, back: true });
    };
    return page;
  };

  const formPageBuild = async () => {
    const page = await frame.newPage(SPACE.m), width = frame.width;
    page.hint = 'Enter the password for ' + form.name;
    entry = await UI.createElement(win, {
      renderable: { type: 'box', colour: CARD, cornerRadius: RADIUS.control, cornerResolution: 16, origin: { x: 0.5, y: 0.5 } },
      item: { size: { x: width, y: 72 } }, contentAlign: 'fill', inheritAnimation: true,
      onMouseDown: () => frame.enqueue(focusField)
    });
    await UI.attach(win, page.el, entry); await UI.setElementId(win, entry, 'wifi-password');
    focusRing = await UI.createElement(win, {
      renderable: { type: 'box', colour: ORANGE, inset: 2, cornerRadius: RADIUS.control, cornerResolution: 16,
        aabb: { min: { x: 0, y: 0 }, max: { x: width, y: 72 } } },
      item: { size: { x: width, y: 72 } }, contentAlign: 'fill'
    });
    await UI.attach(win, entry, focusRing); await UI.setEnabled(win, focusRing, false);
    const viewport = await UI.createElement(win, { clipToBounds: true,
      item: { size: { x: width - 32, y: 72 }, margin: { l: 16, r: 16, t: 0, b: 0 } } });
    await UI.attach(win, entry, viewport);
    field = await UI.createElement(win, {
      // Line metrics keep the baseline and left edge fixed as characters are
      // typed; ink bounds would re-centre on every glyph's ascent and descent.
      renderable: { type: 'text', string: 'Password', size: 22, font: FONT, colour: MUTED, justify: 'left', vAlign: 'center', metricsBasis: 'line' },
      item: { size: { x: width - 32, y: 72 } }, contentAlign: { x: 'start', y: 'center' }, contentPositioning: 'raw'
    });
    await UI.attach(win, viewport, field);
    caret = await UI.createElement(win, {
      renderable: { type: 'box', colour: ORANGE, aabb: { min: { x: 0, y: 0 }, max: { x: 2, y: 28 } } },
      item: { size: { x: 2, y: 72 } }, contentAlign: { x: 'start', y: 'center' }, contentPositioning: 'raw'
    });
    await UI.attach(win, viewport, caret); await UI.setEnabled(win, caret, false);
    caretRunning = false;
    caretBlink = await clips(win, caret, { blink: [
      { time: 0, opacity: 1 }, { time: 0.45, opacity: 0, ease: 'inOutQuad' },
      { time: 0.9, opacity: 1, ease: 'inOutQuad', looping: true }
    ] });
    page.items.push(entry);
    const helpers = await UI.createElement(win, host({ layout: { type: 'row', gap: SPACE.s }, item: { size: { x: width, y: TOUCH } } }));
    await UI.attach(win, page.el, helpers);
    await pill(win, helpers, 'Paste', 96, async () => {
      if (latest.working) return;
      try { password = (await Compositor.getClipboardText()).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 512); preedit = ''; await frame.enqueue(updateField); punch(entry, 1.02); }
      catch (_) { flash('Clipboard unavailable', ORANGE); shake(entry); }
    });
    let revealLabel;
    await pill(win, helpers, reveal ? 'Hide' : 'Show', 96, async () => {
      reveal = !reveal;
      if (revealLabel) await UI.setTextString(win, revealLabel, reveal ? 'Hide' : 'Show');
      return frame.enqueue(updateField);
    }, { onLabel: id => { revealLabel = id; } });
    page.items.push(helpers);
    // The one primary action on screen: filled, full width, thumb height.
    const connectButton = await pill(win, page.el, 'Connect', width, submit, { colour: ORANGE, labelColour: INK, height: 56, size: TYPE.body + 1,
      onFeedback: value => { connectFeedback = value; } });
    page.items.push(connectButton);
    page.update = async () => {
      if (!page.alive) return;
      if (submitted && !latest.working) connectFeedback?.end().catch(() => {});
      await updateField();
    };
    page.dispose = () => { connectFeedback = undefined; };
    await updateField();
    return page;
  };

  // ---- Navigation --------------------------------------------------------
  const openForm = async (network, restore) => {
    if (latest.working && !restore) return;
    detail = undefined;
    form = network; password = ''; preedit = ''; reveal = false; focused = false; submitted = false;
    await frame.go(formPageBuild, { title: network.name, direction: 1, back: true });
  };
  const closeForm = async () => {
    if (!form) return;
    form = undefined; password = ''; preedit = ''; focused = false; submitted = false;
    keyboard(false);
    if (caret) await UI.stopAnimation(win, caret).catch(() => {});
    caretRunning = false; field = entry = focusRing = caret = caretBlink = undefined;
    backend.clearError();
    await frame.go(listPageBuild, { title: 'Wi-Fi', direction: -1 });
  };
  const openDetail = network => { detail = network; return frame.go(detailPageBuild, { title: network.name, direction: 1, back: true }); };
  const back = () => {
    if (form) return closeForm();
    if (detail) { detail = undefined; return frame.go(listPageBuild, { title: 'Wi-Fi', direction: -1 }); }
  };
  const select = async network => {
    if (latest.working) { flash('Busy — wait for the current change to finish'); return; }
    if (!network.supported) { flash('This network needs setup on another device', ORANGE); return; }
    if (network.connected || network.saved) { openDetail(network); return; }
    if (network.password) { openForm(network); return; }
    if (!await backend.connect(network) && latest.error) flash(latest.error, ORANGE, 4000);
  };

  // ---- Backend reactions -------------------------------------------------
  let previous = latest;
  backend = wifiNetwork(value => {
    const before = previous;
    latest = value; previous = value;
    frame.enqueue(async () => {
      await frame.current?.update();
      if (value.error && value.error !== before.error) {
        flash(value.error, ORANGE, 4000);
        if (form && entry) shake(entry);
      }
      else frame.refreshHint();
      // A connection that lands while its password sheet is open returns to
      // the list with the news, rather than leaving the sheet behind.
      const joined = value.networks.find(item => item.connected);
      if (joined && !before.networks.find(item => item.connected && item.key === joined.key)) {
        if (form && form.key === joined.key) {
          form = undefined; password = ''; preedit = ''; focused = false; submitted = false; keyboard(false);
          field = entry = focusRing = caret = caretBlink = undefined;
          frame.go(listPageBuild, { title: 'Wi-Fi', direction: -1 });
        }
        setTimeout(() => flash('Connected to ' + joined.name, ORANGE), 320);
      }
    });
  });

  // ---- Text input --------------------------------------------------------
  const insert = value => {
    if (!focused || !form || latest.working) return;
    preedit = ''; password = (password + value.replace(/[\x00-\x1f\x7f]/g, '')).slice(0, 512); frame.enqueue(updateField);
  };
  Event.on('textInput', event => { if (event.id === win) insert(event.text); });
  Event.on('textRepeat', event => { if (event.id === win) insert(event.text); });
  Event.on('textInputMethod', event => {
    if (event.id !== win || event.inputId !== field || !focused || !form || latest.working) return;
    // This field keeps its cursor at the end. IME deletion lengths are UTF-8
    // bytes, not JavaScript string indices; commit and deletion form one edit.
    const characters = Array.from(password);
    let remaining = Number(event.beforeLength || 0);
    while (remaining > 0 && characters.length) {
      const point = characters.pop().codePointAt(0);
      remaining -= point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    }
    password = (characters.join('') + (event.text || '').replace(/[\x00-\x1f\x7f]/g, '')).slice(0, 512);
    preedit = (event.preedit || '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 512);
    frame.enqueue(() => updateField('input_method'));
  });
  const keyDown = event => {
    if (event.id !== win || !focused || !form || latest.working) return;
    if ([14, 65288].includes(event.key)) { preedit = ''; password = Array.from(password).slice(0, -1).join(''); frame.enqueue(updateField); }
    if ([28, 96, 65293].includes(event.key)) submit();
  };
  Event.on('keyDown', keyDown); Event.on('keyRepeat', event => { if ([14, 65288].includes(event.key)) keyDown(event); });

  await frame.show(listPageBuild, { title: 'Wi-Fi' });
  // Native promises need the running engine event loop.
  setTimeout(() => backend.start().catch(() => { latest = { ...latest, loading: false, error: 'NetworkManager is unavailable' }; frame.enqueue(() => frame.current?.update()); }), 0);
  globalThis.koyaWifi = { backend, select, openForm, closeForm, get window() { return win; }, get password() { return password; },
    setPassword: value => { password = value; return frame.enqueue(updateField); }, submit };
  return win;
};
