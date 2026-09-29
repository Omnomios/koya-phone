// Logical pixels at the phone's 2x compositor scale. No client-side output scaling.
// Inter, bundled as separate static weights (OFL, assets/fonts). postmarketOS
// ships Inter as a .ttc collection, and Koya loads only its first face, so
// a Fontconfig style such as 'Inter:style=SemiBold' would render Regular.
export const FONT = '/rom/assets/fonts/Inter-Regular.ttf';
export const FONT_STRONG = '/rom/assets/fonts/Inter-SemiBold.ttf';
export const WALLPAPER = '/rom/assets/earthy-green-wallpaper.png';
export const WALLPAPER_SIZE = { x: 864, y: 1821 };
export const BAR_HEIGHT = 40;
// 144 physical pixels at 2x is about 9 mm on the OnePlus 6.
export const NAV_HEIGHT = 72;

// Orange and warm cream from the Koya fish, on its deep green background.
export const CREAM = [244/255, 233/255, 216/255, 1];
export const ORANGE = [217/255, 106/255, 29/255, 1];
export const INK = [0.065, 0.13, 0.105, 1];
// Raised surfaces, from quietest to most prominent.
export const CARD = [0.095, 0.18, 0.14, 1];
export const CARD_PRESSED = [0.14, 0.24, 0.19, 1];
export const TONAL = [0.16, 0.25, 0.2, 1];
export const TRACK = [0.2, 0.3, 0.25, 1];
export const MUTED = [0.66, 0.72, 0.66, 1];
export const DISABLED = [0.48, 0.49, 0.44, 1];
export const CLEAR = [0, 0, 0, 0];
export const alpha = (colour, value) => [colour[0], colour[1], colour[2], value];
// Wallpaper tint behind full-screen sheets: dim enough for cream text.
export const SHEET_TINT = [0.15, 0.19, 0.17, 1];

// One spacing scale. GUTTER is the screen edge inset used by every sheet.
export const SPACE = { xs: 4, s: 8, m: 12, l: 16, xl: 24 };
export const GUTTER = 20;
// Tight, consistent corners: controls (buttons, fields, rows, switches) and
// surfaces (cards, banners, panels). Only grabbable handles are fully round:
// the on/off switch and the brightness slider thumb.
export const RADIUS = { control: 4, surface: 6 };
// Text sizes: sheet titles, row titles, body copy and secondary captions.
export const TYPE = { display: 88, title: 30, heading: 21, body: 18, caption: 15 };
// Sheet headers share one height so titles and close buttons line up.
export const HEADER_HEIGHT = 56;
export const TOUCH = 48;
// Trailing icons (close, lock, chevron) centre this far inside the content
// edge, the same as a sheet header's close button, so they form one column.
export const TRAILING_INSET = TOUCH / 2;
