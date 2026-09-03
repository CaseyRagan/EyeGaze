/**
 * Working out how big the screen physically is, without asking.
 *
 * Every figure this app reports in degrees is scaled by the physical size of
 * the screen, and the browser will not tell you it: CSS "inches" are defined as
 * 96 CSS pixels and have nothing to do with the glass. So it has always been a
 * number in settings, which people reasonably forget to set — and a wrong one
 * silently rescales every accuracy figure they are shown.
 *
 * Two things are available instead of asking.
 *
 * The first is the device's own pixel geometry. `screen.width * devicePixelRatio`
 * gives the native panel resolution, and for the machines this tool actually
 * runs on — laptops and tablets — that resolution identifies the panel, because
 * manufacturers ship a small number of distinctive ones. A 3024x1964 panel is a
 * 14-inch MacBook Pro and nothing else.
 *
 * The second is a real object. A bank card is 85.60 x 53.98 mm by international
 * standard (ISO/IEC 7810 ID-1) and everyone has one, so a card held against an
 * on-screen rectangle the user resizes to match measures the screen directly.
 * That is exact rather than inferred, and it is the fallback for every panel not
 * in the table — most non-Retina Windows laptops, where 1920x1080 could be a
 * 13-inch or a 17-inch and the pixels cannot say which.
 */

export type ScreenSizeSource = 'device' | 'measured' | 'assumed';

export interface DetectedScreenSize {
  diagonalInches: number;
  source: ScreenSizeSource;
  /** Human-readable, for telling the user what was recognised. */
  label: string;
}

interface KnownPanel {
  /** Native pixels, long edge first. */
  long: number;
  short: number;
  diagonalInches: number;
  label: string;
  /** Restricts the match when a resolution is ambiguous across platforms. */
  platform?: 'apple';
}

/**
 * Panels identified by their native resolution.
 *
 * Apple is over-represented on purpose: its panels come in distinctive
 * resolutions at known pixel densities, so they identify exactly, and they are a
 * large share of the machines in clinics and homes. A Windows laptop at
 * 1920x1080 is deliberately absent — that resolution spans 13 to 17 inches and
 * guessing it would be worse than admitting the guess, because a wrong figure
 * here is invisible and rescales everything downstream.
 */
const KNOWN_PANELS: KnownPanel[] = [
  // MacBook
  { long: 2304, short: 1440, diagonalInches: 12.0, label: '12-inch MacBook', platform: 'apple' },
  { long: 2560, short: 1600, diagonalInches: 13.3, label: '13-inch MacBook', platform: 'apple' },
  { long: 2560, short: 1664, diagonalInches: 13.6, label: '13-inch MacBook Air', platform: 'apple' },
  { long: 2880, short: 1800, diagonalInches: 15.4, label: '15-inch MacBook Pro', platform: 'apple' },
  { long: 2880, short: 1864, diagonalInches: 15.3, label: '15-inch MacBook Air', platform: 'apple' },
  { long: 3024, short: 1964, diagonalInches: 14.2, label: '14-inch MacBook Pro', platform: 'apple' },
  { long: 3072, short: 1920, diagonalInches: 16.0, label: '16-inch MacBook Pro', platform: 'apple' },
  { long: 3456, short: 2234, diagonalInches: 16.2, label: '16-inch MacBook Pro', platform: 'apple' },
  // Desktop displays
  { long: 4480, short: 2520, diagonalInches: 23.5, label: '24-inch iMac', platform: 'apple' },
  { long: 5120, short: 2880, diagonalInches: 27.0, label: '27-inch 5K display', platform: 'apple' },
  { long: 6016, short: 3384, diagonalInches: 32.0, label: 'Pro Display XDR', platform: 'apple' },
  // iPad
  { long: 2160, short: 1620, diagonalInches: 10.2, label: '10.2-inch iPad', platform: 'apple' },
  { long: 2360, short: 1640, diagonalInches: 10.9, label: '11-inch iPad Air', platform: 'apple' },
  { long: 2388, short: 1668, diagonalInches: 11.0, label: '11-inch iPad Pro', platform: 'apple' },
  { long: 2732, short: 2048, diagonalInches: 12.9, label: '12.9-inch iPad Pro', platform: 'apple' },
  { long: 2064, short: 1440, diagonalInches: 11.0, label: '11-inch iPad Pro (M4)', platform: 'apple' },
  { long: 2752, short: 2064, diagonalInches: 13.0, label: '13-inch iPad Pro (M4)', platform: 'apple' },
];

/** Native panel pixels, which is what identifies the panel. */
function nativeResolution(): { long: number; short: number } | null {
  if (typeof window === 'undefined' || !window.screen) return null;
  const ratio = window.devicePixelRatio || 1;
  const w = Math.round((window.screen.width || 0) * ratio);
  const h = Math.round((window.screen.height || 0) * ratio);
  if (w < 200 || h < 200) return null;
  // Sorted, so a tablet held either way round still matches.
  return { long: Math.max(w, h), short: Math.min(w, h) };
}

function looksLikeApple(): boolean {
  if (typeof navigator === 'undefined') return false;
  const platform = `${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`;
  return /Mac|iPhone|iPad|iPod/i.test(platform);
}

export const DEFAULT_DIAGONAL_INCHES = 15.6;

/**
 * Best guess at the physical diagonal, and how much to trust it.
 *
 * Returns the assumed default rather than nothing when the panel is unknown, so
 * callers always have a usable number — but says so, so the interface can ask
 * rather than quietly reporting degrees computed from a guess.
 */
export function detectScreenDiagonalInches(): DetectedScreenSize {
  const native = nativeResolution();
  if (native) {
    const apple = looksLikeApple();
    for (const panel of KNOWN_PANELS) {
      if (panel.platform === 'apple' && !apple) continue;
      // Exact, because these are reported resolutions rather than measurements.
      if (panel.long === native.long && panel.short === native.short) {
        return { diagonalInches: panel.diagonalInches, source: 'device', label: panel.label };
      }
    }
  }

  return {
    diagonalInches: DEFAULT_DIAGONAL_INCHES,
    source: 'assumed',
    label: 'a typical laptop screen',
  };
}

/** The long edge of an ID-1 bank card, in millimetres. */
export const CARD_WIDTH_MM = 85.6;
export const CARD_ASPECT = 85.6 / 53.98;

/**
 * Converts a measured on-screen card width into a screen diagonal.
 *
 * The card measures millimetres per pixel directly, which is the quantity
 * everything downstream actually wants; it is expressed as a diagonal only
 * because that is what the rest of the app stores.
 */
export function diagonalFromCardWidth(cardWidthPx: number): number | null {
  if (!Number.isFinite(cardWidthPx) || cardWidthPx < 40) return null;
  if (typeof window === 'undefined' || !window.screen) return null;

  const mmPerPixel = CARD_WIDTH_MM / cardWidthPx;
  const diagonalPx = Math.hypot(window.screen.width || 0, window.screen.height || 0);
  if (diagonalPx < 1) return null;

  const inches = (mmPerPixel * diagonalPx) / 25.4;
  // Anything outside this is a mis-drag rather than a screen.
  return inches >= 5 && inches <= 60 ? inches : null;
}

/** The on-screen card width, in CSS pixels, implied by a screen diagonal. */
export function cardWidthForDiagonal(diagonalInches: number): number {
  if (typeof window === 'undefined' || !window.screen) return 300;
  const diagonalPx = Math.hypot(window.screen.width || 0, window.screen.height || 0);
  const mmPerPixel = (diagonalInches * 25.4) / (diagonalPx || 1);
  return CARD_WIDTH_MM / mmPerPixel;
}
