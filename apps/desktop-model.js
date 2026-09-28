// Pure state projection: Hyprland owns windows and desktops, including dialogs.
export function decodeDesktop(value) {
  return {
    workspaces: JSON.parse(value.workspaces),
    clients: JSON.parse(value.clients).filter(client => client.mapped !== false && client.workspace?.id > 0),
    active: JSON.parse(value.activeworkspace)
  };
}
export function nextDesktop(state) {
  const occupied = new Set(state.workspaces.map(workspace => workspace.id));
  for (const client of state.clients) occupied.add(client.workspace.id);
  let id = 2; while (occupied.has(id)) id++;
  if (id > 10000) throw new Error('No desktop available');
  return id;
}
export function appWindow(app, clients) {
  const names = new Set([app.class, app.executable, app.id.replace(/\.desktop$/, '')].filter(Boolean).map(name => name.toLowerCase()));
  return clients.find(client => names.has((client.initialClass || client.class || '').toLowerCase()));
}
export function desktopCards(state) {
  const ids = new Set([state.active.id, ...state.clients.map(client => client.workspace.id)]);
  return [...ids].filter(id => id > 1).sort((a,b) => a-b).map(id => ({
    id, active: id === state.active.id, windows: state.clients.filter(client => client.workspace.id === id)
  }));
}
