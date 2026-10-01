// One supervised worker owns native device access and shared DBus controllers.
import { session as Bus, system as System } from 'Module/dbus';
import * as Device from 'Module/linux-device';
import * as Polkit from 'Module/polkit-agent';
import * as Process from 'Module/process';
import * as Engine from 'Helix/Engine';
import * as Log from 'Helix/Log';
import { createDesktop } from './desktop-controller.js';
import { createKeyboard } from './keyboard-controller.js';
import { createNetworkStatus } from './network-status.js';
const SHELL = 'org.koya.Shell1', SHELL_PATH = '/org/koya/Shell1', NAME = 'org.koya.Platform1', PATH = '/org/koya/Platform1';
const shell = (method, signature = '', ...args) => Bus.callComplex(SHELL, SHELL_PATH, SHELL, method, signature, ...args);
export default () => { setTimeout(async () => {
  try {
    await Bus.connect();
    const owner = await Bus.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'GetNameOwner', 's', SHELL);
    let snapshot = {}, previous = '', publishing = false, dirty = false, ready = false, authenticationTimer;
    const report = error => Log.error('Platform: ' + error);
    const publish = async () => {
      dirty = true;
      if (!ready || publishing) return;
      publishing = true;
      try {
        do {
          dirty = false;
          const key = JSON.stringify(snapshot);
          if (key === previous) continue;
          await shell('PlatformState', 'a{sv}', snapshot); previous = key;
        } while (dirty);
      } finally { publishing = false; }
    };
    const update = values => { Object.assign(snapshot, values); publish().catch(report); };
    const refreshDevices = () => {
      const brightness = Device.brightness();
      update({ ...Device.battery(), BrightnessDevice: brightness.Device, BrightnessMaximum: { _t: 'u', _v: brightness.Maximum }, BrightnessPercent: brightness.Percent });
    };
    const keyboard = createKeyboard(Bus, update);
    const desktop = createDesktop(Process.getEnv('KOYA_PHONE_ROOT'), available => {
      update({ DesktopAvailable: available });
      if (ready) shell('PlatformDesktopChanged').catch(report);
    }, () => shell('PlatformApplicationsChanged').catch(report), () => keyboard.setVisible(false));
    const network = createNetworkStatus(System, update);
    const authenticationStart = () => {
      clearTimeout(authenticationTimer);
      if (!Polkit.start()) authenticationTimer = setTimeout(authenticationStart, 3000);
    };
    Device.start(event => {
      if (event.kind === 'button') shell('PlatformButton', 'uu', event.code, event.value).catch(report);
      else if (event.kind === 'reset') shell('PlatformReset').catch(report);
      else if (event.kind === 'battery' || event.kind === 'brightness') {
        refreshDevices();
        if (event.kind === 'brightness') shell('PlatformBrightnessChanged').catch(report);
      } else if (event.kind === 'error') update({ DeviceError: event.message });
    });
    Bus.exportObject(PATH, NAME, call => {
      if (call.sender !== owner) { call.error(NAME + '.Denied', 'Platform controls require the session coordinator'); return; }
      (async () => {
        const args = call.args;
        switch (call.member) {
        case 'GetBrightness': call.reply('a{sv}', Device.brightness()); return;
        case 'GetApplications': call.reply('aa{sv}', await desktop.applications()); return;
        case 'ResolveIcon': call.reply('s', await desktop.resolveIcon(args[0])); return;
        case 'GetDesktopState': call.reply('a{sv}', await desktop.state()); return;
        case 'LaunchApplication': await desktop.launch(...args); break;
        case 'SwitchDesktop': await desktop.switchDesktop(args[0]); break;
        case 'Dispatch': await desktop.dispatch(args[0]); break;
        case 'SetActive': Device.setActive(args[0]); break;
        case 'ToggleKeyboard': keyboard.toggle(); break;
        case 'HideKeyboard': keyboard.setVisible(false); break;
        case 'RefreshDevices': refreshDevices(); break;
        case 'AuthenticationStart': authenticationStart(); break;
        case 'AuthenticationStop': clearTimeout(authenticationTimer); Polkit.stop(); break;
        default: call.error('org.freedesktop.DBus.Error.UnknownMethod', call.member); return;
        }
        call.reply('');
      })().catch(error => call.error(NAME + '.Error', String(error)));
    });
    const name = await Bus.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'RequestName', 'su', NAME, 4);
    if (name !== '1') throw new Error('Another platform worker owns the service');
    Bus.onSignal(event => {
      if (event.interface === 'org.freedesktop.DBus' && event.member === 'NameOwnerChanged' && event.args[0] === SHELL && event.args[2] !== owner) Engine.quit();
    });
    Bus.addMatch("type='signal',sender='org.freedesktop.DBus',interface='org.freedesktop.DBus',member='NameOwnerChanged',arg0='org.koya.Shell1'");
    refreshDevices();
    await keyboard.start(); await desktop.start();
    // Populate the icon mount before the coordinator starts its UI clients.
    await desktop.applications();
    try { await network.start(); } catch (error) { report(error); update({ NetworkAvailable: false, NetworkState: 'unavailable', WifiState: 'unavailable', CellularState: 'unavailable' }); }
    ready = true; await publish(); await shell('Ready', 's', 'platform');
  } catch (error) { Log.error('Platform startup: ' + error); Engine.quit(); }
}, 0); };
