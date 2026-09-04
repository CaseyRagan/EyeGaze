import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, RotateCcw } from 'lucide-react';
import { ConstellationLevel } from '../../types';
import { soundEngine } from '../../services/audio';
import { DwellTarget, useGazeDwell } from '../../hooks/useGazeDwell';
import { assistRadiusFor } from '../../services/trackerReach';
import { viewingGeometry } from '../../services/viewingGeometry';

const LEVELS: ConstellationLevel[] = [
  {
    id: 'kite',
    title: 'Kite',
    subtitle: 'Four points, wide apart. A gentle warm-up.',
    stars: [
      { id: 1, x: 50, y: 20, name: 'top' },
      { id: 2, x: 78, y: 48, name: 'right' },
      { id: 3, x: 50, y: 80, name: 'bottom' },
      { id: 4, x: 22, y: 48, name: 'left' },
    ],
    connections: [[1, 2], [2, 3], [3, 4], [4, 1]],
  },
  {
    id: 'zigzag',
    title: 'Zig-zag',
    subtitle: 'Alternating left and right, the way reading moves.',
    stars: [
      { id: 1, x: 16, y: 24 },
      { id: 2, x: 84, y: 24 },
      { id: 3, x: 16, y: 50 },
      { id: 4, x: 84, y: 50 },
      { id: 5, x: 16, y: 76 },
      { id: 6, x: 84, y: 76 },
    ].map(s => ({ ...s, name: '' })),
    connections: [[1, 2], [2, 3], [3, 4], [4, 5], [5, 6]],
  },
  {
    id: 'scatter',
    title: 'Scatter',
    subtitle: 'Seven points with no pattern to guess at.',
    stars: [
      { id: 1, x: 20, y: 30 },
      { id: 2, x: 64, y: 18 },
      { id: 3, x: 82, y: 55 },
      { id: 4, x: 44, y: 44 },
      { id: 5, x: 30, y: 74 },
      { id: 6, x: 70, y: 82 },
      { id: 7, x: 52, y: 62 },
    ].map(s => ({ ...s, name: '' })),
    connections: [[1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7]],
  },
];

const STAR_RADIUS = 30;

/**
 * Join the dots in order.
 *
 * A sequencing task for saccadic accuracy: each point must be found and held
 * before the next appears, so the client cannot succeed by sweeping. The
 * summary reports how long each jump took and how far the first landing fell
 * from the target — the two numbers that actually describe a saccade.
 */
