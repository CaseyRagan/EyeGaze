import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, Ruler } from 'lucide-react';
import { GazeState } from '../types';
import { gazeBus } from '../services/gazeBus';
import { calibrationEngine } from '../services/calibration';
import { viewingGeometry } from '../services/viewingGeometry';
import { drawHeadPosition, judgeAlignment } from './headPositionDraw';

/**
 * Where to sit, answered in one place.
 *
 * Distance, framing and how much eye movement the screen will demand are one
 * question, not three, and splitting them across separate cards meant the
 * warning that mattered sat below the fold while the picture that should have
 * shown the problem stayed the same size no matter where the person sat.
 */

/** Beyond this, the eyes have to travel further than a webcam can follow. */
const COMFORTABLE_HALF_ANGLE = 22;
/** Keep the suggested distance somewhere a person would actually sit. */
const MIN_TARGET_CM = 45;
const MAX_TARGET_CM = 75;

export const HeadPositionCard: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const gazeRef = useRef<GazeState | null>(gazeBus.get());
  const [status, setStatus] = useState<{
    instruction: string | null;
    aligned: boolean;
    distanceCm: number | null;
    tracking: boolean;
  }>({ instruction: null, aligned: false, distanceCm: null, tracking: false });

  useEffect(() => gazeBus.subscribe(g => {
    gazeRef.current = g;
  }), []);

  // The distance to aim for: close enough to see comfortably, far enough that
  // the screen edges stay inside the range the tracker can follow.
  const targetDistanceCm = Math.round(
    Math.max(
      MIN_TARGET_CM,
      Math.min(MAX_TARGET_CM, viewingGeometry.getDistanceForHalfAngleCm(COMFORTABLE_HALF_ANGLE))
    )
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let frame = 0;
    let uiTick = 0;
    let dpr = window.devicePixelRatio || 1;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      dpr = window.devicePixelRatio || 1;
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize);

    const render = () => {
      const rect = canvas.getBoundingClientRect();
      const gaze = gazeRef.current;
      const posture = calibrationEngine.getPosture();

      // Once calibrated, the target is the pose the mapping was built on.
      // Before that it is the recommended seating position.
      const targetTx = posture?.translateX ?? 0;
      const targetTy = posture?.translateY ?? 0;

      if (!gaze || gaze.event === 'lost' || gaze.headPose.interocularSpan <= 0) {
        drawHeadPosition(ctx, {
          width: rect.width,
          height: rect.height,
          scale: 1,
          translateX: 0,
          translateY: 0,
          yaw: 0,
          pitch: 0,
          roll: 0,
          aligned: false,
          state: 'no-face',
          emptyLabel: 'Looking for your face…',
        });
        if (++uiTick % 20 === 0) setStatus(s => (s.tracking ? { ...s, tracking: false } : s));
        frame = requestAnimationFrame(render);
        return;
      }

      // Closer than the target means a bigger head. Once calibrated the ratio
      // of apparent eye separations gives this directly and does not depend on
      // the absolute distance estimate being right; before then it has to come
      // from the distance reading.
      const distanceCm = viewingGeometry.getEffectiveDistanceCm();
      const scale =
        posture && posture.interocularSpan > 1e-5
          ? gaze.headPose.interocularSpan / posture.interocularSpan
          : distanceCm > 0
          ? targetDistanceCm / distanceCm
          : 1;

      const verdict = judgeAlignment({
        scale,
        translateX: gaze.headPose.translateX,
        translateY: gaze.headPose.translateY,
        targetTranslateX: targetTx,
        targetTranslateY: targetTy,
        yaw: gaze.headPose.yaw,
        pitch: gaze.headPose.pitch,
      });

      drawHeadPosition(ctx, {
        width: rect.width,
        height: rect.height,
        scale: Math.max(0.35, Math.min(2.2, scale)),
        translateX: gaze.headPose.translateX - targetTx,
        translateY: gaze.headPose.translateY - targetTy,
        yaw: gaze.headPose.yaw,
        pitch: gaze.headPose.pitch,
        roll: gaze.headPose.roll,
        aligned: verdict.aligned,
        state: 'tracking',
      });

      if (++uiTick % 12 === 0) {
        setStatus({
          instruction: verdict.instruction,
          aligned: verdict.aligned,
          distanceCm,
          tracking: true,
        });
      }

      frame = requestAnimationFrame(render);
    };

    frame = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', resize);
    };
  }, [targetDistanceCm]);

  const halfAngle = viewingGeometry.getViewportHalfAngleDeg();
  const rangeIsComfortable = halfAngle <= COMFORTABLE_HALF_ANGLE;

  return (
    <div className="surface rounded-2xl p-5 space-y-4">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-base font-semibold text-ink">Where to sit</h3>
        <span className="text-sm text-ink-soft flex items-center gap-1.5">
          <Ruler className="w-3.5 h-3.5" />
          {status.tracking && status.distanceCm ? `${Math.round(status.distanceCm)} cm` : '—'}
          <span className="text-ink-faint">/ aim for {targetDistanceCm} cm</span>
        </span>
      </div>

      <canvas ref={canvasRef} className="w-full rounded-xl bg-[var(--surface-sunken)]" style={{ aspectRatio: '4 / 3' }} />

      <div
        className={`rounded-xl px-4 py-3 flex items-start gap-2.5 border ${
          status.aligned
            ? 'border-sage-200 bg-sage-50'
            : status.tracking
            ? 'border-clay-300 bg-clay-100'
            : 'border-soft surface-quiet'
        }`}
      >
        {status.aligned ? (
          <Check className="w-4 h-4 mt-0.5 shrink-0 text-sage-600" />
        ) : (
          <AlertTriangle className={`w-4 h-4 mt-0.5 shrink-0 ${status.tracking ? 'text-clay-500' : 'text-ink-faint'}`} />
        )}
        <p
          className={`text-sm leading-relaxed ${
            status.aligned ? 'text-sage-700' : status.tracking ? 'text-clay-500' : 'text-ink-soft'
          }`}
        >
          {!status.tracking
            ? 'Waiting for the camera to find your face.'
            : status.aligned
            ? 'That is the spot. Try to stay there — the tracking is tied to this position.'
            : status.instruction}
        </p>
      </div>

      {/* The consequence of the distance, next to the distance rather than
          three scrolls below it. */}
      <div
        className={`rounded-xl px-4 py-3 border ${
          rangeIsComfortable ? 'border-soft surface-quiet' : 'border-honey-300 bg-honey-100'
        }`}
      >
        <p className={`text-xs leading-relaxed ${rangeIsComfortable ? 'text-ink-soft' : 'text-honey-700'}`}>
          {rangeIsComfortable ? (
            <>
              From there the screen sits within about {Math.round(halfAngle)}° of straight ahead, which is a
              comfortable range for your eyes to cover.
            </>
          ) : (
            <>
              <strong>The screen edges are {Math.round(halfAngle)}° off centre from where you are.</strong> That
              is more eye movement than a webcam can follow — the iris hides behind the eyelid at those angles,
              and the estimate will look steady while landing well away from where you are looking. Move back to
              about {targetDistanceCm} cm, shrink the browser window, or reduce the working area in settings.
            </>
          )}
        </p>
      </div>
    </div>
  );
};
