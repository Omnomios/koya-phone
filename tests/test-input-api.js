import * as UI from 'Helix/UserInterface';
import * as Input from 'Helix/Input';
import wallpaper from '../apps/wallpaper.js';
import topBar from '../apps/top-bar.js';
import navigation from '../apps/navigation.js';
import lockScreen from '../apps/lock-screen.js';
import powerMenu from '../apps/power-menu.js';
import authentication from '../apps/authentication.js';
import settings from '../apps/settings.js';
import wifi from '../apps/wifi.js';
import update from '../apps/update.js';
import platform from '../apps/platform.js';
import { run, assert } from './check.js';

// Import every supervised UI entry point against the real Koya runtime. This
// checks native modules and API availability without creating graphical windows.
export default run(async () => {
  for (const name of ['setOnPress', 'setOnActivate', 'setOnDrag', 'setInputOptions'])
    assert(typeof UI[name] === 'function', 'Missing virtual UI API: ' + name);
  for (const name of ['setHandlers', 'setOptions'])
    assert(typeof Input[name] === 'function', 'Missing window input API: ' + name);
  for (const entry of [wallpaper, topBar, navigation, lockScreen, powerMenu,
    authentication, settings, wifi, update, platform]) assert(typeof entry === 'function', 'Invalid application entry point');
});
