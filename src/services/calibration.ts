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
import {
  correlation,
  median,
  ridgeSolve,
  robustInlierIndices,
  standardDeviation,
  standardiseColumns,
} from './linalg';
import { viewingGeometry } from './viewingGeometry';

// v4: the gaze features changed meaning when the two image axes were put in the
// same unit — vertical shrank by the aspect ratio and translateY with it. A model
// fitted before that is not merely stale, it is wrong in a way nothing downstream
// could detect, so old ones are dropped rather than loaded.
const STORAGE_KEY = 'gazeflow_calibration_v6';

/**
 * Whether the eyelid vertical cue may enter the mapping. It may not.
 *
 * The cue was added because the iris feature's vertical range collapses when the
 * upper lid covers the top of the iris, and on a synthetic eye tuned to a real
 * session's measured sensitivity ratios it recovered that range convincingly —
 * vertical reach 30% to 85%, cross-validated error 260px to 100px.
 *
 * On real faces it made things worse, twice, at two camera heights. Scored on
 * check points the model was never fitted on:
 *
 *   camera on the desk    with the cue 8.56°   without 4.22°
 *   camera at eye level   with the cue 3.41°   without 2.86°
 *
 * The lower camera is much the worse case, which fits the mechanism: a camera
 * below eye level sees more eyelid, and this cue is read from the eye region.
 *
 * The reason it is a hard-off rather than a guarded option is the second half of
 * that measurement. Leave-one-out — the selector built specifically to refuse a
 * cue that was not earning its place — preferred the cue in both sessions, and
 * not narrowly: 162px against 275px, and 143px against 264px. It is not merely
 * insensitive to this failure, it is anti-correlated with it. Nine anchors from
 * one continuous minute share their posture drift and their lid contamination,
 * so holding one out and predicting it from its neighbours rewards exactly the
 * extra freedom that does not survive to the check a minute later.
 *
 * So there is currently no in-app evidence that could justify switching this on,
 * which is why it is a constant and not a setting. The feature extraction, the
 * recording and the replay variant all stay, because that is what would produce
 * such evidence: `bun run replay <file>` scores every session both ways.
 */
let EYELID_CUE_ENABLED = false;

/**
 * Switches the cue on for the offline harnesses only — the check scenario that
 * proves the mechanism still works, and the replay variant that scores a real
 * session both ways. Nothing in the app calls this.
 */
export function setEyelidCueEnabled(enabled: boolean) {
  EYELID_CUE_ENABLED = enabled;
}

/** Whether the eyelid cue is currently allowed into the mapping. */
export function isEyelidCueEnabled(): boolean {
  return EYELID_CUE_ENABLED;
}

/** Kernel width for the local correction, as a fraction of anchor spacing. */
const KERNEL_SIGMA_FACTOR = 0.55;

/**
 * How much better a richer feature set has to cross-validate before it is
 * preferred over a simpler one. Two models within 5% of each other are within
 * the noise of a nine-point grid, and the simpler one behaves better outside it.
 */
const MODEL_UPGRADE_MARGIN = 0.95;

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

  const rotationX = FEATURE_UNITS_PER_RADIAN * gain.rotationX;
  const rotationY = FEATURE_UNITS_PER_RADIAN * gain.rotationY;
  const translation = FEATURE_UNITS_PER_TRANSLATION * gain.translation;

  return {
    gx: gx + rotationX * dYaw + translation * dTx,
    gy: gy - rotationY * dPitch + translation * dTy,
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
  /** Multiplier on the nominal constant for horizontal, yaw-driven compensation. */
  rotationX: number;
  /**
   * And for vertical, pitch-driven compensation — measured separately, because
   * it is not the same number.
   *
   * The eyelid follows the eye vertically. Look down and the lid comes down with
   * you, so the visible iris is clipped and its centre is dragged back toward
   * the middle of the aperture; the vertical feature therefore under-responds to
   * vertical eye rotation in a way the horizontal one does not. Measured on the
   * movement pass across three recorded sessions, the horizontal gain came back
   * at 0.68, 0.65 and 0.83 while the vertical came back at -0.22, -0.25 and
   * -0.10. Consistent, reproducible, and nothing like each other.
   *
   * Averaging them into one figure meant applying a horizontally-derived number
   * to the vertical axis. In a session whose whole error was a 6.5° drift in
   * head pitch, that is the one place it could do most harm.
   */
  rotationY: number;
  translation: number;
}

