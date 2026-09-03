import React, { useState } from 'react';
import { viewingGeometry } from '../services/viewingGeometry';
import { useThrottledGaze } from '../services/gazeBus';

/**
 * Lets the user anchor the distance estimate to a real measurement.
 *
 * Every accuracy figure the app reports in degrees is computed from this
 * number, so an estimate that is out by a factor of three turns a two-degree
 * result into a nine-degree one and sends someone chasing a tracking problem
 * that does not exist. Thirty seconds with a tape measure removes the whole
 * class of error.
 */
export const DistanceCheck: React.FC<{ onChanged?: () => void }> = ({ onChanged }) => {
  const gaze = useThrottledGaze(3);
  const [entry, setEntry] = useState('');
  const [saved, setSaved] = useState(false);

  const measured = viewingGeometry.getMeasuredDistanceCm();
  const agreement = viewingGeometry.getMeasurementAgreement();
  const confidence = viewingGeometry.getDistanceConfidence();

  const apply = () => {
    const value = Number(entry);
    if (!Number.isFinite(value)) return;
    if (viewingGeometry.calibrateDistance(value)) {
      setSaved(true);
      setEntry('');
      onChanged?.();
      window.setTimeout(() => setSaved(false), 2500);
    }
  };

  return (
    <div className="rounded-xl surface-quiet px-4 py-3 space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm text-ink">Right now it reads</span>
        <span className="text-sm font-semibold text-ink tabular-nums">
          {gaze && measured !== null ? `${measured.toFixed(0)} cm` : '—'}
        </span>
      </div>

      {/*
        Disagreement no longer means the reading is thrown away — a placeholder
        nobody chose is not more trustworthy than a real measurement, it is just
        quieter about being wrong. It means the two rulers describe different
        anatomy, and one tape measure settles it for good.
      */}
      {confidence === 'uncertain' && (
        <p className="text-xs text-honey-700 leading-relaxed">
          The two ways of measuring this disagree
          {agreement > 0 ? ` (${Math.round(agreement * 100)}% agreement)` : ''}, so treat the figure as
          approximate. One tape measure below fixes it permanently.
        </p>
      )}

      <p className="text-xs text-ink-soft leading-relaxed">
        If that is wrong, measure from your eyes to the screen and type the real number. Everything
        after that is scaled to match.
      </p>

      <div className="flex gap-2">
        <input
          type="number"
          inputMode="decimal"
          min={20}
          max={150}
          value={entry}
          onChange={e => setEntry(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && apply()}
          placeholder="cm"
          className="flex-1 min-w-0 px-3 py-2 rounded-lg border border-soft bg-[var(--surface-raised)] text-sm text-ink"
        />
        <button
          onClick={apply}
          disabled={!entry || measured === null}
          className="px-4 py-2 rounded-lg bg-sage-500 hover:bg-sage-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
        >
          {saved ? 'Saved' : 'Set'}
        </button>
      </div>
    </div>
  );
};
