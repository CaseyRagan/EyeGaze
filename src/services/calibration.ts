import {
  CalibrationAnchor,
  CalibrationModel,
  CalibrationPosture,
  CalibrationQuality,
  CalibrationSample,
  HeadPose,
  Point2D,
  PostureDrift,
  RegressionModel,
  ValidationResult,
} from '../types';
import { median, ridgeSolve, robustInlierIndices, standardiseColumns } from './linalg';
import { viewingGeometry } from './viewingGeometry';

const STORAGE_KEY = 'gazeflow_calibration_v3';

/** Assumed webcam horizontal field of view, for converting image offsets to cm. */
const ASSUMED_HFOV_DEG = 60;

export interface CalibrationPointSpec {
  id: number;
  label: string;
  xPercent: number;
  yPercent: number;
}

/** Quick pass: enough to be usable, not enough to be precise. */
export const QUICK_CALIBRATION_TARGETS: CalibrationPointSpec[] = [
  { id: 1, label: 'top left', xPercent: 15, yPercent: 18 },
  { id: 2, label: 'top right', xPercent: 85, yPercent: 18 },
  { id: 3, label: 'middle', xPercent: 50, yPercent: 50 },
  { id: 4, label: 'bottom left', xPercent: 15, yPercent: 82 },
  { id: 5, label: 'bottom right', xPercent: 85, yPercent: 82 },
];

/** Standard pass. Nine points is the usual clinical compromise. */
export const DEFAULT_CALIBRATION_TARGETS: CalibrationPointSpec[] = [
  { id: 1, label: 'top left', xPercent: 12, yPercent: 15 },
  { id: 2, label: 'top middle', xPercent: 50, yPercent: 15 },
  { id: 3, label: 'top right', xPercent: 88, yPercent: 15 },
  { id: 4, label: 'middle left', xPercent: 12, yPercent: 50 },
  { id: 5, label: 'middle', xPercent: 50, yPercent: 50 },
  { id: 6, label: 'middle right', xPercent: 88, yPercent: 50 },
  { id: 7, label: 'bottom left', xPercent: 12, yPercent: 85 },
  { id: 8, label: 'bottom middle', xPercent: 50, yPercent: 85 },
  { id: 9, label: 'bottom right', xPercent: 88, yPercent: 85 },
];

/** Thirteen points, for when the extra minute is worth the extra precision. */
export const PRECISION_CALIBRATION_TARGETS: CalibrationPointSpec[] = [
  ...DEFAULT_CALIBRATION_TARGETS,
  { id: 10, label: 'upper left quadrant', xPercent: 30, yPercent: 32 },
  { id: 11, label: 'upper right quadrant', xPercent: 70, yPercent: 32 },
  { id: 12, label: 'lower left quadrant', xPercent: 30, yPercent: 68 },
  { id: 13, label: 'lower right quadrant', xPercent: 70, yPercent: 68 },
];

/**
 * Validation points deliberately sit *between* the calibration points. Measuring
 * error at the same places the model was fitted flatters it; measuring between
 * them is what the user's gaze will actually experience.
 */
export const VALIDATION_TARGETS: CalibrationPointSpec[] = [
  { id: 1, label: 'upper left', xPercent: 28, yPercent: 28 },
  { id: 2, label: 'upper right', xPercent: 72, yPercent: 28 },
  { id: 3, label: 'centre', xPercent: 50, yPercent: 50 },
  { id: 4, label: 'lower left', xPercent: 28, yPercent: 72 },
  { id: 5, label: 'lower right', xPercent: 72, yPercent: 72 },
];

/**
 * Builds the design row for one sample.
 *
 * The feature set grows with the number of anchors available, because fitting
 * ten unknowns to five points produces a confident-looking model that is mostly
 * noise. Head pose enters as its own regressor rather than as a hand-tuned
 * constant, so the model only leans on it to the extent the calibration data
 * actually supports.
 */
export function buildFeatureRow(
  gx: number,
  gy: number,
  yaw: number,
  pitch: number,
  tx: number,
  ty: number,
  degree: number
): number[] {
  const row = [1, gx, gy];
  if (degree >= 2) row.push(gx * gy);
  if (degree >= 3) row.push(gx * gx, gy * gy);
  if (degree >= 4) row.push(yaw, pitch, tx, ty);
  return row;
}

export function featureDegreeForAnchorCount(count: number): number {
  if (count >= 9) return 4;
  if (count >= 6) return 3;
  if (count >= 4) return 2;
  return 1;
}

function fitAxis(rows: number[][], targets: number[], lambda: number): number[] | null {
  return ridgeSolve(rows, targets, lambda);
}