const NOMINAL_HEAD_GAIN: HeadGain = { rotationX: 1, rotationY: 1, translation: 1 };

/** Below this spread in the anchors, head gain cannot be identified from them. */
const MIN_YAW_SPREAD = 0.02;
const MIN_TRANSLATION_SPREAD = 0.006;

/**
 * Above this correlation between a rotation axis and its translation partner,
 * the two cannot be told apart and no attempt is made to. 0.9 leaves room for
 * the deliberately mixed movement the coverage ring asks for while catching the
 * near-lockstep of an ordinary head turn.
 */
const MAX_SEPARABLE_CORRELATION = 0.9;

/**
 * How strongly head pose has to track the targets before the compensation stops
 * being applied. Below the first figure the two are separable enough to trust;
 * above the second they are the same measurement wearing different labels.
 */
const ALIAS_SAFE = 0.4;
const ALIAS_BLIND = 0.75;



export interface CalibrationPointSpec {
  id: number;
  label: string;
  xPercent: number;
  yPercent: number;
}

/** Quick pass: enough to be usable, not enough to be precise. */
export const QUICK_CALIBRATION_TARGETS: CalibrationPointSpec[] = [
  { id: 1, label: 'top left', xPercent: 12, yPercent: 12 },
  { id: 2, label: 'top right', xPercent: 88, yPercent: 12 },
  { id: 3, label: 'middle', xPercent: 50, yPercent: 50 },
  { id: 4, label: 'bottom left', xPercent: 12, yPercent: 88 },
  { id: 5, label: 'bottom right', xPercent: 88, yPercent: 88 },
];

/**
 * Standard pass. Nine points is the usual clinical compromise.
 *
 * The top row sits at 20% rather than 15% because the instruction line is
 * centred near the top of the screen, and at 15% the top-middle target landed
 * directly behind it — the one point on the grid the client could not see. The
 * bottom row matches at 80% so the grid stays symmetric about the centre; the
 * cost is about four percent of the calibrated area, against a point that was
 * being captured from someone hunting for a dot hidden under a sentence.
 */
export const DEFAULT_CALIBRATION_TARGETS: CalibrationPointSpec[] = [
  { id: 1, label: 'top left', xPercent: 10, yPercent: 10 },
  { id: 2, label: 'top middle', xPercent: 50, yPercent: 10 },
  { id: 3, label: 'top right', xPercent: 90, yPercent: 10 },
  { id: 4, label: 'middle left', xPercent: 10, yPercent: 50 },
  { id: 5, label: 'middle', xPercent: 50, yPercent: 50 },
  { id: 6, label: 'middle right', xPercent: 90, yPercent: 50 },
  { id: 7, label: 'bottom left', xPercent: 10, yPercent: 90 },
  { id: 8, label: 'bottom middle', xPercent: 50, yPercent: 90 },
  { id: 9, label: 'bottom right', xPercent: 90, yPercent: 90 },
];

/** Thirteen points, for when the extra minute is worth the extra precision. */
export const PRECISION_CALIBRATION_TARGETS: CalibrationPointSpec[] = [
  ...DEFAULT_CALIBRATION_TARGETS,
  { id: 10, label: 'upper left quadrant', xPercent: 30, yPercent: 30 },
  { id: 11, label: 'upper right quadrant', xPercent: 70, yPercent: 30 },
  { id: 12, label: 'lower left quadrant', xPercent: 30, yPercent: 70 },
  { id: 13, label: 'lower right quadrant', xPercent: 70, yPercent: 70 },
];

/**
 * The order the dots are shown in, which is not the order they are listed in.
 *
 * Listed spatially — left to right, top to bottom — they were also *captured*
 * that way, and in every recorded session the capture order and the screen row
 * correlate at +0.95. That makes the passage of time and the vertical position
 * of the target very nearly the same variable, and anything that drifts over
 * the minute of set-up is then indistinguishable from a genuine effect of
 * looking up or down. Head pitch is exactly such a thing: measured across three
 * sessions it correlated with capture order at -0.82, +0.47 and +0.87 — and the
 * sign flips, which is how you know it is posture drift rather than physics.
 * Whatever the client's neck happened to do that minute was being fitted into
 * the vertical mapping as though it were gaze.
 *
 * So each row appears early, in the middle, and late. For the nine-point grid
 * the middle row takes positions 0, 4 and 8, the top row 1, 5 and 6, the bottom
 * row 2, 3 and 7 — every row averaging position 4, and the columns balanced the
 * same way. A steady drift in any direction now averages out of every row
 * equally instead of tilting the mapping.
 *
 * The centre goes first for a second reason: it is the one target that asks for
 * no eccentric gaze at all, so it is captured while the client is still square
 * on, and it is the anchor the whole mapping pivots around. Consecutive points
 * are also far apart, which makes each move a real saccade rather than a drift
 * along a row.
 */
