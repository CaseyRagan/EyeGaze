import React from 'react';
import { AlertTriangle, Check, MoveHorizontal, Ruler } from 'lucide-react';
import { PostureDrift } from '../types';
import { calibrationEngine } from '../services/calibration';
import { useThrottledGaze } from '../services/gazeBus';
import { viewingGeometry } from '../services/viewingGeometry';

interface PostureGuideProps {
  /** Full shows the framing box; compact is the persistent corner readout. */
  variant?: 'compact' | 'full';
  onRecentre?: () => void;
}

/**
 * Live feedback on where the head is, compared with where it was at calibration.
 *
 * This exists because on a built-in webcam, head *translation* — not rotation,
 * and not distance — is usually the largest single source of drift. Sliding
 * three centimetres sideways at a typical 55 cm viewing distance changes the
 * eye rotation needed to fixate the same point by roughly three degrees, which
 * is larger than the entire error budget of a good webcam calibration. A chin
 * or forehead rest removes that term almost entirely; this panel is what you
 * use when there isn't one.
 */
export const PostureGuide: React.FC<PostureGuideProps> = ({ variant = 'compact', onRecentre }) => {
  const gaze = useThrottledGaze(8);
  const drift: PostureDrift | null = gaze ? calibrationEngine.getPostureDrift(gaze.headPose) : null;
  const distanceCm = gaze?.headPose.distanceCm ?? null;
  const measured = viewingGeometry.isDistanceMeasured();

  if (variant === 'full') {
    return <FullGuide drift={drift} distanceCm={distanceCm} gazeTx={gaze?.headPose.translateX ?? 0} gazeTy={gaze?.headPose.translateY ?? 0} />;
  }

  if (!drift) return null;

  const tone =
    drift.severity === 'good'
      ? { bg: 'bg-sage-50', border: 'border-sage-200', text: 'text-sage-700', icon: Check }
      : drift.severity === 'drifting'
      ? { bg: 'bg-honey-100', border: 'border-honey-300', text: 'text-[#8a6a22]', icon: MoveHorizontal }
      : { bg: 'bg-clay-100', border: 'border-clay-300', text: 'text-clay-500', icon: AlertTriangle };

  const Icon = tone.icon;

  const message =
    drift.severity === 'good'
      ? 'Position is steady'
      : drift.severity === 'drifting'
      ? 'Drifting from your set-up position'
      : 'Moved a long way — accuracy will have suffered';

  return (
    <div className={`fixed left-5 bottom-5 z-30 rounded-2xl border ${tone.bg} ${tone.border} px-4 py-3 max-w-[280px]`}>
      <div className="flex items-start gap-2.5">
        <Icon className={`w-4 h-4 mt-0.5 shrink-0 ${tone.text}`} />
        <div className="min-w-0">
          <p className={`text-sm font-medium ${tone.text}`}>{message}</p>
          <p className="text-xs text-ink-soft mt-1 leading-relaxed">
            {drift.lateralCm >= 1.5 && `${drift.lateralCm.toFixed(1)} cm sideways. `}
            {Math.abs(drift.depthCm) >= 3 &&
              `${Math.abs(drift.depthCm).toFixed(0)} cm ${drift.depthCm > 0 ? 'further away' : 'closer'}. `}
            {drift.rotationDeg >= 4 && `Head turned ${drift.rotationDeg.toFixed(0)}°. `}
            {drift.severity === 'good' && distanceCm && `About ${distanceCm.toFixed(0)} cm from the screen.`}
          </p>
          {drift.severity !== 'good' && onRecentre && (
            <button
              onClick={onRecentre}
              className="mt-2 text-xs font-medium text-sage-600 hover:text-sage-700 underline underline-offset-2"
            >
              Re-centre in five seconds
            </button>
          )}
        </div>
      </div>
      {!measured && (
        <p className="text-[11px] text-ink-faint mt-2 pl-6">Distance is estimated from your settings.</p>
      )}
    </div>
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
