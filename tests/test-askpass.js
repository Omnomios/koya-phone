import { Bus, build, fixture, coordinator, spawn, stop, testCall, waitState, wait, sleep, assert, equal, run } from './check.js';

export default run(async () => {
  fixture('login');
  await wait(async () => { await Bus.call('org.freedesktop.login1', '/org/freedesktop/login1', 'org.koya.Test.Login', 'Set', 'bsb', true, 'yes', false); return true; });
  coordinator();
  await waitState(state => state.authenticationStatus === 'ready');
  const begins = [], prompts = [], ends = [];
  for (const member of ['AuthenticationBegin', 'AuthenticationPrompt', 'AuthenticationEnd'])
    await Bus.addMatch(`type='signal',interface='org.koya.Shell1',member='${member}'`);
  Bus.onSignal(event => {
    if (event.interface !== 'org.koya.Shell1') return;
    if (event.member === 'AuthenticationBegin') begins.push(event.args);
    if (event.member === 'AuthenticationPrompt') prompts.push(event.args);
    if (event.member === 'AuthenticationEnd') ends.push(event.args[0]);
  });
  const helper = build + '/koya-askpass';
  const started = count => wait(() => begins.length === count && prompts.length === count && begins[count - 1]);
  const exited = child => wait(() => child.code !== null && child);
  const answer = (id, text) => testCall('AuthenticationAnswer', 'us', id, text);
  const dismiss = id => testCall('AuthenticationDismiss', 'u', id);

  let child = spawn(helper, ['Enter passphrase for key:', '/home/user/.ssh/id_ed25519']);
  let request = await started(1);
  equal(request[1], 'org.koya.Askpass.entry');
  equal(prompts[0][1], 'Enter passphrase for key: /home/user/.ssh/id_ed25519');
  await answer(request[0], 'test secret');
  await exited(child); equal(child.code, 0); equal(child.output, 'test secret\n');
  await wait(() => ends.includes(request[0]));

  child = spawn('env', ['SSH_ASKPASS_PROMPT=confirm', helper, 'Allow this key?']);
  request = await started(2);
  equal(request[1], 'org.koya.Askpass.confirm');
  await answer(request[0], '');
  await exited(child); equal(child.code, 0); equal(child.output, '');

  child = spawn('env', ['SSH_ASKPASS_PROMPT=none', helper, 'Continue?']);
  request = await started(3);
  equal(request[1], 'org.koya.Askpass.none');
  await answer(request[0], '');
  await exited(child); equal(child.code, 0); equal(child.output, '');

  child = spawn(helper, ['Cancel this request']);
  request = await started(4);
  await dismiss(request[0]);
  await exited(child); assert(child.code !== 0); equal(child.output, '');

  const first = spawn(helper, ['First key']);
  request = await started(5);
  const second = spawn(helper, ['Second key']);
  await sleep(100);
  equal(begins.length, 5, 'Overlapping requests were displayed together');
  await answer(request[0], 'first');
  await exited(first); equal(first.output, 'first\n');
  request = await started(6);
  await answer(request[0], 'second');
  await exited(second); equal(second.output, 'second\n');

  child = spawn(helper, ['Abandoned key']);
  request = await started(7);
  await stop(child, 9);
  await wait(() => ends.includes(request[0]), 'Disconnected askpass request remained open');
  child = spawn(helper, ['Next key']);
  request = await started(8);
  await answer(request[0], 'next');
  await exited(child); equal(child.output, 'next\n');
});
