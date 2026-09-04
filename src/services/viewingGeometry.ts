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

import { DEFAULT_DIAGONAL_INCHES, ScreenSizeSource, detectScreenDiagonalInches } from './screenSize';

export interface ViewingGeometrySettings {
  /** Physical screen diagonal in inches. */
  screenDiagonalInches: number;
  /**
   * Where that diagonal came from, so the interface can tell the difference
   * between a figure it recognised, one the user measured, and a placeholder.
   * A wrong diagonal is invisible — it rescales every number reported in
   * degrees without anything looking broken — so a guess has to announce itself.
   */
  screenSizeSource: ScreenSizeSource;
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
  /**
   * Fraction of the window used for targets and activities, 0.5 to 1.
   *
   * Shrinking the working area is the answer for someone who cannot sit further
   * back, and for a client whose eyes genuinely cannot make large excursions —
   * a restricted motility, a palsy, or simply fatigue late in a session.
   * Everything stays reachable; it just occupies less of the glass.
   */
  workingAreaScale: number;
}

const DEFAULTS: ViewingGeometrySettings = {
  // 15.6" is the most common built-in laptop panel, which is this app's
  // primary target hardware. Overridden at startup whenever the panel is one
  // this machine can recognise.
  screenDiagonalInches: DEFAULT_DIAGONAL_INCHES,
  screenSizeSource: 'assumed',
  assumedDistanceCm: 55,
  useMeasuredDistance: true,
  distanceScale: 1,
  workingAreaScale: 1,
};

/** Below this agreement between the two estimates, the measurement is not used. */
const MIN_DISTANCE_AGREEMENT = 0.5;

/**
 * How quickly the held distance follows a real change, in milliseconds. Short
 * enough that leaning in is reflected almost at once, long enough that the
 * frame-to-frame wander in the estimate stops reaching the reported figures.
 */
const DISTANCE_TIME_CONSTANT_MS = 400;

/**
 * The most weight any single reading may carry, expressed as the longest gap it
 * is allowed to claim credit for. About a frame and a half at 30 Hz.
 */
const MAX_DISTANCE_STEP_MS = 50;

class ViewingGeometry {
  private settings: ViewingGeometrySettings = { ...DEFAULTS };
  private measuredDistanceCm: number | null = null;
  private lastDistanceAt: number | null = null;
  private measurementAgreement = 0;

  constructor() {
    this.load();
    this.adoptDetectedScreenSize();
  }

  /**
   * Takes the detected panel size unless the user has already settled the
   * question.
   *
   * Only overwrites a placeholder. Once someone has measured their screen with
   * a card, or typed a figure themselves, that is the answer — a later guess
   * from a resolution table must not quietly replace it.
   */
  private adoptDetectedScreenSize() {
    if (this.settings.screenSizeSource !== 'assumed') return;
    const detected = detectScreenDiagonalInches();
    if (detected.source === 'assumed') return;
    this.settings = {
      ...this.settings,
      screenDiagonalInches: detected.diagonalInches,
      screenSizeSource: detected.source,
    };
    this.save();
  }

  public getSettings(): ViewingGeometrySettings {
    return { ...this.settings };
  }

  public updateSettings(patch: Partial<ViewingGeometrySettings>) {
    this.settings = { ...this.settings, ...patch };
    this.save();
  }

  /**
   * Called by the tracker with the live distance estimate and its confidence.
   *
   * Two things happen here that did not before, and both come from the same
   * observation: a person's distance from their screen changes over seconds,
   * and this estimate was changing every frame.
   *
   * A withheld reading is *held*, not cleared. The tracker stops offering a
   * distance whenever an eye is too closed to measure the iris, which is the
   * honest thing for it to do and happens fifteen times a minute. Treating that
   * as "distance unknown" would drop the reading back to the assumed default on
   * every blink, which is a worse lie than the stale value: somebody who has not
   * moved has not stopped being 44 cm away because they blinked.
   *
   * And what is accepted is smoothed. Even with the eyes open the frame-to-frame
   * estimate wanders, and every figure reported in degrees is scaled by it — one
   * recorded session stored 42.9 cm and the next, a minute later, 71.4 cm, which
   * made two runs of the same set-up incomparable for reasons that had nothing
   * to do with the tracking. The time constant is short enough that genuinely
   * leaning in shows up within about half a second.
   */
  public setMeasuredDistanceCm(distanceCm: number | null, agreement = 0, now = Date.now()) {
    const valid =
      distanceCm !== null && Number.isFinite(distanceCm) && distanceCm > 15 && distanceCm < 200;
    if (!valid) return;

    // Capped, because a gap in the readings means *less* evidence, not more.
    // Without this, the first frame after a blink arrives 200 ms after the last
    // accepted one and is handed 40% of the weight — so the one frame most
    // likely to still be contaminated by a half-open lid would get more
    // authority than any clean frame, which is precisely backwards.
    const sinceLast = this.lastDistanceAt === null ? MAX_DISTANCE_STEP_MS : now - this.lastDistanceAt;
    const elapsedMs = Math.min(Math.max(0, sinceLast), MAX_DISTANCE_STEP_MS);
    this.lastDistanceAt = now;

    if (this.measuredDistanceCm === null) {
      this.measuredDistanceCm = distanceCm;
      this.measurementAgreement = agreement;
      return;
    }

    // Frame-rate independent, so the response feels the same on a slow machine.
    const weight = 1 - Math.exp(-elapsedMs / DISTANCE_TIME_CONSTANT_MS);
    this.measuredDistanceCm += (distanceCm - this.measuredDistanceCm) * weight;
    this.measurementAgreement += (agreement - this.measurementAgreement) * weight;
  }

