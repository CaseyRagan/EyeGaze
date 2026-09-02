import React from 'react';
import { AlertTriangle, Check } from 'lucide-react';
import { viewingGeometry } from '../services/viewingGeometry';
import { useThrottledGaze } from '../services/gazeBus';

/**
 * Warns when the screen is asking for more eye movement than a webcam can follow.
 *
 * This is the least obvious of the physical set-up problems and one of the most
 * damaging. Neither the viewing distance nor the screen size predicts it on its
 * own — what matters is the angle the two produce together. Sitting 27 cm from
 * a laptop puts the edges of the window more than 30 degrees off centre, and
 * webcam iris tracking degrades badly well before that:
 *
 *  - At large gaze angles the iris slides behind the eyelid and the inner
 *    corner, so less of it is visible to estimate a centre from.
 *  - Its outline turns increasingly elliptical, and the landmark model is
 *    weakest exactly where the geometry is most extreme.
 *  - People stop rotating their eyes that far and start turning their heads
 *    instead, which quietly breaks the assumption the calibration rests on.
 *
 * The symptom is distinctive and easy to misread: the estimate is *steady* —
 * low wobble, high confidence — but lands a long way from the target, and worst
 * at the edges. That looks like a broken mapping rather than a physical
 * problem, which is why this says so explicitly and gives a number to act on.
 */

/** Past this, accuracy falls away faster than anything in software can recover. */
const COMFORTABLE_HALF_ANGLE = 22;
const POOR_HALF_ANGLE = 27;

export const GazeRangeCheck: React.FC = () => {
  // Re-render occasionally so the reading follows the live distance estimate.
  useThrottledGaze(2);

  const halfAngle = viewingGeometry.getViewportHalfAngleDeg();
  if (!Number.isFinite(halfAngle) || halfAngle <= 0) return null;

  const distanceCm = viewingGeometry.getEffectiveDistanceCm();
  const recommendedCm = viewingGeometry.getDistanceForHalfAngleCm(COMFORTABLE_HALF_ANGLE);
  const comfortable = halfAngle <= COMFORTABLE_HALF_ANGLE;
  const poor = halfAngle > POOR_HALF_ANGLE;

  if (comfortable) {
    return (
      <div className="rounded-xl surface-quiet px-4 py-3 flex items-start gap-2.5">
        <Check className="w-4 h-4 mt-0.5 shrink-0 text-sage-600" />
        <p className="text-xs text-ink-soft leading-relaxed">
          The screen sits within about {Math.round(halfAngle)}° of straight ahead, which is a
          comfortable range for your eyes to cover.
        </p>
      </div>
    );
  }

  return (
    <div
      className={`rounded-xl border px-4 py-3 ${
        poor ? 'border-clay-300 bg-clay-100' : 'border-honey-300 bg-honey-100'
      }`}
    >
      <div className="flex items-start gap-2.5">
        <AlertTriangle className={`w-4 h-4 mt-0.5 shrink-0 ${poor ? 'text-clay-500' : 'text-honey-700'}`} />
        <div className={`text-xs leading-relaxed ${poor ? 'text-clay-500' : 'text-honey-700'}`}>
          <p className="font-medium mb-1">
            You are close enough that the screen edges are {Math.round(halfAngle)}° off centre.
          </p>
          <p>
            That is more eye movement than a webcam can follow accurately — the iris disappears
            behind the eyelid at those angles. Expect the estimate to look steady but land well away
            from where you are looking, worst at the edges.
          </p>
          <p className="mt-1.5">
            Sit about <strong>{Math.round(recommendedCm)} cm</strong> back
            {distanceCm > 0 && ` (you are at roughly ${Math.round(distanceCm)} cm)`}, or make the
            browser window smaller, or reduce the working area in settings.
          </p>
        </div>
      </div>
    </div>
  );
};
