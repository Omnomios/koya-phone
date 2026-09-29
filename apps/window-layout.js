import * as Event from 'Helix/Event';
import * as Log from 'Helix/Log';

// The engine has already resized the surface and reflowed its layout. Only
// application geometry (grid capacity, pagination and artwork crops) is rebuilt.
export function windowLayout(win, apply) {
  let queue = Promise.resolve();
  Event.on('windowResized', event => {
    if (event.id !== win) return;
    queue = queue.then(() => apply({ x: event.width, y: event.height }))
      .catch(error => Log.error('Window layout: ' + error));
  });
}
