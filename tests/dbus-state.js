import * as Bus from 'Module/dbus';
import * as Log from 'Helix/Log';
import * as Engine from 'Helix/Engine';
export default () => { setTimeout(async () => {
  await Bus.connect('session');
  const state = await Bus.call('org.koya.Shell1', '/org/koya/Shell1', 'org.koya.Shell1', 'GetState');
  Log.info('SHELL_STATE ' + JSON.stringify(state));
  setTimeout(() => Engine.quit(), 300);
}, 0); };
