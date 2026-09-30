import { system as Bus } from 'Module/dbus';

const NAME = 'org.koya.Update1', PATH = '/org/koya/Update1';
export function updateService(changed) {
  const unavailable = () => changed({ State: 'unavailable', Message: 'The update service is unavailable', Log: '' });
  const refresh = async () => {
    try { await changed(await Bus.call(NAME, PATH, NAME, 'GetState')); }
    catch (_) { await unavailable(); }
  };
  return {
    start: async () => { await Bus.call(NAME, PATH, NAME, 'Start'); await refresh(); },
    connect: async () => {
      await Bus.connect();
      Bus.onSignal(event => {
        if (event.interface === NAME && event.member === 'Changed') changed(event.args[0]);
        if (event.interface === 'org.freedesktop.DBus' && event.member === 'NameOwnerChanged' && event.args[0] === NAME)
          event.args[2] ? refresh() : unavailable();
      });
      await Bus.addMatch(`type='signal',sender='${NAME}',interface='${NAME}',member='Changed'`);
      await Bus.addMatch(`type='signal',sender='org.freedesktop.DBus',interface='org.freedesktop.DBus',member='NameOwnerChanged',arg0='${NAME}'`);
      await refresh();
    }
  };
}
