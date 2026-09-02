import React from 'react';
import { Ruler } from 'lucide-react';
import { PostureDrift } from '../types';
import { calibrationEngine } from '../services/calibration';
import { useThrottledGaze } from '../services/gazeBus';

/**
 * The head-position picture shown during set-up.
 *
 * Its persistent counterpart during a session is HeadAlignmentGuide, which
 * draws the same target on a canvas so it can stay on screen while an activity
 * runs without costing anything.
 */
export const PostureGuide: React.FC = () => {
  const gaze = useThrottledGaze(8);
  const drift: PostureDrift | null = gaze ? calibrationEngine.getPostureDrift(gaze.headPose) : null;

  return (
    <FullGuide
      drift={drift}
      distanceCm={gaze?.headPose.distanceCm ?? null}
      gazeTx={gaze?.headPose.translateX ?? 0}
      gazeTy={gaze?.headPose.translateY ?? 0}
    />
  );
};

const FullGuide: React.FC<{ drift: PostureDrift | null; distanceCm: number | null; gazeTx: number; gazeTy: number }> = ({
  drift,
  distanceCm,
  gazeTx,
  gazeTy,
}) => {
  const posture = calibrationEngine.getPosture();
  const targetTx = posture?.translateX ?? 0;
  const targetTy = posture?.translateY ?? 0;

  // The box is a 1:1 map of the camera's field, so moving right moves the dot
  // right. Scale keeps a realistic head range inside the frame.
  const toPercent = (v: number) => 50 + v * 160;

  return (
    <div className="surface rounded-2xl p-5">
      <div className="flex items-baseline justify-between mb-4">
        <h3 className="text-base font-semibold text-ink">Head position</h3>
        {distanceCm !== null && (
          <span className="text-sm text-ink-soft flex items-center gap-1.5">
            <Ruler className="w-3.5 h-3.5" />
            {distanceCm.toFixed(0)} cm from screen
          </span>
        )}
      </div>

      <div className="relative rounded-xl surface-quiet aspect-[4/3] overflow-hidden">
        <div
          className="absolute rounded-full border-2 border-dashed border-sage-300"
          style={{
            left: `${toPercent(targetTx) - 14}%`,
            top: `${toPercent(targetTy) - 18}%`,
            width: '28%',
            height: '36%',
          }}
        />
        <div
          className="absolute rounded-full bg-sage-400/25 border-2 border-sage-500 transition-all duration-100"
          style={{
            left: `${toPercent(gazeTx) - 11}%`,
            top: `${toPercent(gazeTy) - 14}%`,
            width: '22%',
            height: '28%',
          }}
        />
        <p className="absolute bottom-2 left-0 right-0 text-center text-xs text-ink-faint">
          {posture ? 'Line the solid marker up with the dashed one' : 'Not calibrated yet'}
        </p>
      </div>

      {drift && (
        <dl className="grid grid-cols-3 gap-3 mt-4 text-center">
          <div>
            <dt className="text-xs text-ink-faint">Sideways</dt>
            <dd className="text-lg font-medium text-ink">{drift.lateralCm.toFixed(1)} cm</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-faint">Distance</dt>
            <dd className="text-lg font-medium text-ink">
              {drift.depthCm >= 0 ? '+' : ''}
              {drift.depthCm.toFixed(0)} cm
            </dd>
          </div>
          <div>
            <dt className="text-xs text-ink-faint">Turn</dt>
            <dd className="text-lg font-medium text-ink">{drift.rotationDeg.toFixed(0)}°</dd>
          </div>
        </dl>
      )}
    </div>
  );
};
