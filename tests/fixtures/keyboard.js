import { typed, serve, properties, changed, own, start } from './service.js';
const path = '/sm/puri/OSK0', iface = 'sm.puri.OSK0';
const props = { [iface]: { Visible: typed('b', false) } };
let delay = false, fail = false;
const visible = value => {
  if (props[iface].Visible._v === value) return;
  props[iface].Visible = typed('b', value); changed(path, iface, props[iface]);
};
export default start(async () => {
  properties(path, props);
  serve(path, 'org.koya.Test.Keyboard', call => {
    if (call.member === 'Visible') visible(call.args[0]);
    else if (call.member === 'DelayNext') delay = true;
    else if (call.member === 'FailNext') fail = true;
    else return call.error('org.freedesktop.DBus.Error.UnknownMethod', call.member);
    call.reply('');
  });
  serve(path, iface, call => {
    if (call.member !== 'SetVisible') return call.error('org.freedesktop.DBus.Error.UnknownMethod', call.member);
    if (fail) { fail = false; return call.error('org.koya.Test.Rejected', 'Test keyboard rejected'); }
    const finish = () => { visible(call.args[0]); call.reply(''); };
    if (delay) { delay = false; setTimeout(finish, 150); } else finish();
  });
  await own('sm.puri.OSK0');
});
