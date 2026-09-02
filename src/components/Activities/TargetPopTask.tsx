import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RotateCcw, Timer } from 'lucide-react';
import { soundEngine } from '../../services/audio';
import { useGazeDwell, DwellTarget } from '../../hooks/useGazeDwell';
import { viewingGeometry } from '../../services/viewingGeometry';

interface TargetPopTaskProps {
  dwellDurationMs: number;
}

interface Bubble {
  id: string;
  xPercent: number;
  yPercent: number;
  radius: number;
  hue: string;
  spawnedAt: number;
}

const HUES = ['var(--color-sage-400)', 'var(--color-clay-400)', 'var(--color-sky-500)', 'var(--color-honey-500)'];

/** Difficulty is expressed as target size, because that is what generalises. */
const SIZES = [
  { id: 'large', label: 'Large', radius: 62, assist: 55 },
  { id: 'medium', label: 'Medium', radius: 44, assist: 35 },
  { id: 'small', label: 'Small', radius: 30, assist: 18 },
];

/**
 * Find-and-hold.
 *
 * A target appears; the client locates it and holds their gaze until it fills.
 * The session summary reports time-to-acquire and how close the first fixation
 * landed — both meaningful measures of saccadic accuracy — rather than a score.
 * Target size is adjustable so the task can be graded, and the assistance
 * radius shrinks with it, so "small" is genuinely harder rather than merely
 * smaller-looking.
 */
export const TargetPopTask: React.FC<TargetPopTaskProps> = ({ dwellDurationMs }) => {
  const [sizeIndex, setSizeIndex] = useState(1);
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [completed, setCompleted] = useState(0);
  const [acquireTimes, setAcquireTimes] = useState<number[]>([]);
  const [firstDistances, setFirstDistances] = useState<number[]>([]);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [bounds, setBounds] = useState<DOMRect | null>(null);

  const size = SIZES[sizeIndex];

  const measure = useCallback(() => {
    if (containerRef.current) setBounds(containerRef.current.getBoundingClientRect());
  }, []);

  useEffect(() => {
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [measure]);

  const spawn = useCallback((): Bubble => ({
    id: `bubble-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    xPercent: 12 + Math.random() * 76,
    yPercent: 16 + Math.random() * 68,
    radius: SIZES[sizeIndex].radius,
    hue: HUES[Math.floor(Math.random() * HUES.length)],
    spawnedAt: performance.now(),
  }), [sizeIndex]);

  const reset = useCallback(() => {
    setBubbles([spawn(), spawn(), spawn()]);
    setCompleted(0);
    setAcquireTimes([]);
    setFirstDistances([]);
  }, [spawn]);

  useEffect(() => {
    reset();
  }, [reset]);

  const targets: DwellTarget[] = useMemo(() => {
    if (!bounds) return [];
    return bubbles.map(b => ({
      id: b.id,
      x: bounds.left + (b.xPercent / 100) * bounds.width,
      y: bounds.top + (b.yPercent / 100) * bounds.height,
      radius: b.radius,
    }));
  }, [bubbles, bounds]);

  const dwell = useGazeDwell({
    targets,
    dwellMs: dwellDurationMs,
    assistRadius: size.assist,
    onSelect: (id, info) => {
      const bubble = bubbles.find(b => b.id === id);
      if (!bubble) return;

      soundEngine.playBubblePop(420 + Math.random() * 180);
      setCompleted(c => c + 1);
      // Time from the target appearing to the dwell completing, minus the dwell
      // itself, is the time actually spent finding and landing on it.
      setAcquireTimes(times => [...times, Math.max(0, performance.now() - bubble.spawnedAt - info.dwellMs)]);
      setFirstDistances(d => [...d, info.firstDistance]);

      setBubbles(current => [...current.filter(b => b.id !== id), spawn()]);
    },
  });

  const meanAcquire = acquireTimes.length > 0 ? acquireTimes.reduce((a, b) => a + b, 0) / acquireTimes.length : 0;
  const meanLandingDeg =
    firstDistances.length > 0
      ? viewingGeometry.pixelsToDegrees(firstDistances.reduce((a, b) => a + b, 0) / firstDistances.length)
      : 0;

  return (
    <div ref={containerRef} className="absolute inset-0 overflow-hidden">
      <div className="absolute top-5 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2 surface rounded-full px-2 py-1.5">
        {SIZES.map((s, i) => (
          <button
            key={s.id}
            onClick={() => setSizeIndex(i)}
            className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
              sizeIndex === i ? 'bg-sage-100 text-sage-700' : 'text-ink-soft hover:text-ink'
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {bubbles.map(bubble => {
        const isActive = dwell.activeId === bubble.id;
        const progress = isActive ? dwell.progress : 0;
        return (
          <div
            key={bubble.id}
            className="absolute -translate-x-1/2 -translate-y-1/2"
            style={{ left: `${bubble.xPercent}%`, top: `${bubble.yPercent}%` }}
          >
            <svg width={bubble.radius * 2 + 16} height={bubble.radius * 2 + 16} className="overflow-visible">
              <circle
                cx={bubble.radius + 8}
                cy={bubble.radius + 8}
                r={bubble.radius}
                fill={bubble.hue}
                fillOpacity={isActive ? 0.55 : 0.34}
                stroke={bubble.hue}
                strokeWidth={2.5}
              />
              {progress > 0 && (
                <circle
                  cx={bubble.radius + 8}
                  cy={bubble.radius + 8}
                  r={bubble.radius + 6}
                  fill="none"
                  stroke="var(--color-sage-500)"
                  strokeWidth={4}
                  strokeLinecap="round"
                  strokeDasharray={2 * Math.PI * (bubble.radius + 6)}
                  strokeDashoffset={2 * Math.PI * (bubble.radius + 6) * (1 - progress)}
                  transform={`rotate(-90 ${bubble.radius + 8} ${bubble.radius + 8})`}
                  style={{ transition: 'stroke-dashoffset 60ms linear' }}
                />
              )}
            </svg>
          </div>
        );
      })}

      <div className="absolute bottom-5 left-1/2 -translate-x-1/2 surface rounded-2xl px-5 py-3 flex items-center gap-6">
        <Stat label="Completed" value={String(completed)} />
        <Stat label="Time to find" value={completed > 0 ? `${(meanAcquire / 1000).toFixed(1)} s` : '—'} icon={Timer} />
        <Stat
          label="First landing"
          value={completed > 0 ? `${meanLandingDeg.toFixed(1)}° off` : '—'}
        />
        <button
          onClick={reset}
          className="p-2 rounded-xl text-ink-faint hover:text-ink hover:bg-[var(--surface-sunken)] transition-colors"
          aria-label="Start again"
        >
          <RotateCcw className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};

const Stat: React.FC<{ label: string; value: string; icon?: React.ComponentType<{ className?: string }> }> = ({
  label,
  value,
  icon: Icon,
}) => (
  <div className="text-center">
    <p className="text-xs text-ink-faint flex items-center gap-1 justify-center">
      {Icon && <Icon className="w-3 h-3" />}
      {label}
    </p>
    <p className="text-lg font-semibold text-ink tabular-nums">{value}</p>
  </div>
);
