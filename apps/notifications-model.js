// Notification policy and state live in Koya, independently of visible windows.
export class Notifications {
  constructor({ changed = () => {}, signal = () => {}, schedule = setTimeout, cancel = clearTimeout } = {}) {
    this.records = new Map(); this.nextId = 0;
    this.changed = changed; this.signal = signal; this.schedule = schedule; this.cancel = cancel;
  }
  get items() { return [...this.records.values()].reverse(); }
  get unread() { return this.items.filter(item => item.unread).length; }
  allocate() {
    do { this.nextId = (this.nextId + 1) >>> 0; } while (!this.nextId || this.records.has(this.nextId));
    return this.nextId;
  }
  notify(sender, [app, replaces, icon, summary, body, actions, hints, timeout]) {
    hints ||= {};
    const previous = this.records.get(Number(replaces));
    const id = previous?.active && previous.sender === sender ? previous.id : this.allocate();
    if (previous?.id === id) this.cancel(previous.timer);
    const pairs = [];
    for (let i = 0; i + 1 < actions.length && pairs.length < 8; i += 2)
      if (!pairs.some(pair => pair.key === actions[i])) pairs.push({ key: String(actions[i]), label: plain(actions[i + 1], 80) });
    const item = { id, sender, app: plain(app || 'Application', 100), summary: plain(summary, 300), body: plain(body, 4096),
      icon: String(icon || ''), desktop: String(hints['desktop-entry'] || ''), actions: pairs,
      urgency: Math.max(0, Math.min(2, Number(hints.urgency ?? 1))), resident: !!hints.resident,
      transient: !!hints.transient, active: true, unread: true, time: Date.now(), revision: (previous?.revision || 0) + 1 };
    // The phone keeps ordinary notifications until dismissed. Explicit client
    // expiry is honoured; expired cards remain as passive, action-free history.
    const duration = Number(timeout) < 0 ? (item.transient ? 5000 : 0) : Number(timeout);
    if (duration > 0) item.timer = this.schedule(() => this.close(id, 1, !item.transient), Math.min(duration, 2147483647));
    this.records.delete(id); this.records.set(id, item);
    while (this.records.size > 100) this.close(this.records.keys().next().value, 2, false, false);
    this.changed({ type: 'notify', item });
    return id;
  }
  close(id, reason = 2, retain = false, notify = true) {
    const item = this.records.get(Number(id));
    if (!item) return false;
    this.cancel(item.timer); item.timer = undefined;
    if (item.active) {
      item.active = false;
      this.signal(item.sender, 'NotificationClosed', item.id, '', reason);
    }
    if (retain) item.actions = [];
    else this.records.delete(item.id);
    if (notify) this.changed({ type: 'close', item });
    return true;
  }
  invoke(id, key) {
    const item = this.records.get(Number(id));
    if (!item?.active || !item.actions.some(action => action.key === key)) return false;
    this.signal(item.sender, 'ActionInvoked', item.id, key, 0);
    item.unread = false;
    if (!item.resident) this.close(item.id, 2);
    else this.changed({ type: 'read', item });
    return true;
  }
  read() { for (const item of this.records.values()) item.unread = false; this.changed({ type: 'read' }); }
  clear() { for (const id of [...this.records.keys()]) this.close(id, 2, false, false); this.changed({ type: 'clear' }); }
  dispose() { for (const item of this.records.values()) this.cancel(item.timer); }
  request(sender, method, args) {
    if (method === 'Notify') return { Result: { _t: 'u', _v: this.notify(sender, args) } };
    if (method === 'CloseNotification') {
      if (!this.records.get(Number(args[0]))?.active || !this.close(args[0], 3)) throw new Error('Unknown notification');
      return {};
    }
    if (method === 'GetCapabilities') return { Result: { _t: 'as', _v: ['body', 'actions', 'persistence'] } };
    if (method === 'GetServerInformation') return { Result: { _t: 'as', _v: ['Koya', 'Koya', '0.1.0', '1.3'] } };
    throw new Error('Unknown notification method');
  }
}

export function plain(value, limit = 4096) {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(value || '').replace(/<[^>]*>/g, '').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, key) => {
    if (key[0] !== '#') return entities[key.toLowerCase()];
    const number = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
    return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : '';
  }).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, limit);
}