const CAPTURE_ORDER: Record<number, number[]> = {
  5: [3, 1, 5, 4, 2],
  9: [5, 3, 7, 9, 4, 2, 1, 8, 6],
  13: [5, 3, 7, 13, 10, 9, 4, 1, 11, 12, 2, 8, 6],
};

/** The grid, resequenced for capture. Unknown sizes are left alone. */
export function inCaptureOrder(targets: CalibrationPointSpec[]): CalibrationPointSpec[] {
  const order = CAPTURE_ORDER[targets.length];
  if (!order) return targets;
  const byId = new Map(targets.map(t => [t.id, t]));
  const ordered = order.map(id => byId.get(id)).filter((t): t is CalibrationPointSpec => !!t);
  // A mismatch between the table and the grid must not silently drop a point.
  return ordered.length === targets.length ? ordered : targets;
}

/**
 * Validation points deliberately sit *between* the calibration points. Measuring
 * error at the same places the model was fitted flatters it; measuring between
 * them is what the user's gaze will actually experience.
 *
 * They also have to span enough of the screen to be worth measuring. These used
 * to sit at 28% and 72%, covering the middle 44% of the height — and a session
 * whose vertical mapping reached only half way to its targets still came back at
 * 3.0°, because inside a band that narrow even a badly compressed mapping lands
 * close. The person testing it could see the problem on screen
 * while every number said the set-up was fine. Widened to 20/80, they still sit
 * clear of the 10/50/90 grid but now cover most of what anyone actually uses.
 */
export const VALIDATION_TARGETS: CalibrationPointSpec[] = [
  { id: 1, label: 'upper left', xPercent: 22, yPercent: 20 },
  { id: 2, label: 'upper right', xPercent: 78, yPercent: 20 },
  { id: 3, label: 'centre', xPercent: 50, yPercent: 50 },
  { id: 4, label: 'lower left', xPercent: 22, yPercent: 80 },
  { id: 5, label: 'lower right', xPercent: 78, yPercent: 80 },
];

/**
 * Builds the design row for one sample, from an already head-compensated
 * feature.
 *
 * The first terms are the polynomial in gx and gy. The last, when the camera
 * supplies it, is the eyelid vertical cue — a second opinion on the vertical
 * axis from the landmarker's eyeLookUp/eyeLookDown outputs, which fail
 * differently from the iris landmarks and so cover for them where the lid hides
 * the iris. It is a column rather than a blend so that each person's own
 * calibration decides how much it is worth.
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
export function buildFeatureRow(
  gx: number,
  gy: number,
  degree: number,
  lidGy: number | null = null
): number[] {
  const row = [1, gx, gy];
  if (degree >= 2) row.push(gx * gy);
  if (degree >= 3) row.push(gx * gx, gy * gy);
  // Appended last so a model fitted without it stays readable position by
  // position, and so the polynomial terms keep their existing meaning.
  if (lidGy !== null) row.push(lidGy);
  return row;
}

export function featureDegreeForAnchorCount(count: number): number {
  if (count >= 6) return 3;
  if (count >= 4) return 2;
  return 1;
}

/** How many free parameters per axis a given feature degree costs. */
export function parameterCountForDegree(degree: number, usesLidCue = false): number {
  return buildFeatureRow(0, 0, degree, usesLidCue ? 0 : null).length;
}

/**
 * Which feature sets are worth trying for a given number of anchors, simplest
 * first.
 *
 * Affordability is judged against the leave-one-out fit, not the full one: a
 * model that only becomes determined when every anchor is present cannot be
 * cross-validated, so its reported error would be a guess. Requiring one spare
 * point beyond the parameter count means each candidate is still overdetermined
 * with one anchor held out, and the number we choose on is real.
 */
export function candidateDegrees(count: number, usesLidCue = false): number[] {
  const affordable = [1, 2, 3].filter(
    d => count - 1 >= parameterCountForDegree(d, usesLidCue) + 1
  );
  return affordable.length > 0 ? affordable : [1];
}

