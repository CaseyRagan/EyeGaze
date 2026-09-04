import { calibrationEngine } from './calibration';

/**
 * Keeps the mapping honest during play, so nobody has to stop and re-centre.
 *
 * The calibration itself is now good — a recent session cross-validated at 65 px
 * — and the thing that limits a real sitting is no longer the fit but the drift
 * after it. A client reported it exactly: re-centre, play well for about a
 * minute, feel it slide, re-centre again. Head pose compensation removes some of
 * that, and cannot remove all of it, because the small residual gains multiply
 * a posture that keeps changing.
 *
 * The observation that fixes it is that this app already knows where somebody
 * was looking, several times a minute, for free. A dwell only completes when a
 * gaze has been held inside a target for the whole dwell duration — that is
 * about as strong a statement as eye tracking ever gets that a person was
 * looking at a known point. Every completed dwell is therefore a calibration
 * sample nobody had to sit through.
 *
 * The obvious danger is a loop that reinforces its own error, so the correction
 * is deliberately timid, and every guard below exists to stop one bad
 * observation moving anything:
 *
 *   - only completed dwells count, never a near miss
 *   - the median of several is used, so one odd hit cannot steer it
 *   - the observations have to agree with each other in direction, or they are
 *     noise rather than drift and are discarded
 *   - a fraction of the median is applied, not the whole of it
 *   - and the total it may ever accumulate is capped, so no amount of drift
 *     correction can walk away from the calibrated mapping
 *
 * What it will not do is fix a bad calibration. It only ever moves a constant
 * offset; the shape of the mapping is left exactly as the set-up measured it.
 */

interface Observation {
  dx: number;
  dy: number;
}

/** How many completed dwells to gather before acting on them. */
const WINDOW = 7;

/** Below this the offset is sampling noise, not drift. In CSS pixels. */
const NOISE_FLOOR_PX = 10;

/**
 * Above this something other than drift is happening — a client looking at the
 * wrong thing, a knocked laptop lid, a genuine need to recalibrate — and a
 * silent correction would be the wrong answer to all three.
 */
const IMPLAUSIBLE_PX = 180;

/** How much of the measured offset to take per correction. */
const CORRECTION_FRACTION = 0.3;

/**
 * The furthest the automatic correction may ever move the mapping, as a
 * fraction of the screen. Roughly a twelfth: enough for the drift of a long
 * sitting, nowhere near enough to rescue a set-up that was wrong to begin with.
 */
const MAX_TOTAL_NUDGE = 0.08;

/**
 * How many standard errors the measured offset has to clear before it is
 * believed to be drift rather than luck.
 *
 * The first version of this compared the offset against the mean *distance* of
 * the misses, on the theory that misses sharing a direction are drift while
 * scattered ones cancel. They do cancel — but only on average. The median of
 * seven scattered observations has a standard error of its own, and in a check
 * that fed forty evenly scattered hits the ratio test let through 20 px of
 * correction built from nothing but chance.
 *
 * So the offset is compared against its own uncertainty instead, which is the
 * question actually being asked: is this offset larger than the spread of the
 * observations it came from can explain? At two and a half standard errors,
 * scatter is refused and a real, repeated miss in one direction is not.
 */
const SIGNIFICANCE = 2.5;

class DriftGuard {
  private enabled = true;
  private observations: Observation[] = [];
  private appliedX = 0;
  private appliedY = 0;
  private corrections = 0;

  public setEnabled(enabled: boolean) {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) this.observations = [];
  }

  /** Forgets everything. Called when a fresh calibration replaces the old one. */
  public reset() {
    this.observations = [];
    this.appliedX = 0;
    this.appliedY = 0;
    this.corrections = 0;
  }

  /**
   * Report where the gaze sat, on average, during a dwell that completed — and
   * where the target it completed on actually was. Both in viewport pixels.
   */
  public observe(gazeX: number, gazeY: number, targetX: number, targetY: number) {
    if (!this.enabled || !calibrationEngine.isCalibrated()) return;

    const dx = gazeX - targetX;
    const dy = gazeY - targetY;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    if (Math.hypot(dx, dy) > IMPLAUSIBLE_PX) return;

    this.observations.push({ dx, dy });
    if (this.observations.length < WINDOW) return;

    this.applyFrom(this.observations);
    this.observations = [];
  }

  private applyFrom(batch: Observation[]) {
    const median = (values: number[]) => {
      const sorted = [...values].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    };

    const dx = median(batch.map(o => o.dx));
    const dy = median(batch.map(o => o.dy));
    const offset = Math.hypot(dx, dy);
    if (offset < NOISE_FLOOR_PX) return;

    // Is this offset bigger than the spread of the observations it came from can
    // account for? Deviations are taken about the median rather than the mean so
    // that one wild hit inflates the uncertainty — making the batch *less*
    // convincing — instead of dragging the estimate along with it.
    const spread =
      batch.reduce((sum, o) => sum + Math.hypot(o.dx - dx, o.dy - dy), 0) / batch.length;
    const standardError = spread / Math.sqrt(batch.length);
    if (offset < standardError * SIGNIFICANCE) return;

    const width = window.innerWidth;
    const height = window.innerHeight;
    if (width < 1 || height < 1) return;

    const stepX = (-dx / width) * CORRECTION_FRACTION;
    const stepY = (-dy / height) * CORRECTION_FRACTION;

    const nextX = clamp(this.appliedX + stepX, -MAX_TOTAL_NUDGE, MAX_TOTAL_NUDGE);
    const nextY = clamp(this.appliedY + stepY, -MAX_TOTAL_NUDGE, MAX_TOTAL_NUDGE);

    const movedX = nextX - this.appliedX;
    const movedY = nextY - this.appliedY;
    if (movedX === 0 && movedY === 0) return;

    this.appliedX = nextX;
    this.appliedY = nextY;
    this.corrections++;
    calibrationEngine.adjustNudge(movedX, movedY);
  }

  /** What it has done so far, for the diagnostics report. */
  public getState() {
    return {
      corrections: this.corrections,
      appliedXNorm: Number(this.appliedX.toFixed(4)),
      appliedYNorm: Number(this.appliedY.toFixed(4)),
      pending: this.observations.length,
    };
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export const driftGuard = new DriftGuard();
