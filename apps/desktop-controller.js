import * as Hypr from 'Module/hypr';
import * as Desktop from 'Module/desktop';
import * as Process from 'Module/process';
export function createDesktop(root, changed, applicationsChanged, homeSelected) {
  let available = false;
  const accepted = reply => reply === 'ok' || reply === 'ok\n';
  const send = async command => {
    if (!available) throw new Error('Hyprland is unavailable');
    const reply = await Hypr.send(command);
    if (!accepted(reply)) throw new Error('Hyprland rejected the desktop action: ' + reply);
  };
  return {
    start: async () => {
      Desktop.start(root, applicationsChanged);
      if (!Process.getEnv('HYPRLAND_INSTANCE_SIGNATURE', '')) { changed(false); return; }
      Hypr.on('connection', event => {
        available = event.payload === 'connected'; changed(available);
        if (!available) homeSelected();
      });
      Hypr.connect();
      for (const name of ['workspacev2', 'createworkspacev2', 'destroyworkspacev2', 'openwindow', 'closewindow', 'movewindowv2', 'activewindowv2', 'windowtitlev2', 'monitoraddedv2', 'monitorremoved']) {
        Hypr.on(name, event => { if (event.name === 'workspacev2' && event.payload.startsWith('1,')) homeSelected(); changed(available); });
      }
      try { await Hypr.workspaces(); available = true; }
      catch (_) { available = false; }
      changed(available);
    }, applications: () => Desktop.applications(), resolveIcon: description => Desktop.resolveIcon(description),
    state: async () => {
      const [workspaces, clients, activeworkspace] = await Promise.all([Hypr.workspaces(), Hypr.clients(), Hypr.activeworkspace()]);
      return { workspaces: JSON.stringify(workspaces), clients: JSON.stringify(clients), activeworkspace: JSON.stringify(activeworkspace) };
    }, dispatch: command => send('dispatch ' + command),
    switchDesktop: async workspace => {
      if (!Number.isInteger(workspace) || workspace < 1 || workspace > 10000) throw new Error('Invalid workspace');
      const reply = await Hypr.send('dispatch workspace ' + workspace);
      if (!accepted(reply) && !['Previous workspace doesn\'t exist', 'Previous workspace doesn\'t exist\n'].includes(reply)) throw new Error('Hyprland rejected the desktop action');
      if (workspace === 1) homeSelected();
    }, launch: async (id, workspace) => {
      if (!Number.isInteger(workspace) || workspace < 2 || workspace > 10000) throw new Error('Invalid application workspace');
      const command = await Desktop.launchCommand(id);
      await send('dispatch workspace ' + workspace);
      await send('dispatch ' + command);
    }
  };
}
