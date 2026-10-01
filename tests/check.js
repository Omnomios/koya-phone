import { session as Bus } from 'Module/dbus';
import * as Process from 'Module/process';
import * as Engine from 'Helix/Engine';
import * as Log from 'Helix/Log';
export { Bus, Process };
export const root = Process.getEnv('KOYA_TEST_ROOT');
export const runtime = Process.getEnv('XDG_RUNTIME_DIR');
export const build = Process.getEnv('KOYA_TEST_BUILD');
export const appRoot = Process.getEnv('KOYA_TEST_APP_ROOT');
export const quote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export function assert(value, message = 'Assertion failed') { if (!value) throw new Error(message); }
export function equal(actual, expected, message = 'Unexpected value') {
  assert(JSON.stringify(actual) === JSON.stringify(expected), message + ': ' + JSON.stringify(actual));
}
export async function wait(predicate, message = 'Condition timed out', timeout = 8000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { const value = await predicate(); if (value) return value; } catch (error) { last = error; }
    await sleep(30);
  }
  throw new Error(message + (last ? ': ' + last : ''));
}
export async function denied(operation) {
  try { await operation(); } catch (error) { return error; }
  throw new Error('Expected rejection');
}
export const call = (method, signature = '', ...args) => Bus.callComplex(
  'org.koya.Shell1', '/org/koya/Shell1', 'org.koya.Shell1', method, signature, ...args
).catch(error => { throw new Error(method + ': ' + error); });
export const state = () => call('GetState');
export const waitState = async (predicate, message) => {
  let lastState;
  try {
    return await wait(async () => {
      lastState = await state(); return (await predicate(lastState)) && lastState;
    }, message);
  } catch (error) { throw new Error(String(error) + '\nLast shell state: ' + JSON.stringify(lastState)); }
};
export const testCall = (method, signature = '', ...args) => Bus.callComplex(
  'org.koya.Shell1', '/org/koya/Shell1', 'org.koya.Shell1.Test', method, signature, ...args);
export const key = (code, value) => testCall('Button', 'uu', code, value);
export const action = (name, component = 'power_menu') => Bus.call(
  'org.koya.Test.' + component, '/org/koya/Test/Component', 'org.koya.Test.Component', 'Action', 's', name);
export const login = (active = true, capability = 'yes', reject = false) => Bus.call(
  'org.freedesktop.login1', '/org/freedesktop/login1', 'org.koya.Test.Login', 'Set', 'bsb', active, capability, reject);
const children = [];
export function spawn(cmd, args = []) {
  const child = Process.spawn({ cmd, args });
  child.output = ''; child.errorOutput = ''; child.code = null;
  child.stdout.on('data', text => { child.output += text; });
  child.stderr.on('data', text => { child.errorOutput += text; });
  child.on('exit', code => { child.code = code; });
  children.push(child);
  return child;
}
export const fixture = name => spawn('env', ['KOYA_TEST_ENTRY=' + name, root + '/tests/fixtures/koya-fixture.sh']);
export const coordinator = (component = root + '/tests/fixtures/component.sh') => spawn(
  build + '/koya-session-test', [appRoot, component]);
export async function stop(child, signal = 15) {
  if (child.code === null) child.kill(signal);
  await wait(() => child.code !== null, 'Process failed to stop: ' + child.errorOutput, 6000);
  return child.code;
}
export async function read(path) { return (await Process.exec('cat -- ' + quote(path))).stdout; }
export async function dead(pid) {
  if (!pid || !Process.exists('/proc/' + pid + '/stat')) return true;
  try { return (await read('/proc/' + pid + '/stat')).split(') ')[1].startsWith('Z '); } catch (_) { return true; }
}
export async function kill(pid, signal = 'KILL') { await Process.exec('kill -' + signal + ' ' + Number(pid)); }
export function run(test) {
  return () => {
    assert(typeof Bus.exportObject === 'function' && typeof Bus.emitSignal === 'function', 'Koya D-Bus plugin lacks service export support');
    setTimeout(async () => {
      try {
        await Bus.connect();
        await test();
        Process.writeFileText(runtime + '/passed', 'PASS\n'); Log.info('PASS');
      } catch (error) {
        Process.writeFileText(Process.getEnv('KOYA_TEST_FAILURE'), String(error) + '\n' + (error.stack || ''));
        Log.error(String(error));
        for (const child of children) Log.error('Child ' + child.pid + ': ' + child.output + child.errorOutput);
      } finally {
        for (const child of children.reverse()) {
          try { await stop(child); } catch (_) { try { child.kill(9); } catch (_) {} }
        }
        Engine.quit();
      }
    }, 0);
  };
}
