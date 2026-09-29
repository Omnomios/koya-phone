import { Bus, Process, typed, serve, properties, changed, own, start } from './service.js';
const root = '/org/freedesktop/login1', path = root + '/session/test';
const iface = 'org.freedesktop.login1.Session';
let active = true, capability = 'yes', reject = false;
const actions = [], attempts = [], feedback = [];
const props = { [iface]: { Active: typed('b', true) } };
export default start(async () => {
  properties(path, props);
  serve(root, 'org.freedesktop.login1.Manager', call => {
    if (call.member === 'GetSessionByPID') return call.reply('o', path);
    if (call.member.startsWith('Can')) return call.reply('s', capability);
    if (!['PowerOff', 'Reboot'].includes(call.member)) return call.error('org.freedesktop.DBus.Error.UnknownMethod', call.member);
    attempts.push(call.member + ':' + call.args[0]);
    if (capability === 'challenge') {
      if (call.args[0] !== true) throw new Error('Authentication was not requested');
      return call.error('org.freedesktop.PolicyKit1.Error.Cancelled', 'Authentication cancelled');
    }
    if (call.args[0] !== false) throw new Error('Unexpected authentication request');
    if (reject) return call.error('org.freedesktop.login1.Inhibited', 'Test inhibitor');
    actions.push(call.member); call.reply('');
  });
  serve(path, iface, async call => {
    const [subsystem, device, level] = call.args;
    if (call.member !== 'SetBrightness' || subsystem !== 'backlight' || device !== 'fixture' || level < 1) throw new Error('Unexpected brightness request');
    if (reject) return call.error('org.freedesktop.DBus.Error.AccessDenied', 'Test brightness rejection');
    const directory = Process.getEnv('KOYA_TEST_BACKLIGHT_DIR') + '/' + device;
    const maximum = Number((await Process.exec('cat ' + "'" + directory.replace(/'/g, "'\\''") + "/max_brightness'")).stdout);
    if (level > maximum) throw new Error('Brightness out of range');
    Process.writeFileText(directory + '/brightness', String(level)); call.reply('');
  });
  serve(root, 'org.koya.Test.Login', call => {
    if (call.member === 'Actions') return call.reply('as', actions);
    if (call.member === 'Attempts') return call.reply('as', attempts);
    if (call.member !== 'Set' || call.signature !== 'bsb') return call.error('org.freedesktop.DBus.Error.InvalidArgs', 'Expected Set(bsb)');
    [active, capability, reject] = call.args;
    props[iface].Active = typed('b', active); changed(path, iface, props[iface]); call.reply('');
  });
  await own('org.freedesktop.login1');
  if (Process.getEnv('KOYA_TEST_HAPTICS') === '1') {
    serve('/org/sigxcpu/Feedback', 'org.sigxcpu.Feedback', call => {
      if (call.member === 'TriggerFeedback') {
        const [app, event, hints, timeout] = call.args;
        if (app !== 'org.koya.Shell' || event !== 'button-pressed' || hints.profile !== 'quiet' || timeout !== -1) throw new Error('Unexpected feedback');
        feedback.push(event);
      }
      call.reply('u', feedback.length);
    });
    await own('org.sigxcpu.Feedback');
  }
});
