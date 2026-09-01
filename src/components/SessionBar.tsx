import React, { useEffect, useState } from 'react';
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

  const trackingState = !gaze
    ? 'Starting'
    : gaze.event === 'lost'
    ? 'Eyes not found'
    : gaze.isHeld
    ? 'Holding'
    : gaze.event === 'fixation'
    ? 'Steady'
    : gaze.event === 'blink'
    ? 'Blink'
    : 'Moving';

  return (
    <div className="hidden lg:flex items-center gap-1">
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
          {gaze ? `${Math.round(gaze.confidence * 100)}%` : '—'}
        </span>
      </div>
    </div>
  );
};
