import { Bus, Process, serve, own, start } from './service.js';
export default start(async () => {
  const name = Process.getEnv('KOYA_TEST_COMPONENT');
  serve('/org/koya/Test/Component', 'org.koya.Test.Component', async call => {
    if (call.member === 'Sequence') {
      // Send ordered calls on one connection before awaiting their replies.
      await Promise.all(call.args[0].map(method => Bus.call('org.koya.Shell1', '/org/koya/Shell1', 'org.koya.Shell1', method)));
      return call.reply('');
    }
    const launch = call.member === 'Launch';
    if (!launch && call.member !== 'Action') return call.error('org.freedesktop.DBus.Error.UnknownMethod', call.member);
    await Bus.call('org.koya.Shell1', '/org/koya/Shell1', 'org.koya.Shell1',
      launch ? 'LaunchApplication' : call.args[0], ...(launch ? ['su', ...call.args] : []));
    call.reply('');
  });
  await own('org.koya.Test.' + name.replace(/-/g, '_'));
  await Bus.call('org.koya.Shell1', '/org/koya/Shell1', 'org.koya.Shell1', 'Ready', 's', name);
});
