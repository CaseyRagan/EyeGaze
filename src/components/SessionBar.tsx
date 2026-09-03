import React, { useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Crosshair, Gauge } from 'lucide-react';
import { calibrationEngine } from '../services/calibration';
import { useThrottledGaze } from '../services/gazeBus';

interface SessionBarProps {
  onOpenCalibration: () => void;
}

/**
 * The persistent status readout.
 *
 * Everything here is measured. The previous version displayed "99.2%" whenever
 * a calibration existed, regardless of how it had gone — which is worse than
 * showing nothing, because a clinician has no way to tell a good session from a
 * bad one and would reasonably assume the tool knew.
 */
export const SessionBar: React.FC<SessionBarProps> = ({ onOpenCalibration }) => {
  const gaze = useThrottledGaze(4);
  const [, forceUpdate] = useState(0);

  // Confidence collapses during a blink and recovers a moment later. Showing
  // that live makes the readout twitch several times a minute for a reason the
  // client can do nothing about, so the last figure measured on open eyes is
  // held instead.
  const steadyConfidenceRef = useRef<number | null>(null);
  if (gaze && gaze.event !== 'blink' && !gaze.isVisiblyInterrupted) {
    steadyConfidenceRef.current = gaze.confidence;
  }

  useEffect(() => calibrationEngine.subscribe(() => forceUpdate(n => n + 1)), []);

  const validation = calibrationEngine.getValidation();
  const calibrated = calibrationEngine.isCalibrated();

  const accuracyLabel = !calibrated
    ? 'Not set up'
    : validation && Number.isFinite(validation.accuracyDeg)
    ? `${validation.accuracyDeg.toFixed(1)}° accuracy`
    : 'Not checked';

  const accuracyTone = !calibrated
    ? 'text-clay-500'
    : validation && validation.grade !== 'poor'
    ? 'text-sage-600'
    : 'text-honey-700';

  /*
    A blink is not a tracking state, so it is not reported as one.
    
    The estimate is held through a blink rather than lost, so the honest label
    during one is the label it already had. Flipping the readout to "Blink"
    fifteen times a minute told the client that a reflex they cannot suppress was
    a thing the tool noticed and minded — and the natural response to that is to
    stop blinking, which dries the eyes and makes tracking worse. An interruption
    long enough to be something other than a blink still shows as "Holding".
  */
  const trackingState = !gaze
    ? 'Starting'
    : gaze.event === 'lost'
    ? 'Eyes not found'
    : gaze.isVisiblyInterrupted
    ? 'Holding'
    : gaze.event === 'saccade'
    ? 'Moving'
    : 'Steady';

  return (
    <div className="hidden xl:flex items-center gap-1">
      <button
        onClick={onOpenCalibration}
        className="flex items-center gap-2 px-3 py-2 rounded-xl hover:bg-[var(--surface-sunken)] transition-colors"
        title={
          validation
            ? `Checked ${new Date(validation.timestamp).toLocaleDateString()} at five points the tracker was not taught`
            : 'Run set-up to measure accuracy'
        }
      >
        {calibrated && validation && validation.grade !== 'poor' ? (
          <CheckCircle2 className={`w-4 h-4 ${accuracyTone}`} />
        ) : (
          <AlertCircle className={`w-4 h-4 ${accuracyTone}`} />
        )}
        <span className={`text-sm font-medium ${accuracyTone}`}>{accuracyLabel}</span>
      </button>

      <span className="w-px h-5 bg-[var(--border-soft)]" />

      <div className="flex items-center gap-2 px-3 py-2" title="What the eyes are doing right now">
        <Gauge className="w-4 h-4 text-ink-faint" />
        <span className="text-sm text-ink-soft w-[86px]">{trackingState}</span>
      </div>

      <span className="w-px h-5 bg-[var(--border-soft)]" />

      <div className="flex items-center gap-2 px-3 py-2" title="Signal quality for the current frame">
        <Crosshair className="w-4 h-4 text-ink-faint" />
        <span className="text-sm text-ink-soft tabular-nums">
          {steadyConfidenceRef.current !== null
            ? `${Math.round(steadyConfidenceRef.current * 100)}%`
            : '—'}
        </span>
      </div>
    </div>
  );
};