function standardiseRows(rows: number[][], featureMean: number[], featureStd: number[]): number[][] {
  return rows.map(row => row.map((v, i) => (i === 0 ? 1 : (v - featureMean[i]) / featureStd[i])));
}

export class CalibrationEngine {
  private model: CalibrationModel = {
    isCalibrated: false,
    nudgeXNorm: 0,
    nudgeYNorm: 0,
  };

  private anchors: Map<string, CalibrationAnchor> = new Map();
  private listeners = new Set<() => void>();

  constructor() {
    this.load();
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit() {
    this.listeners.forEach(l => {
      try {
        l();
      } catch {
        // A listener throwing must not break calibration.
      }
    });
  }

  public getModel(): CalibrationModel {
    return this.model;
  }

  public isCalibrated(): boolean {
    return this.model.isCalibrated && !!this.model.regression;
  }

  public getAnchors(): CalibrationAnchor[] {
    return Array.from(this.anchors.values());
  }

  public reset() {
    this.model = { isCalibrated: false, nudgeXNorm: 0, nudgeYNorm: 0 };
    this.anchors.clear();
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Ignore.
    }
    this.emit();
  }

  public removeAnchor(id: string) {
    this.anchors.delete(id);
    this.refit();
  }

  /**
   * Condenses a dwell's worth of samples into a single anchor, rejecting
   * outliers first. A single instantaneous sample — which is what the previous
   * click-to-calibrate flow captured — is dominated by tremor and by whatever
   * the eye was doing in the 16 ms the click landed on.
   */
  public addAnchorFromSamples(
    id: string,
    xNorm: number,
    yNorm: number,
    samples: CalibrationSample[],
    label?: string
  ): CalibrationAnchor | null {
    if (samples.length === 0) return null;

    const usable = samples.filter(s => s.quality > 0.25);
    const pool = usable.length >= 4 ? usable : samples;

    const gxs = pool.map(s => s.gx);
    const gys = pool.map(s => s.gy);
    const keep = robustInlierIndices([gxs, gys], 2.5);
    if (keep.length === 0) return null;

    const kept = keep.map(i => pool[i]);
    const gx = median(kept.map(s => s.gx));
    const gy = median(kept.map(s => s.gy));

    const dispersion = median(kept.map(s => Math.hypot(s.gx - gx, s.gy - gy)));

    const anchor: CalibrationAnchor = {
      id,
      xNorm,
      yNorm,
      gx,
      gy,
      headYaw: median(kept.map(s => s.headYaw)),
      headPitch: median(kept.map(s => s.headPitch)),
      headTranslateX: median(kept.map(s => s.headTranslateX)),
      headTranslateY: median(kept.map(s => s.headTranslateY)),
      dispersion,
      sampleCount: kept.length,
      label,
      timestamp: Date.now(),
    };

    this.anchors.set(id, anchor);
    this.refit();
    return anchor;
  }

  /**
   * Single-point drift correction.
   *
   * Standard practice in eye tracking: after a client shifts in the chair, one
   * fixation on a known point is enough to re-zero the constant part of the
   * error without redoing the whole calibration. Returns the correction that
   * was applied, in pixels, so the UI can say how far off it had drifted.
   */
  public applyDriftCorrection(
    samples: CalibrationSample[],
    targetXNorm: number,
    targetYNorm: number,
    screenWidth: number,
    screenHeight: number,
    sensitivityX = 1,
    sensitivityY = 1
  ): { dxPx: number; dyPx: number } | null {
    if (!this.model.regression || samples.length === 0) return null;

    const usable = samples.filter(s => s.quality > 0.25);
    const pool = usable.length >= 4 ? usable : samples;
    const keep = robustInlierIndices([pool.map(s => s.gx), pool.map(s => s.gy)], 2.5);
    if (keep.length === 0) return null;
    const kept = keep.map(i => pool[i]);

    const gx = median(kept.map(s => s.gx));
    const gy = median(kept.map(s => s.gy));

    const predicted = this.predictNormalised(
      this.model.regression,
      gx,
      gy,
      median(kept.map(s => s.headYaw)),
      median(kept.map(s => s.headPitch)),
      median(kept.map(s => s.headTranslateX)),
      median(kept.map(s => s.headTranslateY))
    );

    // Match the transform mapToScreen applies, so the correction lands exactly
    // on target even when a comfort sensitivity gain is in use.
    const gainedX = 0.5 + (predicted.x - 0.5) * sensitivityX;
    const gainedY = 0.5 + (predicted.y - 0.5) * sensitivityY;
    const dxNorm = targetXNorm - gainedX;
    const dyNorm = targetYNorm - gainedY;

    // Refuse corrections large enough that something else is wrong — a full
    // recalibration is the honest answer to a half-screen offset.
    if (Math.abs(dxNorm) > 0.25 || Math.abs(dyNorm) > 0.25) return null;

    this.setNudge(dxNorm, dyNorm);
    return { dxPx: dxNorm * screenWidth, dyPx: dyNorm * screenHeight };
  }

