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
  /**
   * Correction applied to the raw measured distance.
   *
   * Both distance estimates divide by an assumed camera field of view, and
   * webcams vary enough that the raw figure can be out by a factor of two or
   * more. One measurement from the user with a tape measure anchors it, after
   * which relative changes track correctly and the absolute value is real.
   */
  distanceScale: number;
}

const DEFAULTS: ViewingGeometrySettings = {
  // 15.6" is the most common built-in laptop panel, which is this app's
  // primary target hardware.
  screenDiagonalInches: 15.6,
  assumedDistanceCm: 55,
  useMeasuredDistance: true,
  distanceScale: 1,
};

/** Below this agreement between the two estimates, the measurement is not used. */
const MIN_DISTANCE_AGREEMENT = 0.5;

class ViewingGeometry {
  private settings: ViewingGeometrySettings = { ...DEFAULTS };
  private measuredDistanceCm: number | null = null;
  private measurementAgreement = 0;

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

  /** Called by the tracker with the live distance estimate and its confidence. */
  public setMeasuredDistanceCm(distanceCm: number | null, agreement = 0) {
    const valid =
      distanceCm !== null && Number.isFinite(distanceCm) && distanceCm > 15 && distanceCm < 200;
    this.measuredDistanceCm = valid ? distanceCm : null;
    this.measurementAgreement = valid ? agreement : 0;
  }

  /** The raw measurement, before the user's correction. */
  public getRawMeasuredDistanceCm(): number | null {
    return this.measuredDistanceCm;
  }

  /** The measurement after the user's correction, or null if unusable. */
  public getMeasuredDistanceCm(): number | null {
    if (this.measuredDistanceCm === null) return null;
    return this.measuredDistanceCm * this.settings.distanceScale;
  }

  /** How closely the two independent estimates agreed, 0-1. */
  public getMeasurementAgreement(): number {
    return this.measurementAgreement;
  }

  /**
   * Anchors the distance estimate to a real measurement. The user reports how
   * far they actually are; everything after that is scaled to match.
   */
  public calibrateDistance(actualCm: number): boolean {
    if (this.measuredDistanceCm === null || actualCm < 20 || actualCm > 150) return false;
    const scale = actualCm / this.measuredDistanceCm;
    if (!Number.isFinite(scale) || scale < 0.2 || scale > 5) return false;
    this.updateSettings({ distanceScale: scale });
    return true;
  }

  /** The distance actually used for conversions, in cm. */
  public getEffectiveDistanceCm(): number {
    const measured = this.getMeasuredDistanceCm();
    if (
      this.settings.useMeasuredDistance &&
      measured !== null &&
      this.measurementAgreement >= MIN_DISTANCE_AGREEMENT
    ) {
      return measured;
    }
    return this.settings.assumedDistanceCm;
  }

  public isDistanceMeasured(): boolean {
    return (
      this.settings.useMeasuredDistance &&
      this.getMeasuredDistanceCm() !== null &&
      this.measurementAgreement >= MIN_DISTANCE_AGREEMENT
    );
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
