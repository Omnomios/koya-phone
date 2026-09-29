import { session as Bus } from 'Module/dbus';
import * as Process from 'Module/process';
import * as Log from 'Helix/Log';

export { Bus, Process };
export const typed = (_t, _v) => ({ _t, _v });
export const daemon = (method, signature = '', ...args) => Bus.callComplex(
  'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', method, signature, ...args);
export async function own(name) {
  if (await daemon('RequestName', 'su', name, 4) !== '1') throw new Error('Cannot own ' + name);
}
export const changed = (path, iface, props) => Bus.emitSignal(
  path, 'org.freedesktop.DBus.Properties', 'PropertiesChanged', 'sa{sv}as', iface, props, []);
export function serve(path, iface, handler) {
  Bus.exportObject(path, iface, call => {
    Promise.resolve().then(() => handler(call)).catch(error => {
      Log.error(String(error));
      call.error('org.koya.Test.Error', String(error));
    });
  });
}
export function properties(path, interfaces, setter) {
  serve(path, 'org.freedesktop.DBus.Properties', call => {
    const [iface, name, value] = call.args;
    const props = interfaces[iface];
    if (!props) return call.error('org.freedesktop.DBus.Error.UnknownInterface', iface);
    if (call.member === 'GetAll') return call.reply('a{sv}', props);
    if (!(name in props)) return call.error('org.freedesktop.DBus.Error.UnknownProperty', name);
    if (call.member === 'Get') return call.reply('v', props[name]);
    if (call.member === 'Set' && setter) return setter(call, iface, name, value);
    call.error('org.freedesktop.DBus.Error.PropertyReadOnly', name);
  });
}
export function start(setup) {
  return () => setTimeout(async () => {
    try {
      const address = Process.getEnv('DBUS_SESSION_BUS_ADDRESS', '');
      if (!address.includes(Process.getEnv('XDG_RUNTIME_DIR', '/missing'))) throw new Error('Fixture requires a private test bus');
      await Bus.connect();
      if (typeof Bus.exportObject !== 'function') throw new Error('Koya D-Bus plugin needs exportObject, unexportObject and emitSignal');
      await setup();
    } catch (error) { Log.error(String(error)); Process.writeFileText(Process.getEnv('KOYA_TEST_FAILURE', '/tmp/koya-test-failure'), String(error)); }
  }, 0);
}