  /** Records the head pose that was held during calibration, for drift detection. */
  public recordPosture(headPose: HeadPose) {
    this.model.posture = {
      yaw: headPose.yaw,
      pitch: headPose.pitch,
      roll: headPose.roll,
      translateX: headPose.translateX,
      translateY: headPose.translateY,
      interocularSpan: headPose.interocularSpan,
      distanceCm: headPose.distanceCm,
    };
    this.save();
    this.emit();
  }

  public getPosture(): CalibrationPosture | undefined {
    return this.model.posture;
  }

  public setNudge(xNorm: number, yNorm: number) {
    this.model.nudgeXNorm = xNorm;
    this.model.nudgeYNorm = yNorm;
    this.save();
    this.emit();
  }

  public recordValidation(result: ValidationResult) {
    this.model.validation = result;
    this.save();
    this.emit();
  }

  public getValidation(): ValidationResult | undefined {
    return this.model.validation;
  }

  /** Refits the regression from the current anchors. */
  public refit(): CalibrationModel {
    const anchors = this.getAnchors();

    if (anchors.length < 3) {
      this.model = { ...this.model, isCalibrated: false, regression: undefined, quality: undefined };
      this.save();
      this.emit();
      return this.model;
    }

    const degree = featureDegreeForAnchorCount(anchors.length);
    const regression = this.fitRegression(anchors, degree);

    if (!regression) {
      this.model = { ...this.model, isCalibrated: false, regression: undefined };
      this.save();
      this.emit();
      return this.model;
    }

    this.model = {
      ...this.model,
      isCalibrated: true,
      lastCalibratedAt: Date.now(),
      regression,
      quality: this.computeQuality(anchors, degree),
    };
    this.save();
    this.emit();
    return this.model;
  }

  private fitRegression(anchors: CalibrationAnchor[], degree: number): RegressionModel | null {
    const rawRows = anchors.map(a =>
      buildFeatureRow(a.gx, a.gy, a.headYaw, a.headPitch, a.headTranslateX, a.headTranslateY, degree)
    );
    const { mean: featureMean, std: featureStd } = standardiseColumns(rawRows);
    const rows = standardiseRows(rawRows, featureMean, featureStd);

    // Anchors built from tight, low-dispersion dwells deserve more say. Ridge
    // has no sample weights, so weight by duplicating influence via scaling of
    // both sides of the normal equations.
    const weights = anchors.map(a => {
      const tightness = 1 / (1 + a.dispersion * 12);
      const support = Math.min(1, a.sampleCount / 20);
      return Math.max(0.25, tightness * (0.5 + 0.5 * support));
    });

    const weightedRows = rows.map((row, i) => row.map(v => v * weights[i]));
    const targetsX = anchors.map((a, i) => a.xNorm * weights[i]);
    const targetsY = anchors.map((a, i) => a.yNorm * weights[i]);

    // Ridge strength scales down as evidence accumulates.
    const lambda = 0.02 * (10 / Math.max(4, anchors.length));

    const weightsX = fitAxis(weightedRows, targetsX, lambda);
    const weightsY = fitAxis(weightedRows, targetsY, lambda);
    if (!weightsX || !weightsY) return null;

    const base: RegressionModel = {
      degree,
      weightsX,
      weightsY,
      featureMean,
      featureStd,
      residuals: [],
      kernelSigma: 0.05,
    };

    // Local correction: whatever the global polynomial systematically misses at
    // each anchor gets folded back in near that anchor, and fades to nothing
    // away from the calibrated region so we never extrapolate a correction.
    const residuals = anchors.map((a, i) => {
      const p = this.applyGlobal(base, rows[i]);
      return { gx: a.gx, gy: a.gy, dx: a.xNorm - p.x, dy: a.yNorm - p.y };
    });

    const nearestNeighbourDistances = anchors.map((a, i) => {
      let best = Infinity;
      anchors.forEach((b, j) => {
        if (i === j) return;
        best = Math.min(best, Math.hypot(a.gx - b.gx, a.gy - b.gy));
      });
      return Number.isFinite(best) ? best : 0.05;
    });

    const kernelSigma = Math.max(0.012, Math.min(0.12, median(nearestNeighbourDistances) * 0.8));

    return { ...base, residuals, kernelSigma };
  }

