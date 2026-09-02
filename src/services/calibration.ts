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
import { median, ridgeSolve, robustInlierIndices, standardDeviation, standardiseColumns } from './linalg';
import { viewingGeometry } from './viewingGeometry';

const STORAGE_KEY = 'gazeflow_calibration_v3';

/** Kernel width for the local correction, as a fraction of anchor spacing. */
const KERNEL_SIGMA_FACTOR = 0.55;

/** Assumed webcam horizontal field of view, for converting image offsets to cm. */
const ASSUMED_HFOV_DEG = 60;

/**
 * Feature units per radian of eye rotation.
 *
 * The gaze feature is the iris centre's offset from the eye's centre divided by
 * the eye's corner-to-corner width, so rotating the eye by θ moves it by
 * (eyeball radius / eye width)·sin θ. Adult anatomy puts that ratio near
 * 12 mm / 30 mm.
 */
const FEATURE_UNITS_PER_RADIAN = 0.4;

/**
 * Feature units per unit of normalised head translation in the image.
 *
 * Shifting the head sideways by `t` image units at distance d moves it
 * t·2d·tan(fov/2) centimetres, which requires an extra eye rotation of
 * t·2·tan(fov/2) radians to keep fixating the same point. The distance cancels,
 * so this is a constant.
 */
const FEATURE_UNITS_PER_TRANSLATION =
  FEATURE_UNITS_PER_RADIAN * 2 * Math.tan((ASSUMED_HFOV_DEG * Math.PI) / 360);

/** The head pose a set of features was measured at. */
export interface FeaturePosture {
  yaw: number;
  pitch: number;
  translateX: number;
  translateY: number;
}

/**
 * Undoes the effect of head movement on the eye measurement, relative to the
 * posture held during calibration.
 *
 * This has to happen *before* the polynomial rather than as an additive term
 * after it. Head movement shifts the measurement itself: to keep fixating the
 * same point while the head turns, the eye rotates back by the same angle, so
 * the observed feature is the one the client would have produced looking
 * somewhere else entirely. Feeding that shifted value through a curved mapping
 * and then adding a correction cannot recover the right answer, because the
 * curvature has already been applied at the wrong place.
 *
 * The constants come from anatomy and camera geometry rather than from the
 * calibration data, so this works even when the client held perfectly still
 * during set-up and the fit therefore learned nothing about head movement. The
 * regression's own head terms then absorb whatever these constants get wrong.
 */
export function compensateForHead(
  gx: number,
  gy: number,
  posture: FeaturePosture,
  reference: FeaturePosture,
  gain: HeadGain
): { gx: number; gy: number } {
  const dYaw = posture.yaw - reference.yaw;
  const dPitch = posture.pitch - reference.pitch;
  const dTx = posture.translateX - reference.translateX;
  const dTy = posture.translateY - reference.translateY;

  const rotation = FEATURE_UNITS_PER_RADIAN * gain.rotation;
  const translation = FEATURE_UNITS_PER_TRANSLATION * gain.translation;

  return {
    gx: gx + rotation * dYaw + translation * dTx,
    gy: gy - rotation * dPitch + translation * dTy,
  };
}

/**
 * Multipliers on the nominal compensation constants.
 *
 * The nominal values come from average anatomy and an assumed camera field of
 * view, and both vary between people and machines — eyeball radius relative to
 * palpebral width differs, and webcam optics differ more than that. When the
 * calibration data contains enough head movement to identify them, these are
 * fitted; otherwise they stay at 1 and the nominal constants are used as-is.
 */
export interface HeadGain {
  rotation: number;
  translation: number;
}

const NOMINAL_HEAD_GAIN: HeadGain = { rotation: 1, translation: 1 };

/** Below this spread in the anchors, head gain cannot be identified from them. */
const MIN_YAW_SPREAD = 0.02;
const MIN_TRANSLATION_SPREAD = 0.006;



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
 * Builds the design row for one sample, from an already head-compensated
 * feature.
 *
 * The last pair of terms is the difference between what the two eyes report.
 * Averaging them 50/50 and discarding the difference throws away information:
 * the two eyes carry partly independent landmark noise, and real faces are not
 * symmetric — one eye is often slightly further from the camera, or more
 * occluded, or simply shaped differently. Handing the difference to the
 * regression lets it find the weighting that actually predicts this person's
 * gaze, rather than assuming the two eyes deserve equal say.
 *
 * The polynomial's job is only the eye-to-screen relationship. Head pose is
 * handled entirely by compensateForHead, upstream of this, and deliberately
 * does not appear here as an additive output term: an additive term after a
 * curved mapping cannot undo an offset applied before it, and having both a
 * feature-space compensation and an output-space correction competing for the
 * same signal leaves each of them underdetermined.
 *
 * The feature set still grows with the number of anchors, because fitting six
 * unknowns to four points produces a confident-looking model that is mostly
 * noise.
 */
