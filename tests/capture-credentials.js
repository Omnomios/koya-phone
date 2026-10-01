import * as Compositor from 'Koya/Compositor';
import * as UI from 'Helix/UserInterface';
import * as Screenshot from 'Koya/Screenshot';
import * as Image from 'Koya/Image';
import * as Process from 'Module/process';
import * as Engine from 'Helix/Engine';
import { credentialInput } from '../apps/credential-input.js';
import { text } from '../apps/touch-ui.js';
import { INK, TYPE } from '../apps/theme.js';

export default async () => {
  const mode = Process.getEnv('KOYA_CAPTURE_MODE') || 'password';
  const landscape = Process.getEnv('KOYA_CAPTURE_LANDSCAPE') === '1';
  const size = landscape ? { x: 960, y: 540 } : { x: 540, y: 960 };
  const width = size.x - 40;
  const win = await Compositor.createWindow({ role: 'window', title: 'Credential input', size, msaaSamples: 1, transparent: false });
  const root = await UI.createElement(win, { renderable: { type: 'box', colour: INK }, layout: { type: 'column', gap: 16, padding: { l: 20, r: 20, t: 20, b: 20 } }, item: { size } });
  await UI.attachRoot(win, root);
  await text(win, root, 'Unlock', TYPE.title, width, 56);
  const input = await credentialInput(win, root, { width, mode, compact: landscape, rowHeight: landscape ? 32 : 48, profile: { AuthenticationMode: 'pin', AuthenticationSalt: '01'.repeat(32) }, onSubmit: () => {} });
  setTimeout(async () => {
    const path = Process.getEnv('KOYA_CAPTURE_OUTPUT') || '/tmp/koya-credential';
    try {
      input.insert({ text: mode === 'pin' ? '123456' : 'Sample password' });
      if (mode === 'pin' && (await input.answer()).length !== 64) throw new Error('PIN answer was not derived');
      const frame = await UI.getElementFrame(win, input.root);
      if (frame.size.y < (landscape ? 128 : 250) || frame.max.y > size.y) throw new Error('Credential keyboard does not fit: ' + JSON.stringify(frame));
      await new Promise(resolve => setTimeout(resolve, 300));
      if (!await Screenshot.capture(win, { id: 'credentials', source: 'vulkan', mipmaps: false })) throw new Error('Capture failed');
      const bytes = await Image.encode(win, { src: '/ram/screenshot/credentials', format: 'png' });
      Process.writeFile(path + '.png', bytes instanceof ArrayBuffer ? bytes : Uint8Array.from(bytes).buffer);
      await input.setEnabled(false);
      if (input.value !== '' || input.focused) throw new Error('Disabled input retained a credential');
      await input.setEnabled(true);
      if (!input.focused) throw new Error('Enabled input did not regain hardware focus');
      input.dispose();
      Process.writeFileText(path + '.json', JSON.stringify({ passed: true }));
    } catch (error) { Process.writeFileText(path + '.json', JSON.stringify({ error: String(error), stack: error.stack })); }
    finally { Engine.quit(); }
  }, 1000);
  return win;
};
