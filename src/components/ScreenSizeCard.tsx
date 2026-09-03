import React, { useEffect, useState } from 'react';
import { CreditCard, Check, Monitor } from 'lucide-react';
import { viewingGeometry } from '../services/viewingGeometry';
import {
  CARD_ASPECT,
  cardWidthForDiagonal,
  detectScreenDiagonalInches,
  diagonalFromCardWidth,
} from '../services/screenSize';

/**
 * Establishes how big the screen physically is.
 *
 * This lives in the set-up flow rather than only in settings, because the
 * failure it prevents is one of timing: the figure was easy to find and easy to
 * forget, and forgetting it is invisible. Everything reported in degrees is
 * scaled by it, so a 14-inch screen recorded as 15.6 quietly inflates every
 * accuracy figure by a tenth, and nothing looks wrong. Putting it in front of
 * the client before the dots start means the number is settled while it still
 * costs nothing to settle.
 *
 * Worth saying plainly, because it reads worse than it is: the calibration
 * itself does not depend on this. Targets are placed as fractions of the window
 * and the model is fitted in those fractions, so a wrong screen size produces a
 * wrong *number*, not a wrong mapping. Correcting it afterwards re-reports the
 * same session correctly.
 */
export const ScreenSizeCard: React.FC = () => {
  const [settings, setSettings] = useState(viewingGeometry.getSettings());
  const [measuring, setMeasuring] = useState(false);
  const [cardWidth, setCardWidth] = useState(() =>
    cardWidthForDiagonal(viewingGeometry.getSettings().screenDiagonalInches)
  );
  const detected = detectScreenDiagonalInches();

  useEffect(() => {
    if (measuring) setCardWidth(cardWidthForDiagonal(settings.screenDiagonalInches));
  }, [measuring, settings.screenDiagonalInches]);

  const apply = (diagonalInches: number, source: 'measured' | 'device') => {
    viewingGeometry.updateSettings({ screenDiagonalInches: diagonalInches, screenSizeSource: source });
    setSettings(viewingGeometry.getSettings());
  };

  const commitCard = () => {
    const inches = diagonalFromCardWidth(cardWidth);
    if (inches !== null) apply(Number(inches.toFixed(1)), 'measured');
    setMeasuring(false);
  };

  const source = settings.screenSizeSource;

  return (
    <div className="surface rounded-2xl px-5 py-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-sm font-semibold text-ink">Your screen</h4>
        <span className="text-sm text-ink-soft tabular-nums">
          {settings.screenDiagonalInches}″ diagonal
        </span>
      </div>

      {source === 'device' && (
        <p className="text-sm text-sage-600 flex items-start gap-2">
          <Check className="w-4 h-4 mt-0.5 shrink-0" />
          <span>Recognised as {detected.label}. Nothing to do here.</span>
        </p>
      )}
      {source === 'measured' && (
        <p className="text-sm text-sage-600 flex items-start gap-2">
          <Check className="w-4 h-4 mt-0.5 shrink-0" />
          <span>Measured with a bank card, so this is exact.</span>
        </p>
      )}
      {source === 'assumed' && (
        <p className="text-sm text-honey-700 flex items-start gap-2">
          <Monitor className="w-4 h-4 mt-0.5 shrink-0" />
          <span>
            This screen is not one we recognise, so {settings.screenDiagonalInches}″ is a
            placeholder. Every accuracy figure is scaled by it — worth a moment now.
          </span>
        </p>
      )}

      {!measuring ? (
        <button
          onClick={() => setMeasuring(true)}
          className="w-full py-2.5 rounded-xl border border-strong text-ink text-sm font-medium hover:bg-[var(--surface-sunken)] transition-colors flex items-center justify-center gap-2"
        >
          <CreditCard className="w-4 h-4" />
          {source === 'assumed' ? 'Measure it with a bank card' : 'Measure it again'}
        </button>
      ) : (
        <div className="space-y-3">
          {/*
            Any bank card, library card or driving licence works: they are all
            ID-1, 85.60 x 53.98 mm by international standard. Holding a real one
            against the screen turns an unknowable quantity into a measured one,
            which is why this beats every heuristic when the panel is unknown.
          */}
          <p className="text-sm text-ink-soft leading-relaxed">
            Hold any bank or library card flat against the screen and drag until the outline is
            exactly its size.
          </p>
          <div
            className="rounded-xl border-2 border-dashed border-[var(--color-sage-500)] bg-[var(--surface-sunken)]"
            style={{ width: `${cardWidth}px`, height: `${cardWidth / CARD_ASPECT}px`, maxWidth: '100%' }}
          />
          <input
            type="range"
            min={120}
            max={700}
            step={1}
            value={cardWidth}
            onChange={e => setCardWidth(Number(e.target.value))}
            className="w-full"
            aria-label="Card width"
          />
          <div className="flex gap-2">
            <button
              onClick={commitCard}
              className="flex-1 py-2.5 rounded-xl bg-sage-500 hover:bg-sage-600 text-white text-sm font-medium transition-colors"
            >
              That matches
            </button>
            <button
              onClick={() => setMeasuring(false)}
              className="px-4 py-2.5 rounded-xl border border-strong text-ink-soft text-sm font-medium hover:bg-[var(--surface-sunken)] transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