  /** Forgets the held distance, for a genuine restart rather than a blink. */
  public clearMeasuredDistance() {
    this.measuredDistanceCm = null;
    this.measurementAgreement = 0;
    this.lastDistanceAt = null;
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

  /**
   * The distance actually used for conversions, in cm.
   *
   * A live measurement is used whenever there is one, including when the two
   * underlying estimates disagree. That is a change: disagreement used to fall
   * back to the assumed figure in settings, on the reasoning that a measurement
   * the app cannot vouch for is worse than a default. It is not — the default is
   * a number nobody chose, fixed at 55 cm, and substituting it means a client
   * who really is at 40 cm gets every figure rescaled by a third with no
   * indication anything happened.
   *
   * Disagreement is real information, but it is information about *how much* to
   * trust the number, not about whether to use it. It is reported as confidence
   * instead, and the interface asks for a tape measure.
   */
  public getEffectiveDistanceCm(): number {
    const measured = this.getMeasuredDistanceCm();
    if (this.settings.useMeasuredDistance && measured !== null) return measured;
    return this.settings.assumedDistanceCm;
  }

  public isDistanceMeasured(): boolean {
    return this.settings.useMeasuredDistance && this.getMeasuredDistanceCm() !== null;
  }

  /** How far the reported distance can be trusted. */
  public getDistanceConfidence(): 'good' | 'uncertain' | 'assumed' {
    if (!this.isDistanceMeasured()) return 'assumed';
    return this.measurementAgreement >= MIN_DISTANCE_AGREEMENT ? 'good' : 'uncertain';
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

  /** The working area's size and offset within the window, in pixels. */
  public getWorkingArea(): { left: number; top: number; width: number; height: number } {
    const scale = Math.max(0.5, Math.min(1, this.settings.workingAreaScale));
    const width = window.innerWidth * scale;
    const height = window.innerHeight * scale;
    return {
      left: (window.innerWidth - width) / 2,
      top: (window.innerHeight - height) / 2,
      width,
      height,
    };
  }

  /**
   * Half the angle the working area subtends at the eye, horizontally.
   *
   * This is the single most useful number for predicting whether tracking will
   * work, and it is not obvious from either the distance or the screen size
   * alone. Sitting close to a large window means the eyes have to rotate a long
   * way to reach the edges, and webcam iris tracking falls apart well before
   * the eye runs out of travel: past roughly 20 degrees the iris is partly
   * hidden behind the eyelids and the inner corner, its visible outline turns
   * elliptical, and the landmark estimate that everything else is built on
   * stops being reliable. People also stop rotating their eyes that far and
   * start turning their heads instead, which breaks a different assumption.
   */
  public getViewportHalfAngleDeg(): number {
    const halfWidthMm = (this.getWorkingArea().width * this.getMillimetresPerPixel()) / 2;
    const distanceMm = this.getEffectiveDistanceCm() * 10;
    if (distanceMm <= 0) return 0;
    return (Math.atan(halfWidthMm / distanceMm) * 180) / Math.PI;
  }

  /** How far back you would have to sit to keep within `maxHalfAngleDeg`. */
  public getDistanceForHalfAngleCm(maxHalfAngleDeg: number): number {
    const halfWidthMm = (this.getWorkingArea().width * this.getMillimetresPerPixel()) / 2;
    return halfWidthMm / Math.tan((maxHalfAngleDeg * Math.PI) / 180) / 10;
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
