const NAME = 'sm.puri.OSK0', PATH = '/sm/puri/OSK0';
export function createKeyboard(bus, changed) {
  let available = false, visible = false, pending = false, target, sent, owner = '', generation = 0, revision = 0, error = '';
  const publish = () => changed({ KeyboardAvailable: available, KeyboardVisible: visible, KeyboardPending: pending, KeyboardError: error });
  const read = async () => {
    const token = ++revision, epoch = generation;
    try {
      const name = await bus.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'GetNameOwner', 's', NAME);
      const properties = await bus.call(NAME, PATH, 'org.freedesktop.DBus.Properties', 'GetAll', 's', NAME);
      if (token !== revision || epoch !== generation) return;
      owner = name; available = true; visible = properties.Visible === true;
    } catch (_) { if (token !== revision || epoch !== generation) return; owner = ''; available = visible = false; target = undefined; }
    publish(); pump();
  };
  const pump = async () => {
    if (!available || pending || target === undefined) return;
    sent = target; target = undefined; pending = true; error = ''; const token = generation; publish();
    try { await bus.call(NAME, PATH, NAME, 'SetVisible', 'b', sent); }
    catch (failure) { if (token === generation) error = String(failure); }
    finally { if (token === generation) { pending = false; publish(); pump(); } }
  };
  const setVisible = value => {
    value = !!value;
    if (!available || target === value || (pending && sent === value && target === undefined) || (!pending && visible === value)) return;
    target = value; pump();
  };
  const signal = event => {
    if (event.interface === 'org.freedesktop.DBus' && event.member === 'NameOwnerChanged' && event.args[0] === NAME) {
      ++generation; pending = false; owner = event.args[2]; available = !!owner; visible = false; target = undefined; publish();
      if (owner) read();
    } else if (event.sender === owner && event.path === PATH && event.interface === 'org.freedesktop.DBus.Properties' && event.member === 'PropertiesChanged' && event.args[0] === NAME) {
      if (event.args[2]?.includes('Visible')) read();
      else if ('Visible' in event.args[1]) { visible = event.args[1].Visible === true; publish(); }
    }
  };
  return { setVisible, toggle: () => setVisible(!(target ?? (pending ? sent : visible))),
    start: async () => {
      await bus.connect(); bus.onSignal(signal);
      bus.addMatch("type='signal',sender='sm.puri.OSK0',path='/sm/puri/OSK0',interface='org.freedesktop.DBus.Properties',member='PropertiesChanged'");
      bus.addMatch("type='signal',sender='org.freedesktop.DBus',interface='org.freedesktop.DBus',member='NameOwnerChanged',arg0='sm.puri.OSK0'");
      await read();
    }, dispose: () => { ++generation; bus.offSignal(signal); } };
}