export function buildFeatureRow(gx: number, gy: number, degree: number): number[] {
  const row = [1, gx, gy];
  if (degree >= 2) row.push(gx * gy);
  if (degree >= 3) row.push(gx * gx, gy * gy);
  return row;
}

export function featureDegreeForAnchorCount(count: number): number {
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

  /**
   * Drops calibration points the rest of the grid disagrees with, then refits.
   *
   * A least-squares fit spreads one bad point's error across the whole surface,
   * so a single moment where the client blinked, looked away, or was still
   * travelling when the capture began degrades accuracy everywhere — not just
   * near that point. Leave-one-out error identifies such a point cleanly: fit
   * without it, and see how far the rest of the grid thinks it should be.
   *
   * At most two are removed. Beyond that the problem is the session, not the
   * points, and quietly deleting half the grid would hide that.
   */
  public pruneOutlierAnchors(): { removed: string[]; improvedFrom: number; improvedTo: number } {
    const removed: string[] = [];
    const before = this.model.quality?.crossValidatedErrorPx ?? 0;

    for (let round = 0; round < 2; round++) {
      const anchors = this.getAnchors();
      if (anchors.length <= 5) break;

      const errors = this.leaveOneOutErrors(anchors);
      if (errors.length === 0) break;

      const magnitudes = errors.map(e => e.errorPx);
      const typical = median(magnitudes);
      let worstIndex = 0;
      for (let i = 1; i < errors.length; i++) {
        if (errors[i].errorPx > errors[worstIndex].errorPx) worstIndex = i;
      }
      const worst = errors[worstIndex];

      // Both tests have to fire: a point that is merely the worst of a tight
      // set is not an outlier, and a large error that the whole grid shares is
      // a bad session rather than a bad point.
      const isOutlier = worst.errorPx > typical * 2.5 && worst.errorPx > window.innerHeight * 0.08;
      if (!isOutlier) break;

      this.anchors.delete(worst.id);
      removed.push(worst.id);
      this.refit();
    }

    return {
      removed,
      improvedFrom: before,
      improvedTo: this.model.quality?.crossValidatedErrorPx ?? 0,
    };
  }

  /** Per-anchor leave-one-out error in pixels. */
  private leaveOneOutErrors(anchors: CalibrationAnchor[]): Array<{ id: string; errorPx: number }> {
    if (anchors.length < 5) return [];

    const screenW = window.innerWidth;
    const screenH = window.innerHeight;
    const results: Array<{ id: string; errorPx: number }> = [];

    for (let held = 0; held < anchors.length; held++) {
      const subset = anchors.filter((_, i) => i !== held);
      const degree = featureDegreeForAnchorCount(subset.length);
      const reference: FeaturePosture = {
        yaw: median(subset.map(a => a.headYaw)),
        pitch: median(subset.map(a => a.headPitch)),
        translateX: median(subset.map(a => a.headTranslateX)),
        translateY: median(subset.map(a => a.headTranslateY)),
      };
      const fitted = this.fitWithGain(subset, degree, reference, this.model.headGain ?? NOMINAL_HEAD_GAIN);
      if (!fitted) continue;

      const a = anchors[held];
      const p = this.predictNormalised(
        fitted,
        a.gx,
        a.gy,
        a.headYaw,
        a.headPitch,
        a.headTranslateX,
        a.headTranslateY
      );
      results.push({
        id: a.id,
        errorPx: Math.hypot((p.x - a.xNorm) * screenW, (p.y - a.yNorm) * screenH),
      });
    }

    return results;
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
      quality: this.computeQuality(anchors),
    };
    this.save();
    this.emit();
    return this.model;
  }

  private fitRegression(anchors: CalibrationAnchor[], degree: number): RegressionModel | null {
    // The reference posture is the average head position across the anchors, so
    // compensation is zero at the posture the client actually calibrated in and
    // the fit is unchanged for someone who does not move.
    const reference: FeaturePosture = {
      yaw: median(anchors.map(a => a.headYaw)),
      pitch: median(anchors.map(a => a.headPitch)),
      translateX: median(anchors.map(a => a.headTranslateX)),
      translateY: median(anchors.map(a => a.headTranslateY)),
    };

    return this.fitWithGain(anchors, degree, reference, this.model.headGain ?? NOMINAL_HEAD_GAIN);
  }

  /**
   * Measures how much this person's eyes move in response to head movement,
   * from a pass where they held their gaze on one point while moving their head.
   *
   * This cannot be recovered from the ordinary calibration grid: there, each
   * screen position is seen at exactly one head pose, so the effect of head
   * movement is perfectly aliased with the effect of looking somewhere else.
   * Holding the target fixed removes the ambiguity — every bit of variation in
   * the measurement is then head-driven, and a plain regression recovers the
   * two coefficients directly.
   *
   * Returns the fitted gain, or null when the pass did not contain enough
   * head movement to measure anything.
   */
  public fitHeadGainFromMotionPass(samples: CalibrationSample[]): HeadGain | null {
    const usable = samples.filter(s => s.quality > 0.3);
    if (usable.length < 25) return null;

    const yawSpread = standardDeviation(usable.map(s => s.headYaw));
    const pitchSpread = standardDeviation(usable.map(s => s.headPitch));
    const txSpread = standardDeviation(usable.map(s => s.headTranslateX));
    const tySpread = standardDeviation(usable.map(s => s.headTranslateY));

    const rotationSpread = Math.max(yawSpread, pitchSpread);
    const translationSpread = Math.max(txSpread, tySpread);
    if (rotationSpread < MIN_YAW_SPREAD && translationSpread < MIN_TRANSLATION_SPREAD) return null;

    // Horizontal: observed gx = constant - k_rot*yaw - k_trans*tx
    const horizontal = ridgeSolve(
      usable.map(s => [1, s.headYaw, s.headTranslateX]),
      usable.map(s => s.gx),
      1e-6
    );
    // Vertical: observed gy = constant + k_rot*pitch - k_trans*ty
    const vertical = ridgeSolve(
      usable.map(s => [1, s.headPitch, s.headTranslateY]),
      usable.map(s => s.gy),
      1e-6
    );
    if (!horizontal || !vertical) return null;

    const rotationEstimates: Array<{ value: number; weight: number }> = [];
    const translationEstimates: Array<{ value: number; weight: number }> = [];

    if (yawSpread >= MIN_YAW_SPREAD) rotationEstimates.push({ value: -horizontal[1], weight: yawSpread });
    if (pitchSpread >= MIN_YAW_SPREAD) rotationEstimates.push({ value: vertical[1], weight: pitchSpread });
    if (txSpread >= MIN_TRANSLATION_SPREAD) translationEstimates.push({ value: -horizontal[2], weight: txSpread });
    if (tySpread >= MIN_TRANSLATION_SPREAD) translationEstimates.push({ value: -vertical[2], weight: tySpread });

    const combine = (estimates: Array<{ value: number; weight: number }>, nominal: number) => {
      if (estimates.length === 0) return 1;
      const total = estimates.reduce((sum, e) => sum + e.weight, 0);
      const value = estimates.reduce((sum, e) => sum + e.value * e.weight, 0) / total;
      const ratio = value / nominal;
      // Anything outside this range is a measurement failure rather than an
      // unusual person, so fall back to the nominal constant rather than
      // trusting it.
      return ratio >= 0.3 && ratio <= 3 ? ratio : 1;
    };

    const gain: HeadGain = {
      rotation: combine(rotationEstimates, FEATURE_UNITS_PER_RADIAN),
      translation: combine(translationEstimates, FEATURE_UNITS_PER_TRANSLATION),
    };

    this.model.headGain = gain;
    this.refit();
    return gain;
  }

  private fitWithGain(
    anchors: CalibrationAnchor[],
    degree: number,
    reference: FeaturePosture,
    gain: HeadGain
  ): RegressionModel | null {
    const compensated = anchors.map(a =>
      compensateForHead(
        a.gx,
        a.gy,
        { yaw: a.headYaw, pitch: a.headPitch, translateX: a.headTranslateX, translateY: a.headTranslateY },
        reference,
        gain
      )
    );

    const rawRows = compensated.map(c => buildFeatureRow(c.gx, c.gy, degree));
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
      reference,
      headGain: gain,
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
    // Residuals are indexed by the *compensated* feature, which is the space
    // predictions are looked up in.
    const residuals = anchors.map((a, i) => {
      const p = this.applyGlobal(base, rows[i]);
      return { gx: compensated[i].gx, gy: compensated[i].gy, dx: a.xNorm - p.x, dy: a.yNorm - p.y };
    });

    const nearestNeighbourDistances = compensated.map((a, i) => {
      let best = Infinity;
      compensated.forEach((b, j) => {
        if (i === j) return;
        best = Math.min(best, Math.hypot(a.gx - b.gx, a.gy - b.gy));
      });
      return Number.isFinite(best) ? best : 0.05;
    });

    const kernelSigma = Math.max(0.012, Math.min(0.12, median(nearestNeighbourDistances) * KERNEL_SIGMA_FACTOR));

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
  private computeQuality(anchors: CalibrationAnchor[]): CalibrationQuality {
    const looErrors = this.leaveOneOutErrors(anchors);
    const crossValidatedErrorPx =
      looErrors.length > 0 ? looErrors.reduce((sum, e) => sum + e.errorPx, 0) / looErrors.length : 0;

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
    const reference = regression.reference;
    const compensated = compensateForHead(
      gx,
      gy,
      { yaw, pitch, translateX: tx, translateY: ty },
      reference,
      regression.headGain
    );

    const raw = buildFeatureRow(compensated.gx, compensated.gy, regression.degree);
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
      const distSq =
        (compensated.gx - r.gx) * (compensated.gx - r.gx) + (compensated.gy - r.gy) * (compensated.gy - r.gy);
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
