import React, { useEffect, useRef, useState } from 'react';
import { CalibrationSample } from '../types';
import { calibrationEngine } from '../services/calibration';
import { FaceMeshTracker } from '../services/faceMeshTracker';
import { soundEngine } from '../services/audio';

interface RecentreOverlayProps {
  isOpen: boolean;
  tracker: FaceMeshTracker | null;
  sensitivityX: number;
  sensitivityY: number;
  onClose: (result: { moved: number } | null) => void;
}

const SETTLE_MS = 500;
const COLLECT_MS = 900;

/**
 * One-point drift correction.
 *
 * When someone shifts in the chair, most of the resulting error is a constant
 * offset rather than a change in shape. A single fixation on a known point is
 * enough to remove it — far less disruptive mid-session than starting the whole
 * calibration again, and standard practice in eye-tracking research.
 */
export const RecentreOverlay: React.FC<RecentreOverlayProps> = ({
  isOpen,
  tracker,
  sensitivityX,
  sensitivityY,
  onClose,
}) => {
  const [progress, setProgress] = useState(0);
  const [collecting, setCollecting] = useState(false);
  const samplesRef = useRef<CalibrationSample[]>([]);
  const dotRef = useRef<SVGSVGElement | null>(null);
  const startRef = useRef(0);
  const collectingRef = useRef(false);
  collectingRef.current = collecting;

  useEffect(() => {
    if (!isOpen || !tracker) return;

    samplesRef.current = [];
    setProgress(0);
    setCollecting(false);
    startRef.current = performance.now();

    tracker.collectSamples((sample, _gaze, usable) => {
      if (collectingRef.current && usable) samplesRef.current.push(sample);
    });

    let frame = 0;
    const tick = () => {
      const elapsed = performance.now() - startRef.current;

      if (elapsed < SETTLE_MS) {
        setProgress(elapsed / SETTLE_MS);
      } else if (elapsed < SETTLE_MS + COLLECT_MS) {
        if (!collectingRef.current) {
          setCollecting(true);
          collectingRef.current = true;
        }
        setProgress((elapsed - SETTLE_MS) / COLLECT_MS);
      } else {
        /*
          Where the dot actually is, not where it is assumed to be.

          This used to pass 0.5, 0.5 — the middle of the screen — while the dot
          was laid out in a centred column above its own caption and a cancel
          button, which put it 42 px higher than that. So the client looked at
          the dot, the engine was told they had looked at the centre, and the
          correction absorbed the difference: about a degree of downward error,
          added by the very thing whose job is to remove error, every time it was
          used.

          Reading the position back off the element means the two cannot
          disagree again, whatever anyone later does to the layout.
        */
        const rect = dotRef.current?.getBoundingClientRect();
        const targetXNorm = rect ? (rect.left + rect.width / 2) / window.innerWidth : 0.5;
        const targetYNorm = rect ? (rect.top + rect.height / 2) / window.innerHeight : 0.5;

        const result = calibrationEngine.applyDriftCorrection(
          samplesRef.current,
          targetXNorm,
          targetYNorm,
          window.innerWidth,
          window.innerHeight,
          sensitivityX,
          sensitivityY
        );
        soundEngine.playChime(result ? 620 : 320, 0.16);
        onClose(result ? { moved: Math.hypot(result.dxPx, result.dyPx) } : null);
        return;
      }

      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      tracker.collectSamples(null);
    };
  }, [isOpen, tracker, sensitivityX, sensitivityY, onClose]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const radius = 26;
  const circumference = 2 * Math.PI * radius;

  return (
    <div className="fixed inset-0 z-50 bg-[var(--surface)]/95 backdrop-blur-sm">
      {/*
        Positioned against the viewport rather than flowed in a column, so the
        dot is genuinely in the middle of the screen — which is what the client
        is being asked to look at, and what makes the correction mean anything.
        The caption sits well below it for the same reason it does during
        calibration: nobody should be asked to read something a couple of degrees
        from the point they are fixating.
      */}
      <svg
        ref={dotRef}
        width={72}
        height={72}
        className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
      >
        <circle cx={36} cy={36} r={radius} fill="none" stroke="var(--border-strong)" strokeWidth={3} />
        <circle
          cx={36}
          cy={36}
          r={radius}
          fill="none"
          stroke={collecting ? 'var(--color-sage-500)' : 'var(--color-clay-300)'}
          strokeWidth={3}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - progress)}
          transform="rotate(-90 36 36)"
        />
        <circle cx={36} cy={36} r={collecting ? 4 : 8} fill="var(--color-sage-500)" />
      </svg>
      <p className="fixed left-1/2 -translate-x-1/2 bottom-24 text-sm text-ink-soft">
        Look at the dot and hold still
      </p>
      <button
        onClick={() => onClose(null)}
        className="fixed left-1/2 -translate-x-1/2 bottom-12 text-xs text-ink-faint hover:text-ink-soft underline underline-offset-2"
      >
        Cancel
      </button>
    </div>
  );
};