  private applyGlobal(model: RegressionModel, standardisedRow: number[]): Point2D {
    let x = 0;
    let y = 0;
    for (let i = 0; i < standardisedRow.length; i++) {
      x += model.weightsX[i] * standardisedRow[i];
      y += model.weightsY[i] * standardisedRow[i];
    }
    return { x, y };
  }

  /**
   * Leave-one-out error: fit without each anchor, then measure how far off the
   * model lands on it. This is the only calibration number worth showing a
   * clinician, because it is the only one the model could not simply memorise.
   */
  private computeQuality(anchors: CalibrationAnchor[], degree: number): CalibrationQuality {
    const screenW = window.innerWidth;
    const screenH = window.innerHeight;

    let errorSum = 0;
    let counted = 0;

    if (anchors.length >= 5) {
      for (let held = 0; held < anchors.length; held++) {
        const subset = anchors.filter((_, i) => i !== held);
        const subDegree = Math.min(degree, featureDegreeForAnchorCount(subset.length));
        const fitted = this.fitRegression(subset, subDegree);
        if (!fitted) continue;

        const a = anchors[held];
        const predicted = this.predictNormalised(fitted, a.gx, a.gy, a.headYaw, a.headPitch, a.headTranslateX, a.headTranslateY);
        errorSum += Math.hypot((predicted.x - a.xNorm) * screenW, (predicted.y - a.yNorm) * screenH);
        counted++;
      }
    }

    const crossValidatedErrorPx = counted > 0 ? errorSum / counted : 0;

    // Coverage: how much of the screen the anchors actually span.
    const xs = anchors.map(a => a.xNorm);
    const ys = anchors.map(a => a.yNorm);
    const spanX = Math.max(...xs) - Math.min(...xs);
    const spanY = Math.max(...ys) - Math.min(...ys);
    const coverage = Math.max(0, Math.min(1, spanX * spanY / 0.56));

    return {
      crossValidatedErrorPx,
      crossValidatedErrorDeg: viewingGeometry.pixelsToDegrees(crossValidatedErrorPx),
      anchorCount: anchors.length,
      coverage,
    };
  }

  private predictNormalised(
    regression: RegressionModel,
    gx: number,
    gy: number,
    yaw: number,
    pitch: number,
    tx: number,
    ty: number
  ): Point2D {
    const raw = buildFeatureRow(gx, gy, yaw, pitch, tx, ty, regression.degree);
    const standardised = raw.map((v, i) =>
      i === 0 ? 1 : (v - regression.featureMean[i]) / regression.featureStd[i]
    );

    const global = this.applyGlobal(regression, standardised);

    if (regression.residuals.length === 0) return global;

    // Gaussian-weighted local residual correction, scaled by how close the
    // nearest anchor is so it vanishes outside the calibrated region.
    const twoSigmaSq = 2 * regression.kernelSigma * regression.kernelSigma;
    let weightSum = 0;
    let dx = 0;
    let dy = 0;
    let nearestWeight = 0;

    for (const r of regression.residuals) {
      const distSq = (gx - r.gx) * (gx - r.gx) + (gy - r.gy) * (gy - r.gy);
      const w = Math.exp(-distSq / twoSigmaSq);
      weightSum += w;
      dx += w * r.dx;
      dy += w * r.dy;
      if (w > nearestWeight) nearestWeight = w;
    }

    if (weightSum < 1e-6) return global;

    // 0.7 damping keeps the correction from interpolating sampling noise.
    const strength = 0.7 * nearestWeight;
    return {
      x: global.x + (dx / weightSum) * strength,
      y: global.y + (dy / weightSum) * strength,
    };
  }

  /**
   * Maps a frame's eye measurement to a screen position, in pixels.
   * Returns null when there is no usable model, so callers can show an honest
   * "not calibrated" state instead of a plausible-looking guess.
   */
  public mapToScreen(
    gx: number,
    gy: number,
    headPose: HeadPose,
    screenWidth: number,
    screenHeight: number,
    sensitivityX = 1,
    sensitivityY = 1
  ): Point2D | null {
    const regression = this.model.regression;
    if (!regression) return null;

    const p = this.predictNormalised(
      regression,
      gx,
      gy,
      headPose.yaw,
      headPose.pitch,
      headPose.translateX,
      headPose.translateY
    );

    // Sensitivity is a gain about the screen centre, offered as a comfort
    // adjustment for users who cannot comfortably reach the screen edges.
    let nx = 0.5 + (p.x - 0.5) * sensitivityX + this.model.nudgeXNorm;
    let ny = 0.5 + (p.y - 0.5) * sensitivityY + this.model.nudgeYNorm;

    // Clamp generously rather than exactly at the edge, so a user looking just
    // past the screen still produces a stable edge reading.
    nx = Math.max(-0.05, Math.min(1.05, nx));
    ny = Math.max(-0.05, Math.min(1.05, ny));

    return { x: nx * screenWidth, y: ny * screenHeight };
  }