export const ConstellationTask: React.FC = () => {
  const [levelIndex, setLevelIndex] = useState(0);
  const [connected, setConnected] = useState<number[]>([]);
  const [latencies, setLatencies] = useState<number[]>([]);
  const [landings, setLandings] = useState<number[]>([]);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [bounds, setBounds] = useState<DOMRect | null>(null);
  const revealedAtRef = useRef(performance.now());

  const level = LEVELS[levelIndex];
  const nextStar = level.stars[connected.length];
  const isComplete = connected.length === level.stars.length;

  const measure = useCallback(() => {
    if (containerRef.current) setBounds(containerRef.current.getBoundingClientRect());
  }, []);

  useEffect(() => {
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [measure]);

  const reset = useCallback(() => {
    setConnected([]);
    setLatencies([]);
    setLandings([]);
    revealedAtRef.current = performance.now();
  }, []);

  useEffect(() => {
    reset();
  }, [levelIndex, reset]);

  // Only the next star is a live target, so the sequence cannot be short-cut.
  const targets: DwellTarget[] = useMemo(() => {
    if (!bounds || !nextStar) return [];
    return [
      {
        id: String(nextStar.id),
        x: bounds.left + (nextStar.x / 100) * bounds.width,
        y: bounds.top + (nextStar.y / 100) * bounds.height,
        radius: STAR_RADIUS,
      },
    ];
  }, [bounds, nextStar]);

  const dwell = useGazeDwell({
    targets,
    dwellMs: 550,
    // The tracker's measured error rather than a guess at it, capped at the
    // star's own radius so the dots stay distinguishable from each other.
    assistRadius: assistRadiusFor(STAR_RADIUS),
    enabled: !isComplete,
    onSelect: (id, info) => {
      setLatencies(l => [...l, Math.max(0, performance.now() - revealedAtRef.current - info.dwellMs)]);
      setLandings(d => [...d, info.firstDistance]);
      revealedAtRef.current = performance.now();
      setConnected(c => [...c, Number(id)]);
      soundEngine.playStarConnect(connected.length);
    },
  });

  useEffect(() => {
    if (isComplete) soundEngine.playLevelComplete();
  }, [isComplete]);

  const meanLatency = latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
  const meanLandingDeg = landings.length
    ? viewingGeometry.pixelsToDegrees(landings.reduce((a, b) => a + b, 0) / landings.length)
    : 0;

  return (
    <div ref={containerRef} className="absolute inset-0 overflow-hidden">
      <div className="absolute top-5 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2 surface rounded-full px-2 py-1.5">
        {LEVELS.map((l, i) => (
          <button
            key={l.id}
            onClick={() => setLevelIndex(i)}
            className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
              levelIndex === i ? 'bg-sage-100 text-sage-700' : 'text-ink-soft hover:text-ink'
            }`}
          >
            {l.title}
          </button>
        ))}
      </div>

      <svg className="absolute inset-0 w-full h-full pointer-events-none">
        {level.connections.map(([a, b], i) => {
          const from = level.stars.find(s => s.id === a);
          const to = level.stars.find(s => s.id === b);
          if (!from || !to) return null;
          const done = connected.includes(a) && connected.includes(b);
          return (
            <line
              key={i}
              x1={`${from.x}%`}
              y1={`${from.y}%`}
              x2={`${to.x}%`}
              y2={`${to.y}%`}
              stroke={done ? 'var(--color-sage-400)' : 'var(--border-soft)'}
              strokeWidth={done ? 2.5 : 1.5}
              strokeDasharray={done ? undefined : '4 6'}
            />
          );
        })}
      </svg>

      {level.stars.map((star, index) => {
        const done = connected.includes(star.id);
        const isNext = !done && index === connected.length;
        const progress = isNext && dwell.activeId === String(star.id) ? dwell.progress : 0;

        return (
          <div
            key={star.id}
            className="absolute -translate-x-1/2 -translate-y-1/2"
            style={{ left: `${star.x}%`, top: `${star.y}%` }}
          >
            <svg width={90} height={90} className="overflow-visible">
              <circle
                cx={45}
                cy={45}
                r={STAR_RADIUS}
                fill={done ? 'var(--color-sage-200)' : isNext ? 'var(--color-clay-200)' : 'transparent'}
                fillOpacity={0.7}
                stroke={done ? 'var(--color-sage-500)' : isNext ? 'var(--color-clay-400)' : 'var(--border-strong)'}
                strokeWidth={isNext ? 2.5 : 1.5}
              />
              {progress > 0 && (
                <circle
                  cx={45}
                  cy={45}
                  r={STAR_RADIUS + 7}
                  fill="none"
                  stroke="var(--color-sage-500)"
                  strokeWidth={4}
                  strokeLinecap="round"
                  strokeDasharray={2 * Math.PI * (STAR_RADIUS + 7)}
                  strokeDashoffset={2 * Math.PI * (STAR_RADIUS + 7) * (1 - progress)}
                  transform="rotate(-90 45 45)"
                  style={{ transition: 'stroke-dashoffset 60ms linear' }}
                />
              )}
              <text
                x={45}
                y={50}
                textAnchor="middle"
                className="text-sm font-semibold"
                fill={isNext ? 'var(--color-clay-500)' : 'var(--color-ink-faint)'}
              >
                {index + 1}
              </text>
            </svg>
          </div>
        );
      })}

      <div className="absolute bottom-5 left-1/2 -translate-x-1/2 surface rounded-2xl px-5 py-3 flex items-center gap-6">
        <div className="text-center">
          <p className="text-xs text-ink-faint">Progress</p>
          <p className="text-lg font-semibold text-ink tabular-nums">
            {connected.length}/{level.stars.length}
          </p>
        </div>
        <div className="text-center">
          <p className="text-xs text-ink-faint">Time per jump</p>
          <p className="text-lg font-semibold text-ink tabular-nums">
            {latencies.length ? `${(meanLatency / 1000).toFixed(1)} s` : '—'}
          </p>
        </div>
        <div className="text-center">
          <p className="text-xs text-ink-faint">First landing</p>
          <p className="text-lg font-semibold text-ink tabular-nums">
            {landings.length ? `${meanLandingDeg.toFixed(1)}° off` : '—'}
          </p>
        </div>
        {isComplete ? (
          <button
            onClick={() => setLevelIndex(i => (i + 1) % LEVELS.length)}
            className="px-4 py-2 rounded-xl bg-sage-500 hover:bg-sage-600 text-white text-sm font-medium flex items-center gap-2 transition-colors"
          >
            Next <ArrowRight className="w-4 h-4" />
          </button>
        ) : (
          <button
            onClick={reset}
            className="p-2 rounded-xl text-ink-faint hover:text-ink hover:bg-[var(--surface-sunken)] transition-colors"
            aria-label="Start again"
          >
            <RotateCcw className="w-4 h-4" />
          </button>
        )}
      </div>

      <p className="absolute top-20 left-1/2 -translate-x-1/2 text-sm text-ink-faint">{level.subtitle}</p>
    </div>
  );
};