/**
 * Median eyelid cue over a set of samples, or null if none of them carried one.
 * Samples missing the cue are skipped rather than counted as zero, which would
 * drag the median toward a value nobody measured.
 */
function medianLidGy(samples: Array<{ lidGy: number | null }>): number | null {
  const present = samples
    .map(s => s.lidGy)
    .filter((v): v is number => v !== null && Number.isFinite(v));
  return present.length > 0 ? median(present) : null;
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

  private featureDegreeOverride: number | null = null;
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
      lidGy: medianLidGy(kept),
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
      median(kept.map(s => s.headTranslateY)),
      medianLidGy(kept)
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

      const degree = this.model.regression?.degree ?? featureDegreeForAnchorCount(anchors.length);
      const errors = this.leaveOneOutErrors(
        anchors,
        degree,
        this.model.regression?.usesLidCue ?? false
      );
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

  /** Per-anchor leave-one-out error in pixels, for one candidate feature set. */
  private leaveOneOutErrors(
    anchors: CalibrationAnchor[],
    degree: number,
    allowLidCue: boolean
  ): Array<{ id: string; errorPx: number }> {
    if (anchors.length < 5) return [];

    const screenW = window.innerWidth;
    const screenH = window.innerHeight;
    const results: Array<{ id: string; errorPx: number }> = [];

    for (let held = 0; held < anchors.length; held++) {
      const subset = anchors.filter((_, i) => i !== held);
      const reference: FeaturePosture = {
        yaw: median(subset.map(a => a.headYaw)),
        pitch: median(subset.map(a => a.headPitch)),
        translateX: median(subset.map(a => a.headTranslateX)),
        translateY: median(subset.map(a => a.headTranslateY)),
      };
      const fitted = this.fitWithGain(
        subset,
        degree,
        reference,
        this.model.headGain ?? NOMINAL_HEAD_GAIN,
        allowLidCue
      );
      if (!fitted) continue;

      const a = anchors[held];
      const p = this.predictNormalised(
        fitted,
        a.gx,
        a.gy,
        a.headYaw,
        a.headPitch,
        a.headTranslateX,
        a.headTranslateY,
        a.lidGy
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

  /**
   * Moves the constant offset by a small amount, rather than replacing it.
   *
   * setNudge is absolute because a manual re-centre recomputes the whole offset
   * from one fresh fixation. Continuous drift correction is the opposite: many
   * tiny observations, each nudging what is already there. Keeping them separate
   * means neither has to know about the other, and a manual re-centre still
   * wipes the slate exactly as it always did.
   */
  public adjustNudge(dxNorm: number, dyNorm: number) {
    if (!Number.isFinite(dxNorm) || !Number.isFinite(dyNorm)) return;
    this.setNudge(this.model.nudgeXNorm + dxNorm, this.model.nudgeYNorm + dyNorm);
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

    const shape = this.selectModelShape(anchors);
    const degree = shape.degree;
    const regression = this.fitRegression(anchors, degree, shape.useLidCue);

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
      quality: this.computeQuality(anchors, degree, shape.useLidCue),
    };
    this.save();
    this.emit();
    return this.model;
  }

  /**
   * Picks the feature set by cross-validation rather than by anchor count.
   *
   * The count only says what can be fitted, not what is worth fitting. Nine
   * anchors afford a six-parameter surface, but if the person's eyes really do
   * move linearly with the target, those extra three parameters spend
   * themselves on measurement noise: the fit through the calibration points
   * looks better while predictions between them get worse. That failure is
   * invisible in the on-screen check, which lands on the same points that were
   * fitted, and shows up as a client whose cursor is accurate at the nine dots
   * and wrong everywhere else.
   *
   * Leave-one-out error is the test that separates the two, so each candidate
   * is scored with it and the simplest one wins ties. A richer surface has to
   * beat the simpler one by a clear margin — 5% — because two models within
   * noise of each other are not two models, and the simpler one extrapolates
   * far more gracefully past the edge of the calibrated region.
   */
  /**
   * Overrides the measured head gain.
   *
   * Exists for the session replay, which scores a recording under alternative
   * models — including no head compensation at all, which is the only way to
   * tell whether the compensation earned its place on a particular client.
   */
  public setHeadGain(gain: HeadGain) {
    this.model.headGain = gain;
    this.model.headGainMeasured = true;
    this.refit();
  }

  /**
   * Forces a feature set instead of choosing one, or null to choose again.
   *
   * Exists so the regression check can measure what the alternatives would
   * actually have scored on held-out points, rather than trusting that
   * leave-one-out picked well. Nothing in the app sets it.
   */
  public overrideFeatureDegree(degree: number | null) {
    this.featureDegreeOverride = degree;
    this.refit();
  }

  /** Cross-validated error for each feature set that was considered, for diagnostics. */
  public getFeatureDegreeScores(): Array<{ degree: number; looErrorPx: number }> {
    const anchors = this.getAnchors();
    const useLidCue = this.model.regression?.usesLidCue ?? false;
    return candidateDegrees(anchors.length).map(degree => {
      const errors = this.leaveOneOutErrors(anchors, degree, useLidCue);
      return {
        degree,
        looErrorPx:
          errors.length > 0 ? errors.reduce((sum, e) => sum + e.errorPx, 0) / errors.length : NaN,
      };
    });
  }

  private selectModelShape(anchors: CalibrationAnchor[]): { degree: number; useLidCue: boolean } {
    const hasCue =
      EYELID_CUE_ENABLED && anchors.every(a => a.lidGy !== null && Number.isFinite(a.lidGy));
    const shapes: Array<{ degree: number; useLidCue: boolean }> = [];
    for (const degree of candidateDegrees(anchors.length)) {
      shapes.push({ degree, useLidCue: false });
      if (hasCue) shapes.push({ degree, useLidCue: true });
    }

    let best = shapes[0];
    let bestError = Infinity;

    for (const shape of shapes) {
      if (this.featureDegreeOverride !== null && shape.degree !== this.featureDegreeOverride) continue;

      const errors = this.leaveOneOutErrors(anchors, shape.degree, shape.useLidCue);
      // Too few anchors to cross-validate at all: fall back to the count rule.
      if (errors.length === 0) {
        return { degree: featureDegreeForAnchorCount(anchors.length), useLidCue: false };
      }

      const mean = errors.reduce((sum, e) => sum + e.errorPx, 0) / errors.length;
      if (!Number.isFinite(mean)) continue;
      if (mean < bestError * MODEL_UPGRADE_MARGIN) {
        best = shape;
        bestError = mean;
      }
    }

    return best;
  }


  /**
   * How much of the nominal head compensation is safe to apply.
   *
   * The docs have long said the head gain cannot be *measured* from an ordinary
   * calibration grid, because each screen position is seen at exactly one head
   * pose and the two explanations for a moved eye are aliased. The corollary went
   * unnoticed for far longer: it cannot safely be *applied* to that grid either.
   *
   * People turn their head toward whatever they look at. In a recorded session,
   * head yaw against target x came back at r = -0.87 — so subtracting a head
   * term from the feature subtracts most of the gaze signal along with it, and
   * the regression has to fight its own input to get back to where it started.
   * Sweeping the multiplier on that session, held-out error rose monotonically
   * with every increase: 4.32° with no compensation, 5.27° at full nominal
   * strength. Compensation was costing a degree.
   *
   * So the compensation is only applied to the extent it is trustworthy:
   *
   * - measured by the head-movement pass, which holds the target still and
   *   therefore breaks the aliasing by construction — trusted in full;
   * - not measured, and the grid shows head pose tracking the target — not
   *   applied, because it cannot be told apart from the thing being fitted;
   * - not measured, but the head genuinely stayed put relative to the targets —
   *   applied, since there is nothing for it to be confused with.
   *
   * Nothing is lost in the case that matters. Head compensation exists for
   * movement *after* set-up, and when the pose is aliased with the targets the
   * regression has already absorbed that person's head behaviour into its own
   * weights.
   */
  private aliasTrust(anchors: CalibrationAnchor[]): number {
    if (this.model.headGainMeasured) return 1;
    if (anchors.length < 5) return 0;

    const worst = Math.max(
      Math.abs(correlation(anchors.map(a => a.headYaw), anchors.map(a => a.xNorm))),
      Math.abs(correlation(anchors.map(a => a.headPitch), anchors.map(a => a.yNorm)))
    );

    // Fades out rather than switching, so a grid that is only mildly aliased
    // still gets most of the compensation it deserves.
    if (worst <= ALIAS_SAFE) return 1;
    if (worst >= ALIAS_BLIND) return 0;
    return (ALIAS_BLIND - worst) / (ALIAS_BLIND - ALIAS_SAFE);
  }

  private fitRegression(
    anchors: CalibrationAnchor[],
    degree: number,
    allowLidCue: boolean
  ): RegressionModel | null {
    // The reference posture is the average head position across the anchors, so
    // compensation is zero at the posture the client actually calibrated in and
    // the fit is unchanged for someone who does not move.
    const reference: FeaturePosture = {
      yaw: median(anchors.map(a => a.headYaw)),
      pitch: median(anchors.map(a => a.headPitch)),
      translateX: median(anchors.map(a => a.headTranslateX)),
      translateY: median(anchors.map(a => a.headTranslateY)),
    };

    const raw = this.model.headGain ?? NOMINAL_HEAD_GAIN;
    const trust = this.aliasTrust(anchors);
    const effective: HeadGain = {
      rotationX: raw.rotationX * trust,
      rotationY: raw.rotationY * trust,
      translation: raw.translation * trust,
    };

    return this.fitWithGain(anchors, degree, reference, effective, allowLidCue);
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

    /**
     * Rotation and translation are only separable if the client's head did them
     * separately, and a neck does not oblige.
     *
     * You rotate about your neck, not about your eyeballs, so turning your head
     * by dθ also slides your eyes sideways by roughly ten centimetres times dθ.
     * The two regressors therefore arrive almost perfectly correlated, and with
     * the rotation term carrying about eight times the leverage of the
     * translation term, least squares can trade a small change in one against a
     * large change in the other at almost no cost in residual. The split it
     * returns is then arbitrary — and it is applied to every prediction
     * afterwards, so an arbitrary split is not a harmless one. A field report
     * showed exactly this: rotation pushed outside its plausible range and
     * silently replaced by the fallback, translation left at 0.507, and the
     * accuracy check afterwards 2.4x worse than the calibration grid it was
     * fitted on.
     *
     * When the two move together, only their combined effect is real. Fitting
     * the rotation term alone recovers that, attributes it to the term with the
     * leverage, and leaves translation at the nominal constant — which is a
     * worse model of a pure sideways slide than a good split would be, and a far
     * better one than a split invented from collinear data.
     */
    const yawTxCorrelation = Math.abs(
      correlation(usable.map(s => s.headYaw), usable.map(s => s.headTranslateX))
    );
    const pitchTyCorrelation = Math.abs(
      correlation(usable.map(s => s.headPitch), usable.map(s => s.headTranslateY))
    );
    const horizontalSeparable = yawTxCorrelation < MAX_SEPARABLE_CORRELATION;
    const verticalSeparable = pitchTyCorrelation < MAX_SEPARABLE_CORRELATION;

    // Horizontal: observed gx = constant - k_rot*yaw - k_trans*tx
    const horizontal = ridgeSolve(
      usable.map(s => (horizontalSeparable ? [1, s.headYaw, s.headTranslateX] : [1, s.headYaw])),
      usable.map(s => s.gx),
      1e-6
    );
    // Vertical: observed gy = constant + k_rot*pitch - k_trans*ty
    const vertical = ridgeSolve(
      usable.map(s => (verticalSeparable ? [1, s.headPitch, s.headTranslateY] : [1, s.headPitch])),
      usable.map(s => s.gy),
      1e-6
    );
    if (!horizontal || !vertical) return null;

    const translationEstimates: Array<{ value: number; weight: number }> = [];
    if (horizontalSeparable && txSpread >= MIN_TRANSLATION_SPREAD) {
      translationEstimates.push({ value: -horizontal[2], weight: txSpread });
    }
    if (verticalSeparable && tySpread >= MIN_TRANSLATION_SPREAD) {
      translationEstimates.push({ value: -vertical[2], weight: tySpread });
    }

    /**
     * Averages the axis estimates — but only the ones that are individually
     * believable.
     *
     * The horizontal and vertical estimates are separate physical measurements
     * of very different quality. Horizontal is easy: the eye sweeps a wide arc
     * and the iris stays fully visible. Vertical is not, because the lid covers
     * the iris as the eye rolls up and down, so the same nod produces a smaller
     * and dirtier signal.
     *
     * Averaging them regardless is how a good measurement gets destroyed by a
     * bad one. On a recorded session the horizontal estimate came back at 0.65 —
     * perfectly plausible — and the vertical at -0.25, which is not a person,
     * it is a failed measurement. Their weighted mean was 0.20, below the
     * plausible floor, so the whole pass was written off and the run fell back
     * to textbook constants it did not need to.
     *
     * An estimate outside the plausible range is therefore discarded as a
     * failure on that axis rather than folded into the answer for the other.
     */
    const combine = (estimates: Array<{ value: number; weight: number }>, nominal: number) => {
      const believable = estimates.filter(e => {
        const ratio = e.value / nominal;
        return ratio >= 0.3 && ratio <= 3;
      });
      if (believable.length === 0) return 1;
      const total = believable.reduce((sum, e) => sum + e.weight, 0);
      const value = believable.reduce((sum, e) => sum + e.value * e.weight, 0) / total;
      return value / nominal;
    };

    /**
     * One axis, one plausible range.
     *
     * Horizontal is a well-conditioned measurement — the eye sweeps a wide arc
     * with the iris fully visible — so a figure far from the textbook constant
     * there is a failed measurement, and the nominal value is the safer answer.
     * Vertical is not: the lid clips the iris as the eye rolls, so the feature
     * genuinely under-responds and a small, or slightly negative, gain is the
     * honest result rather than a broken one. Three recorded sessions returned
     * -0.22, -0.25 and -0.10 for it. Holding vertical to the horizontal range
     * would reject all three and substitute a 1 that none of them support.
     */
    const axisGain = (
      slope: number,
      spread: number,
      range: { min: number; max: number }
    ): number => {
      if (spread < MIN_YAW_SPREAD) return 1;
      const ratio = slope / FEATURE_UNITS_PER_RADIAN;
      return ratio >= range.min && ratio <= range.max ? ratio : 1;
    };

    const gain: HeadGain = {
      rotationX: axisGain(-horizontal[1], yawSpread, { min: 0.3, max: 3 }),
      rotationY: axisGain(vertical[1], pitchSpread, { min: -0.5, max: 3 }),
      translation: combine(translationEstimates, FEATURE_UNITS_PER_TRANSLATION),
    };

    this.model.headGain = gain;
    // Exactly nominal on both axes is the fallback, not a measurement, and a
    // fallback must not buy the trust that breaking the aliasing earns.
    this.model.headGainMeasured =
      gain.rotationX !== 1 || gain.rotationY !== 1 || gain.translation !== 1;
    this.refit();
    return gain;
  }

  private fitWithGain(
    anchors: CalibrationAnchor[],
    degree: number,
    reference: FeaturePosture,
    gain: HeadGain,
    allowLidCue: boolean
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

    // The cue is only a column if every anchor has it. A column that is present
    // for some anchors and absent for others would have to be filled in for the
    // rest, and an invented value is indistinguishable from a measured one once
    // it is in the matrix.
    // The cue is only a column if every anchor has it. A column that is present
    // for some anchors and absent for others would have to be filled in for the
    // rest, and an invented value is indistinguishable from a measured one once
    // it is in the matrix.
    const usesLidCue =
      allowLidCue && anchors.every(a => a.lidGy !== null && Number.isFinite(a.lidGy));

    /*
     * Handed over raw, not orthogonalised — which was tried, and measured, and
     * was wrong.
     *
     * The concern was real: the cue and the iris feature are both measuring
     * vertical gaze, so they are strongly correlated, and two collinear columns
     * let a fit satisfy the data with a large positive weight on one and a large
     * negative weight on the other, amplifying the noise in both. That is what
     * the first shipped version looked like from the outside — vertical reach
     * went from 50% to 100-120%, and vertical error and frame-to-frame wobble
     * went up with it.
     *
     * So the obvious repair was to give the regression only the part of the cue
     * the iris could not already predict. On the lidded synthetic eye that
     * moved cross-validated error from 260px to 257px and recovered none of the
     * lost range, against 260px to 100px for the raw column, which recovered it
     * all. The reason is plain in hindsight: what the cue is *for* is that its
     * vertical range does not collapse, and projecting out everything the iris
     * already explains removes precisely that, leaving only curvature.
     *
     * The protection against the collinear failure is therefore not to weaken
     * the column but to decline it — see selectModelShape, which fits both ways
     * and keeps the cue only when holding an anchor out says it earns its place.
     */
    const lidOf = (i: number) => (usesLidCue ? (anchors[i].lidGy as number) : null);

    const rawRows = compensated.map((c, i) => buildFeatureRow(c.gx, c.gy, degree, lidOf(i)));
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
      usesLidCue,
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
  private computeQuality(
    anchors: CalibrationAnchor[],
    degree: number,
    useLidCue: boolean
  ): CalibrationQuality {
    const looErrors = this.leaveOneOutErrors(anchors, degree, useLidCue);
    const crossValidatedErrorPx =
      looErrors.length > 0 ? looErrors.reduce((sum, e) => sum + e.errorPx, 0) / looErrors.length : 0;

    // Coverage: how much of the screen the anchors actually span.
    const xs = anchors.map(a => a.xNorm);
    const ys = anchors.map(a => a.yNorm);
    const spanX = Math.max(...xs) - Math.min(...xs);
    const spanY = Math.max(...ys) - Math.min(...ys);
    // Against the full grid's own span, so a complete set-up reads 1.00 and
    // anything less — a pruned point, a reduced working area — reads honestly
    // below it. Tied to the grid rather than left at an older constant, which
    // would have quietly reported 1.00 for every session once the grid widened.
    const FULL_GRID_SPAN = 0.8 * 0.8;
    const coverage = Math.max(0, Math.min(1, (spanX * spanY) / FULL_GRID_SPAN));

    return {
      crossValidatedErrorPx,
      crossValidatedErrorDeg: viewingGeometry.pixelsToDegrees(crossValidatedErrorPx),
      featureDegree: degree,
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
    ty: number,
    lidGy: number | null = null
  ): Point2D {
    const reference = regression.reference;
    const compensated = compensateForHead(
      gx,
      gy,
      { yaw, pitch, translateX: tx, translateY: ty },
      reference,
      regression.headGain
    );

    // A model fitted with the cue needs a value for it on every prediction. If
    // the cue drops out mid-session — a frame where the landmarker emits no
    // blendshapes — the column falls back to the value it was centred on, which
    // is the fitted mean, so the term contributes nothing rather than lurching.
    const lidColumn = regression.usesLidCue
      ? lidGy !== null && Number.isFinite(lidGy)
        ? lidGy
        : // The cue withdrew — a lid on its way down, or a camera that stopped
          // supplying it. Standing the column at its fitted mean makes the term
          // contribute nothing, so the vertical estimate falls back on the iris
          // rather than lurching on a value nobody measured.
          regression.featureMean[regression.featureMean.length - 1]
      : null;

    const raw = buildFeatureRow(compensated.gx, compensated.gy, regression.degree, lidColumn);
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
    lidGy: number | null,
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
      headPose.translateY,
      lidGy
    );

    // Depth compensation.
    //
    // A screen point sitting X cm to the side of straight ahead demands an eye
    // rotation of atan(X / D). Move nearer and the same rotation now points at
    // a *closer* spot, so the whole mapping has to shrink toward the centre by
    // the ratio of the distances — and stretch when the client leans back.
    //
    // This was previously measured, reported as "drifting", and then not acted
    // on, which is a poor combination: leaning in by 10 cm from a 50 cm
    // calibration throws the estimate outward by a fifth of the way to the
    // screen edge, and the client is told they have moved without being told
    // what it costs or having it corrected.
    //
    // The ratio comes from apparent eye separation rather than the absolute
    // distance estimate. Distance in centimetres depends on assumed camera
    // optics and can be wrong by a large factor; the *ratio* of two eye
    // separations is a direct measurement that cancels all of that.
    const depthScale = this.getDepthScale(headPose);

    // Sensitivity is a gain about the screen centre, offered as a comfort
    // adjustment for users who cannot comfortably reach the screen edges.
    let nx = 0.5 + (p.x - 0.5) * sensitivityX * depthScale + this.model.nudgeXNorm;
    let ny = 0.5 + (p.y - 0.5) * sensitivityY * depthScale + this.model.nudgeYNorm;

    // Clamp generously rather than exactly at the edge, so a user looking just
    // past the screen still produces a stable edge reading.
    nx = Math.max(-0.05, Math.min(1.05, nx));
    ny = Math.max(-0.05, Math.min(1.05, ny));

    return { x: nx * screenWidth, y: ny * screenHeight };
  }

  /**
   * How much to shrink or stretch the mapping for a change in viewing distance
   * since calibration. 1 means the client is where they calibrated.
   *
   * Clamped hard: beyond this range the measurement is more likely to be a
   * tracking failure than a person who has genuinely moved that far, and a
   * runaway scale factor would be worse than no correction at all.
   */
  private getDepthScale(headPose: HeadPose): number {
    const posture = this.model.posture;
    if (!posture || posture.interocularSpan < 1e-5 || headPose.interocularSpan < 1e-5) return 1;

    const scale = posture.interocularSpan / headPose.interocularSpan;
    if (!Number.isFinite(scale)) return 1;
    return Math.max(0.65, Math.min(1.5, scale));
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
