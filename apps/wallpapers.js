// Bundled, generated artwork. Dimensions are source pixels, not UI pixels.
export const WALLPAPERS = [
  { id: 'earthy-green', name: 'Earthy green', texture: '/rom/assets/earthy-green-wallpaper.png', size: { x: 864, y: 1821 } },
  { id: 'tidal-blue', name: 'Tidal blue', texture: '/rom/assets/wallpapers/tidal-blue.png', size: { x: 863, y: 1822 } },
  { id: 'terracotta-dunes', name: 'Terracotta dunes', texture: '/rom/assets/wallpapers/terracotta-dunes.png', size: { x: 863, y: 1823 } },
  { id: 'violet-dusk', name: 'Violet dusk', texture: '/rom/assets/wallpapers/violet-dusk.png', size: { x: 863, y: 1823 } }
];
export const wallpaperFor = id => WALLPAPERS.find(item => item.id === id) || WALLPAPERS[0];

// Centre-crop to fill, preserving the artwork's aspect ratio on any display.
export function wallpaperFrame(wallpaper, size, colour = [1, 1, 1, 1]) {
  const scale = Math.max(size.x / wallpaper.size.x, size.y / wallpaper.size.y);
  const crop = { x: size.x / scale, y: size.y / scale };
  const min = { x: (wallpaper.size.x - crop.x) / 2, y: (wallpaper.size.y - crop.y) / 2 };
  return { size, origin: { x: 0, y: 0 }, aabb: { min, max: { x: min.x + crop.x, y: min.y + crop.y } }, colour };
}