  /**
   * How far the head has moved from where it was during calibration.
   *
   * This is the software half of the answer to "would a head rest help?": on a
   * built-in webcam, lateral head translation is the largest single source of
   * drift, because moving 3 cm sideways at 55 cm changes the eye rotation
   * needed to hit the same screen point by roughly 3 degrees — comparable to
   * the entire error budget of the tracker.
   */
  public getPostureDrift(headPose: HeadPose): PostureDrift | null {
    const posture = this.model.posture;
    if (!posture) return null;

    const distanceCm = headPose.distanceCm ?? posture.distanceCm ?? viewingGeometry.getEffectiveDistanceCm();

    // Normalised image offsets scale into cm through the camera's field of view.
    const cmPerNormUnit = 2 * distanceCm * Math.tan((ASSUMED_HFOV_DEG * Math.PI) / 360);
    const lateralCm = Math.hypot(
      (headPose.translateX - posture.translateX) * cmPerNormUnit,
      (headPose.translateY - posture.translateY) * cmPerNormUnit
    );

    // Apparent eye separation is inversely proportional to distance, which
    // gives a depth estimate that does not depend on the face model.
    let depthCm = 0;
    if (posture.interocularSpan > 1e-5 && headPose.interocularSpan > 1e-5 && posture.distanceCm) {
      const ratio = posture.interocularSpan / headPose.interocularSpan;
      depthCm = posture.distanceCm * (ratio - 1);
    } else if (headPose.distanceCm && posture.distanceCm) {
      depthCm = headPose.distanceCm - posture.distanceCm;
    }

    const rotationDeg =
      (Math.hypot(headPose.yaw - posture.yaw, headPose.pitch - posture.pitch, headPose.roll - posture.roll) * 180) /
      Math.PI;

    // Thresholds chosen so "drifting" fires around the point where error grows
    // by roughly a degree, and "recalibrate" where the mapping stops being fair
    // to the user.
    const lateralScore = Math.max(0, 1 - lateralCm / 6);
    const depthScore = Math.max(0, 1 - Math.abs(depthCm) / 12);
    const rotationScore = Math.max(0, 1 - rotationDeg / 12);
    const stability = lateralScore * 0.45 + depthScore * 0.25 + rotationScore * 0.3;

    let severity: PostureDrift['severity'] = 'good';
    if (lateralCm > 5 || Math.abs(depthCm) > 10 || rotationDeg > 10) severity = 'recalibrate';
    else if (lateralCm > 2.5 || Math.abs(depthCm) > 5 || rotationDeg > 5) severity = 'drifting';

    return { lateralCm, depthCm, rotationDeg, stability, severity };
  }

  /** Grades a validation result against thresholds a clinician can act on. */
  public static gradeAccuracy(accuracyDeg: number): ValidationResult['grade'] {
    if (accuracyDeg <= 1.0) return 'excellent';
    if (accuracyDeg <= 1.75) return 'good';
    if (accuracyDeg <= 3.0) return 'fair';
    return 'poor';
  }

  public exportSession() {
    return {
      exportedAt: new Date().toISOString(),
      model: {
        isCalibrated: this.model.isCalibrated,
        lastCalibratedAt: this.model.lastCalibratedAt,
        quality: this.model.quality,
        posture: this.model.posture,
        validation: this.model.validation,
      },
      anchors: this.getAnchors(),
      viewingGeometry: viewingGeometry.getSettings(),
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  }

  private save() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ model: this.model, anchors: Array.from(this.anchors.entries()) })
      );
    } catch {
      // Ignore.
    }
  }

  private load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed?.model) {
        this.model = { nudgeXNorm: 0, nudgeYNorm: 0, ...parsed.model };
      }
      if (Array.isArray(parsed?.anchors)) {
        this.anchors = new Map(parsed.anchors);
      }
    } catch {
      // Corrupt storage: start uncalibrated rather than half-calibrated.
      this.model = { isCalibrated: false, nudgeXNorm: 0, nudgeYNorm: 0 };
      this.anchors.clear();
    }
  }
}

export const calibrationEngine = new CalibrationEngine();
