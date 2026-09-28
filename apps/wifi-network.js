import { system as Bus } from 'Module/dbus';
import * as Process from 'Module/process';
import * as Log from 'Helix/Log';
import { networks, connectionSettings, validPassword, ssidBytes } from './wifi-model.js';

const NM = 'org.freedesktop.NetworkManager', ROOT = '/org/freedesktop/NetworkManager';
const DEVICE = NM + '.Device', WIFI = DEVICE + '.Wireless', PROFILE = NM + '.Settings.Connection';
const properties = path => (iface) => Bus.call(NM, path, 'org.freedesktop.DBus.Properties', 'GetAll', 's', iface);

export function wifiNetwork(changed = () => {}) {
  let state = { available: false, enabled: false, hardware: true, loading: true, scanning: false, working: false,
    networks: [], error: '', message: '' };
  let device, active, reading = false, dirty = false, scanTimer, connectTimer, selected, closed = false, readError, refreshJob;
  const created = new Map();
  const publish = next => { state = { ...state, ...next }; if (!closed) changed(state); };
  const finish = () => { clearTimeout(connectTimer); connectTimer = undefined; selected = undefined; };
  const read = async () => {
    try {
      while (dirty && !closed) {
        dirty = false;
        const manager = await properties(ROOT)(NM);
        const paths = await Bus.call(NM, ROOT, NM, 'GetDevices');
        const devices = await Promise.all(paths.map(async path => ({ path, ...await properties(path)(DEVICE) })));
        const found = devices.find(item => Number(item.DeviceType) === 2);
        device = found?.path;
        if (!found) { finish(); publish({ available: false, loading: false, working: false, networks: [], message: 'No Wi-Fi device' }); continue; }
        const wireless = await properties(device)(WIFI);
        const points = await Promise.all((wireless.AccessPoints || []).map(async path => {
          try { return { path, ...await properties(path)(NM + '.AccessPoint') }; } catch (_) { return undefined; }
        }));
        const profiles = await Promise.all((found.AvailableConnections || []).map(async path => {
          try { return { path, settings: await Bus.call(NM, path, PROFILE, 'GetSettings') }; }
          catch (_) { return undefined; }
        }));
        active = found.ActiveConnection && found.ActiveConnection !== '/' ? found.ActiveConnection : undefined;
        let message = state.message, error = state.error, working = state.working;
        if (selected && Number(found.State) === 100 && points.some(ap => ap?.path === wireless.ActiveAccessPoint && ssidBytes(ap.Ssid).join(',') === selected.ssid.join(','))) {
          finish(); working = false; message = 'Connected'; error = '';
        } else if (selected && Number(found.State) === 120) {
          const reason = Number(found.StateReason?.[1]);
          finish(); working = false; message = ''; error = [7, 9, 10, 11].includes(reason)
            ? 'Could not authenticate. Check the password and try again.' : 'Connection failed. Try again.';
        }
        publish({ available: true, loading: false, enabled: !!manager.WirelessEnabled, hardware: !!manager.WirelessHardwareEnabled,
          deviceState: Number(found.State), networks: networks(points.filter(Boolean), profiles.filter(profile => profile?.settings), wireless.ActiveAccessPoint), message, error, working });
        if (state.scanning && Number(wireless.LastScan) !== state.scanStarted) {
          clearTimeout(scanTimer); scanTimer = undefined; publish({ scanning: false });
        }
      }
    } catch (error) {
      readError = String(error);
      Log.error('Wi-Fi read: ' + error);
      finish(); publish({ loading: false, working: false, available: false, error: 'NetworkManager is unavailable. Try Refresh.' });
    } finally { reading = false; }
  };
  const refresh = () => {
    dirty = true;
    if (closed) return Promise.resolve();
    if (reading) return refreshJob;
    reading = true; refreshJob = read(); return refreshJob;
  };
  const operationError = error => {
    // Do not log D-Bus payloads: connection settings may contain credentials.
    const detail = String(error);
    return /authoriz|permission|AccessDenied|NotPrivileged/i.test(detail)
      ? 'Network changes are not authorised for this session.'
      : /secret|password|NoSecrets/i.test(detail) ? 'A password is needed. Select the network and enter it.' : 'Could not connect. Check the password and try again.';
  };
  const scan = async () => {
    if (state.scanning || state.working || closed) return;
    await refresh();
    if (!device || !state.enabled || !state.hardware) return;
    const wireless = await properties(device)(WIFI);
    publish({ scanning: true, scanStarted: Number(wireless.LastScan), error: '', message: '' });
    // One deadline for a requested scan, never an idle polling timer.
    scanTimer = setTimeout(() => { publish({ scanning: false }); refresh(); }, 12000);
    try { await Bus.callComplex(NM, device, WIFI, 'RequestScan', 'a{sv}', {}); }
    catch (error) { clearTimeout(scanTimer); publish({ scanning: false, error: /not allowed|busy/i.test(String(error)) ? '' : operationError(error) }); }
    await refresh();
  };
  const connect = async (network, password) => {
    if (!device || state.working || !network.supported) return;
    // Opening a credential sheet is not a connection attempt. In particular,
    // never ask NetworkManager to activate an unsaved protected AP without a key.
    if (network.password && password === undefined && !network.saved && !created.has(network.key)) return false;
    if (network.password && password !== undefined && !validPassword(network.security, password)) {
      publish({ error: network.security === 'sae' ? 'Enter a password.' : 'Use 8–63 characters or a 64-digit hexadecimal key.' }); return false;
    }
    selected = network; publish({ working: true, error: '', message: 'Connecting to ' + network.name + '…' });
    connectTimer = setTimeout(() => { finish(); publish({ working: false, message: '', error: 'Connection timed out. Check the password and try again.' }); refresh(); }, 35000);
    try {
      const saved = created.get(network.key);
      const saveAndActivate = async () => {
        const user = Process.getEnv('USER', '') || Process.getEnv('LOGNAME', '');
        if (!user) throw new Error('Missing login user');
        const settings = connectionSettings(network, password, user);
        // Only update profiles created by this app in this run. Existing
        // profiles may have enterprise/IP settings the simple form cannot edit.
        if (saved) {
          settings.connection.uuid = saved.uuid;
          await Bus.callComplex(NM, saved.path, PROFILE, 'Update', 'a{sa{sv}}', settings);
          await Bus.call(NM, ROOT, NM, 'ActivateConnection', 'ooo', saved.path, device, network.path);
        } else {
          settings.connection.uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => {
            const value = Math.floor(Math.random() * 16); return (character === 'x' ? value : (value & 3) | 8).toString(16);
          });
          const result = await Bus.callComplex(NM, ROOT, NM, 'AddAndActivateConnection', 'a{sa{sv}}oo', settings, device, network.path);
          const path = Array.isArray(result) ? result[0] : result;
          if (typeof path === 'string' && path.startsWith(ROOT + '/Settings/')) created.set(network.key, { path, uuid: settings.connection.uuid });
        }
      };
      if (password === undefined) {
        // Preserve saved profiles, including enterprise/IP settings. '/' lets
        // NetworkManager choose when no readable profile was found.
        try { await Bus.call(NM, ROOT, NM, 'ActivateConnection', 'ooo', saved?.path || network.saved?.path || '/', device, network.path); }
        catch (error) { if (network.password || !network.supported) throw error; await saveAndActivate(); }
      } else {
        await saveAndActivate();
      }
      await refresh(); return true;
    } catch (error) { finish(); publish({ working: false, message: '', error: operationError(error) }); return false; }
    finally { password = undefined; }
  };
  const signal = event => {
    if (event.interface === 'org.freedesktop.DBus' && event.member === 'NameOwnerChanged' && event.args?.[0] === NM) refresh();
    else if (event.path === ROOT || event.path === device || event.path?.startsWith(ROOT + '/AccessPoint/') || event.path?.startsWith(ROOT + '/Settings/')) refresh();
  };
  const forget = async network => {
    if (state.working || closed) return;
    const profile = network.saved?.path || created.get(network.key)?.path;
    if (!profile) return;
    publish({ working: true, error: '', message: 'Forgetting ' + network.name + '…' });
    try {
      if (network.connected && device) await Bus.call(NM, device, DEVICE, 'Disconnect');
      await Bus.call(NM, profile, PROFILE, 'Delete');
      created.delete(network.key);
      publish({ message: '' });
    } catch (error) {
      publish({ message: '', error: /authoriz|permission|AccessDenied|NotPrivileged/i.test(String(error))
        ? 'Network changes are not authorised for this session.' : 'Could not forget this network. Try again.' });
    } finally { publish({ working: false }); await refresh(); }
  };
  return {
    get readError() { return readError; },
    get state() { return state; }, refresh, scan, connect, forget,
    clearError: () => publish({ error: '', message: '' }),
    start: async () => {
      await Bus.connect(); Bus.onSignal(signal);
      await Bus.addMatch("type='signal',sender='org.freedesktop.NetworkManager',path_namespace='/org/freedesktop/NetworkManager'");
      await Bus.addMatch("type='signal',sender='org.freedesktop.DBus',interface='org.freedesktop.DBus',member='NameOwnerChanged',arg0='org.freedesktop.NetworkManager'");
      await refresh(); await scan();
    },
    toggle: async () => {
      if (state.working || closed) return;
      publish({ working: true, error: '' });
      try { await Bus.callComplex(NM, ROOT, 'org.freedesktop.DBus.Properties', 'Set', 'ssv', NM, 'WirelessEnabled', !state.enabled); }
      catch (error) { publish({ error: operationError(error) }); }
      finally { publish({ working: false }); await refresh(); if (state.enabled) await scan(); }
    },
    disconnect: async () => {
      if (!device || (state.working && !selected) || closed) return;
      finish();
      publish({ working: true, error: '', message: '' });
      try { await Bus.call(NM, device, DEVICE, 'Disconnect'); }
      catch (error) { publish({ error: operationError(error) }); }
      finally { publish({ working: false }); await refresh(); }
    },
    dispose: () => { closed = true; clearTimeout(scanTimer); finish(); Bus.offSignal(signal); }
  };
}
