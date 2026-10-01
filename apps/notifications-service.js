const NAME = 'org.freedesktop.Notifications', PATH = '/org/freedesktop/Notifications';
const signatures = { Notify: ['susssasa{sv}i', 'u'], CloseNotification: ['u', ''], GetCapabilities: ['', 'as'], GetServerInformation: ['', 'ssss'] };
export const notificationXML = '<node><interface name="' + NAME + '">' +
  '<method name="Notify"><arg type="s" direction="in"/><arg type="u" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="as" direction="in"/><arg type="a{sv}" direction="in"/><arg type="i" direction="in"/><arg type="u" direction="out"/></method>' +
  '<method name="CloseNotification"><arg type="u" direction="in"/></method><method name="GetCapabilities"><arg type="as" direction="out"/></method>' +
  '<method name="GetServerInformation"><arg type="s" direction="out"/><arg type="s" direction="out"/><arg type="s" direction="out"/><arg type="s" direction="out"/></method>' +
  '<signal name="NotificationClosed"><arg type="u"/><arg type="u"/></signal><signal name="ActionInvoked"><arg type="u"/><arg type="s"/></signal></interface>' +
  '<interface name="org.freedesktop.DBus.Introspectable"><method name="Introspect"><arg type="s" direction="out"/></method></interface></node>';
export function emitNotification(bus, destination, member, id, action, reason) {
  if (!destination?.startsWith(':')) throw new Error('Notification destination must be a unique bus name');
  if (member === 'ActionInvoked') bus.emitSignalTo(destination, PATH, NAME, member, 'us', id, action);
  else if (member === 'NotificationClosed') bus.emitSignalTo(destination, PATH, NAME, member, 'uu', id, reason);
  else throw new Error('Unknown notification signal');
}
export async function startNotifications(bus, model) {
  if (typeof bus.emitSignalTo !== 'function') throw new Error('Load the phone DBus plugin with directed signal support');
  const handler = call => {
    const spec = signatures[call.member];
    if (!spec) { call.error('org.freedesktop.DBus.Error.UnknownMethod', call.member); return; }
    if (call.signature !== spec[0]) { call.error('org.freedesktop.DBus.Error.InvalidArgs', 'Unexpected notification arguments'); return; }
    // Bound per-request work before the model formats content or builds cards.
    if (JSON.stringify(call.args).length > 1024 * 1024) { call.error(NAME + '.Error.Unavailable', 'Notification request is too large'); return; }
    try {
      const reply = model.request(call.sender, call.member, call.args);
      if (call.member === 'GetServerInformation') call.reply('ssss', ...reply.Result._v);
      else if (spec[1]) call.reply(spec[1], reply.Result._v);
      else call.reply('');
    } catch (error) { call.error(NAME + '.Error.InvalidNotification', String(error.message || error)); }
  };
  bus.exportObject(PATH, NAME, handler);
  bus.exportObject(PATH, 'org.freedesktop.DBus.Introspectable', call => {
    if (call.member === 'Introspect' && call.signature === '') call.reply('s', notificationXML);
    else call.error('org.freedesktop.DBus.Error.UnknownMethod', call.member);
  });
  try {
    const owner = await bus.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'RequestName', 'su', NAME, 4);
    if (owner !== '1') throw new Error('Another notification server owns the service');
  } catch (error) {
    bus.unexportObject(PATH, NAME); bus.unexportObject(PATH, 'org.freedesktop.DBus.Introspectable'); throw error;
  }
}
