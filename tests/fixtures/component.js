import { Bus, Process, serve, own, start } from './service.js';
export default start(async () => {
  const name = Process.getEnv('KOYA_TEST_COMPONENT');
  const shell = (method, ...args) => Bus.call('org.koya.Shell1', '/org/koya/Shell1', 'org.koya.Shell1', method, ...args);
  const invoke = async method => {
    if (method === 'BeginUnlock' || method === 'CancelUnlock') return shell(method, 'u', (await shell('GetState')).LockGeneration);
    if (method !== 'Unlock') return shell(method);
    const generation = (await shell('GetState')).LockGeneration;
    await shell('BeginUnlock', 'u', generation);return shell('Unlock', 'u', generation);
  };
  serve('/org/koya/Test/Component', 'org.koya.Test.Component', async call => {
    if (call.member === 'Respond') {
      await shell('AuthenticationRespond', 'us', ...call.args); return call.reply('');
    }
    if (call.member === 'Sequence') {
      // Send ordered calls on one connection before awaiting their replies.
      const generation = (await shell('GetState')).LockGeneration;
      if (call.args[0].includes('Unlock')) await shell('BeginUnlock', 'u', generation);
      await Promise.all(call.args[0].map(method => shell(method, ...(method === 'Unlock' ? ['u', generation] : []))));
      return call.reply('');
    }
    const launch = call.member === 'Launch';
    if (!launch && call.member !== 'Action') return call.error('org.freedesktop.DBus.Error.UnknownMethod', call.member);
    if (launch) await shell('LaunchApplication', 'su', ...call.args);
    else await invoke(call.args[0]);
    call.reply('');
  });
  if (name === 'lock-screen') {
    Bus.onSignal(event => { if (event.member === 'StateChanged' && event.args?.[0]?.ScreenState !== 'unlocked' && !event.args?.[0]?.SecureLocked) shell('Ready', 's', name).catch(() => {}); });
    await Bus.addMatch("type='signal',sender='org.koya.Shell1',interface='org.koya.Shell1',member='StateChanged'");
  }
  await own('org.koya.Test.' + name.replace(/-/g, '_'));
  await Bus.call('org.koya.Shell1', '/org/koya/Shell1', 'org.koya.Shell1', 'Ready', 's', name);
});
