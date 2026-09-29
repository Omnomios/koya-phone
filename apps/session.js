import { session as Bus } from 'Module/dbus';
import * as Log from 'Helix/Log';
import * as Engine from 'Helix/Engine';
import { configureHaptics } from './haptics.js';
import { configureWallpaper } from './wallpaper-surface.js';

const NAME = 'org.koya.Shell1';
const PATH = '/org/koya/Shell1';
export const call = (method, signature = '', ...args) =>
  Bus.call(NAME, PATH, NAME, method, signature, ...args);

// Native D-Bus promises are dispatched by the running engine. Do not await
// this connection from the bootstrap function: start it after bootstrap.
export function connect(component, onState = () => {}, onDesktop = () => {}, onApplications = () => {}, onConnected = () => {}, onHardware = () => {}) {
  setTimeout(async () => {
    try {
      await Bus.connect();
      let refreshing = false;
      let dirty = false;
      const refresh = async () => {
        if (refreshing) { dirty = true; return; }
        refreshing = true;
        try {
          do {
            dirty = false;
            const state = await call('GetState');
            configureHaptics(state); await configureWallpaper(state); await onState(state);
          } while (dirty);
        } finally { refreshing = false; }
      };
      Bus.onSignal(event => {
        if (event.interface === NAME && event.member === 'HardwareButton') {
          try {
            Promise.resolve(onHardware(event.args[0])).catch(error => Log.error('Hardware button: ' + error));
          } catch (error) { Log.error('Hardware button payload: ' + error); }
        }
        if (event.interface === NAME && event.member === 'ApplicationsChanged') {
          Promise.resolve(onApplications()).catch(error => Log.error('Application state: ' + error));
        }
        if (event.interface === NAME && event.member === 'DesktopChanged') {
          Promise.resolve(onDesktop()).catch(error => Log.error('Desktop state: ' + error));
        }
        if (event.interface === NAME && event.member === 'StateChanged') {
          // The first signal argument is already the full state dictionary.
          // The desktop controller serializes these snapshots itself.
          const state = event.args?.[0];
          if ((component === 'navigation' || component === 'top-bar') && typeof state?.Active === 'boolean') {
            configureHaptics(state);
            configureWallpaper(state).then(() => onState(state)).catch(error => Log.error('Shell state: ' + error));
          } else refresh().catch(error => Log.error('Shell state: ' + error));
        }
        if (event.interface === 'org.freedesktop.DBus' && event.member === 'NameOwnerChanged' && event.args?.[0] === NAME) {
          if (!event.args[2]) Engine.quit();
          else refresh().catch(() => Engine.quit());
        }
      });
      await Bus.addMatch("type='signal',sender='org.koya.Shell1',interface='org.koya.Shell1',member='StateChanged'");
      if (component === 'top-bar') await Bus.addMatch("type='signal',sender='org.koya.Shell1',interface='org.koya.Shell1',member='HardwareButton'");
      if (component === 'navigation') await Bus.addMatch("type='signal',sender='org.koya.Shell1',interface='org.koya.Shell1',member='DesktopChanged'");
      if (component === 'navigation' || component === 'top-bar') await Bus.addMatch("type='signal',sender='org.koya.Shell1',interface='org.koya.Shell1',member='ApplicationsChanged'");
      await Bus.addMatch("type='signal',sender='org.freedesktop.DBus',interface='org.freedesktop.DBus',member='NameOwnerChanged',arg0='org.koya.Shell1'");
      await onConnected();
      await refresh();
      if (component !== 'settings') await call('Ready', 's', component);
    } catch (error) {
      Log.error(component + ': D-Bus setup failed: ' + error);
      Engine.quit();
    }
  }, 0);
}
