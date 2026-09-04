import { calibrationEngine } from './calibration';

/**
 * How far an activity should forgive, because of the tracker rather than the
 * client.
 *
 * Every activity has carried a hand-picked "assist" margin — 55 px around the
 * large targets, 35 for medium, 18 for small, 28 in join-the-dots, 20 for the
 * letter tiles. Those were guesses at how far the estimate lands from where
 * someone is actually looking, written before there was any way to measure it.
 * There is now: set-up ends by measuring exactly that, at five points the model
 * was never fitted on. Nothing downstream ever looked at the answer.
 *
 * The consequence was a tool that knew a session could not support its own
 * default and said nothing about it. A client measured at 103 px of error was
 * dropped into targets whose reach was 79 px and could not make them fire — the
 * marker sat outside the target the entire time they were looking straight at
 * it, and neither the activity nor the client was told why.
 *
 * This is also the honest definition of what an assist is *for*: it compensates
 * for the instrument, not for the person. Sized this way a hit means the client
 * looked at the target and a miss means they did not, which is the only version
 * a clinician can read anything into.
 */

/**
 * Used before any set-up has happened. Deliberately mid-range: generous enough
 * that an uncalibrated demo is playable, tight enough that it is not silently
 * better than a real measurement.
 */
const UNMEASURED_ERROR_PX = 40;

/**
 * How far inside a target's total reach the error has to sit before the size
 * feels reliable rather than lucky. The same 0.6 the result screen uses to
 * decide what a session is good for, so the activity and the report cannot
 * disagree about whether something is playable.
 */
const COMFORTABLE_FRACTION = 0.6;

/** The tracker's own measured error in CSS pixels, or a placeholder. */
export function trackerErrorPx(): number {
  const measured = calibrationEngine.getValidation()?.accuracyPx;
  if (typeof measured !== 'number' || !Number.isFinite(measured) || measured <= 0) {
    return UNMEASURED_ERROR_PX;
  }
  return Math.max(8, measured);
}

/** Whether that came from a real measurement or is standing in for one. */
export function trackerErrorIsMeasured(): boolean {
  const measured = calibrationEngine.getValidation()?.accuracyPx;
  return typeof measured === 'number' && Number.isFinite(measured) && measured > 0;
}

/**
 * The assist margin for a target of this radius.
 *
 * Capped at the target's own radius, which is what keeps the size choice
 * meaningful. Handing every size the full measured error would be the obvious
 * reading of "forgive what the instrument gets wrong", and at 103 px of error it
 * would put large, medium and small targets within 20% of each other — three
 * settings that no longer differ, and a small target that is no longer a
 * demanding one. Each size instead gets as much compensation as it can afford
 * while a hit still requires the gaze inside twice its own radius.
 */
export function assistRadiusFor(targetRadiusPx: number): number {
  return Math.min(trackerErrorPx(), targetRadiusPx);
}

/** Total distance a gaze may land from a target's centre and still count. */
export function reachFor(targetRadiusPx: number): number {
  return targetRadiusPx + assistRadiusFor(targetRadiusPx);
}

/** Whether a target of this radius is comfortably hittable at the measured error. */
export function radiusIsComfortable(targetRadiusPx: number): boolean {
  return trackerErrorPx() <= reachFor(targetRadiusPx) * COMFORTABLE_FRACTION;
}

/**
 * Which of a set of sizes to start on: the most demanding one the measurement
 * actually supports, or the most forgiving one when it supports none.
 *
 * Hard-coding a default meant a client whose set-up could not support it was
 * dropped straight into failing, having just been shown a result screen that
 * said as much.
 */
export function defaultSizeIndex(radii: number[]): number {
  let best = -1;
  for (let i = 0; i < radii.length; i++) {
    if (radiusIsComfortable(radii[i]) && (best === -1 || radii[i] < radii[best])) best = i;
  }
  if (best !== -1) return best;
  // Nothing is comfortable: start on the largest and let the activity say so.
  return radii.indexOf(Math.max(...radii));
}
