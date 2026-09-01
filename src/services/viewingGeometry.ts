/**
 * Converts between screen pixels and degrees of visual angle.
 *
 * Eye-tracking accuracy is meaningless in pixels alone — 40 px of error is
 * excellent on a 27" monitor at arm's length and poor on a 13" laptop at 40 cm.
 * Every accuracy number this app reports to a clinician is therefore also
 * expressed in degrees, using:
 *
 *   - the physical screen size, derived from a user-supplied diagonal, and
 *   - the viewing distance, measured live from the face model when available.
 *
 * Both are estimates. The UI labels them as such rather than implying a
 * laboratory-grade measurement.
 */

const STORAGE_KEY = 'gazeflow_viewing_geometry_v1';

export interface ViewingGeometrySettings {
  /** Physical screen diagonal in inches. */
  screenDiagonalInches: number;
  /** Viewing distance in cm, used when live measurement is unavailable. */
  assumedDistanceCm: number;
  /** When true, the live face-model distance overrides the assumed distance. */
  useMeasuredDistance: boolean;
}

const DEFAULTS: ViewingGeometrySettings = {
  // 15.6" is the most common built-in laptop panel, which is this app's
  // primary target hardware.
  screenDiagonalInches: 15.6,
  assumedDistanceCm: 55,
  useMeasuredDistance: true,
};

class ViewingGeometry {
  private settings: ViewingGeometrySettings = { ...DEFAULTS };
  private measuredDistanceCm: number | null = null;

  constructor() {
    this.load();
  }

  public getSettings(): ViewingGeometrySettings {
    return { ...this.settings };
  }

  public updateSettings(patch: Partial<ViewingGeometrySettings>) {
    this.settings = { ...this.settings, ...patch };
    this.save();
  }

  /** Called by the tracker with the live face-model distance estimate. */
  public setMeasuredDistanceCm(distanceCm: number | null) {
    this.measuredDistanceCm =
      distanceCm !== null && Number.isFinite(distanceCm) && distanceCm > 15 && distanceCm < 200
        ? distanceCm
        : null;
  }

  public getMeasuredDistanceCm(): number | null {
    return this.measuredDistanceCm;
  }

  /** The distance actually used for conversions, in cm. */
  public getEffectiveDistanceCm(): number {
    if (this.settings.useMeasuredDistance && this.measuredDistanceCm !== null) {
      return this.measuredDistanceCm;
    }
    return this.settings.assumedDistanceCm;
  }

  public isDistanceMeasured(): boolean {
    return this.settings.useMeasuredDistance && this.measuredDistanceCm !== null;
  }

  /**
   * Millimetres per CSS pixel, from the physical diagonal and the screen's
   * pixel diagonal. Uses the full screen rather than the window so the value
   * does not change when the window is resized.
   */
  public getMillimetresPerPixel(): number {
    const w = window.screen?.width || window.innerWidth;
    const h = window.screen?.height || window.innerHeight;
    const diagonalPx = Math.hypot(w, h) || 1;
    const diagonalMm = this.settings.screenDiagonalInches * 25.4;
    return diagonalMm / diagonalPx;
  }

  /** Converts a pixel distance on screen into degrees of visual angle. */
  public pixelsToDegrees(pixels: number): number {
    const mm = pixels * this.getMillimetresPerPixel();
    const distanceMm = this.getEffectiveDistanceCm() * 10;
    if (distanceMm <= 0) return 0;
    return (2 * Math.atan(mm / (2 * distanceMm)) * 180) / Math.PI;
  }

  public degreesToPixels(degrees: number): number {
    const distanceMm = this.getEffectiveDistanceCm() * 10;
    const mm = 2 * distanceMm * Math.tan((degrees * Math.PI) / 360);
    return mm / this.getMillimetresPerPixel();
  }

  private save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings));
    } catch {
      // Storage unavailable (private browsing); defaults still work.
    }
  }

  private load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) this.settings = { ...DEFAULTS, ...JSON.parse(raw) };
    } catch {
      // Ignore malformed storage.
    }
  }
}

export const viewingGeometry = new ViewingGeometry();
