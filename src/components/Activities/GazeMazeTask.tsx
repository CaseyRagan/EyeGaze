import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Play, RotateCcw } from 'lucide-react';
import { Point2D } from '../../types';
import { gazeBus } from '../../services/gazeBus';
import { soundEngine } from '../../services/audio';
import { viewingGeometry } from '../../services/viewingGeometry';

interface MazeLevel {
  id: string;
  name: string;
  note: string;
  waypoints: Point2D[];
  corridorWidth: number;
}

const LEVELS: MazeLevel[] = [
  {
    id: 'wave',
    name: 'Wave',
    note: 'A wide, gentle path. Follow it slowly.',
    waypoints: [
      { x: 10, y: 50 },
      { x: 30, y: 28 },
      { x: 50, y: 72 },
      { x: 70, y: 28 },
      { x: 90, y: 50 },
    ],
    corridorWidth: 96,
  },
  {
    id: 'switchback',
    name: 'Switchback',
    note: 'Sharp turns. Slow down before each corner.',
    waypoints: [
      { x: 12, y: 20 },
      { x: 82, y: 20 },
      { x: 82, y: 50 },
      { x: 18, y: 50 },
      { x: 18, y: 80 },
      { x: 88, y: 80 },
    ],
    corridorWidth: 74,
  },
  {
    id: 'narrows',
    name: 'Narrows',
    note: 'A narrow corridor. This one needs a good calibration.',
    waypoints: [
      { x: 10, y: 70 },
      { x: 32, y: 30 },
      { x: 54, y: 70 },
      { x: 76, y: 30 },
      { x: 92, y: 60 },
    ],
    corridorWidth: 52,
  },
];

function distanceToPath(p: Point2D, waypoints: Point2D[]): { distance: number; progress: number } {
  let best = Infinity;
  let bestProgress = 0;
  let travelled = 0;

  const lengths = waypoints.slice(1).map((w, i) => Math.hypot(w.x - waypoints[i].x, w.y - waypoints[i].y));
  const total = lengths.reduce((a, b) => a + b, 0) || 1;

  for (let i = 0; i < waypoints.length - 1; i++) {
    const v = waypoints[i];
    const w = waypoints[i + 1];
    const l2 = (v.x - w.x) ** 2 + (v.y - w.y) ** 2;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2));
    const projX = v.x + t * (w.x - v.x);
    const projY = v.y + t * (w.y - v.y);
    const distance = Math.hypot(p.x - projX, p.y - projY);

    if (distance < best) {
      best = distance;
      bestProgress = (travelled + t * lengths[i]) / total;
    }
    travelled += lengths[i];
  }

  return { distance: best, progress: bestProgress };
}

/**
 * Follow the path.
 *
 * A smooth-pursuit and path-following task. Straying is not a failure state —
 * being thrown back to the start after a wobble is discouraging and, for a
 * client working on control, counterproductive. Instead the run records how
 * much of the time the gaze stayed within the corridor and the average
 * deviation in degrees, so improvement is visible even when the run is messy.
 */
export const GazeMazeTask: React.FC = () => {
  const [levelIndex, setLevelIndex] = useState(0);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [onPathPercent, setOnPathPercent] = useState(100);
  const [meanDeviationDeg, setMeanDeviationDeg] = useState(0);
  const [complete, setComplete] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const trailRef = useRef<Point2D[]>([]);
  const statsRef = useRef({ samples: 0, onPath: 0, deviationSum: 0, maxProgress: 0 });
  const runningRef = useRef(false);
  runningRef.current = running;
  const levelRef = useRef(LEVELS[levelIndex]);
  levelRef.current = LEVELS[levelIndex];

  const level = LEVELS[levelIndex];

  const reset = useCallback(() => {
    trailRef.current = [];
    statsRef.current = { samples: 0, onPath: 0, deviationSum: 0, maxProgress: 0 };
    setProgress(0);
    setOnPathPercent(100);
    setMeanDeviationDeg(0);
    setComplete(false);
    setRunning(false);
  }, []);

  useEffect(() => {
    reset();
  }, [levelIndex, reset]);

  // Sampling and drawing both live in one animation frame loop, reading gaze
  // from a ref, so the run does not re-render React sixty times a second.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let latest: { x: number; y: number } | null = null;
    const unsubscribe = gazeBus.subscribe(g => {
      latest = { x: g.screenX, y: g.screenY };
    });

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize);

    let frame = 0;
    let uiTick = 0;

    const render = () => {
      const rect = canvas.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;
      const current = levelRef.current;

      ctx.clearRect(0, 0, w, h);

      const toPx = (p: Point2D) => ({ x: (p.x / 100) * w, y: (p.y / 100) * h });

      // Corridor.
      ctx.beginPath();
      current.waypoints.forEach((p, i) => {
        const q = toPx(p);
        if (i === 0) ctx.moveTo(q.x, q.y);
        else ctx.lineTo(q.x, q.y);
      });
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(143, 188, 175, 0.22)';
      ctx.lineWidth = current.corridorWidth;
      ctx.stroke();

      ctx.strokeStyle = 'rgba(78, 135, 121, 0.35)';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 8]);
      ctx.stroke();
      ctx.setLineDash([]);

      // Start and finish.
      const start = toPx(current.waypoints[0]);
      const end = toPx(current.waypoints[current.waypoints.length - 1]);
      ctx.fillStyle = 'rgba(78, 135, 121, 0.9)';
      ctx.beginPath();
      ctx.arc(start.x, start.y, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(181, 113, 79, 0.9)';
      ctx.beginPath();
      ctx.arc(end.x, end.y, 10, 0, Math.PI * 2);
      ctx.fill();

      if (runningRef.current && latest) {
        const local = { x: latest.x - rect.left, y: latest.y - rect.top };
        if (local.x >= 0 && local.x <= w && local.y >= 0 && local.y <= h) {
          const percentPoint = { x: (local.x / w) * 100, y: (local.y / h) * 100 };
          const { distance, progress: pathProgress } = distanceToPath(percentPoint, current.waypoints);

          // Percentage-space distance is converted back to pixels along the
          // shorter axis, which keeps the corridor test aspect-ratio sane.
          const distancePx = (distance / 100) * Math.min(w, h);
          const stats = statsRef.current;
          stats.samples++;
          stats.deviationSum += distancePx;
          if (distancePx <= current.corridorWidth / 2) stats.onPath++;
          stats.maxProgress = Math.max(stats.maxProgress, pathProgress);

          trailRef.current.push(local);
          if (trailRef.current.length > 400) trailRef.current.shift();

          if (stats.maxProgress > 0.985 && !complete) {
            setComplete(true);
            setRunning(false);
            soundEngine.playLevelComplete();
          }
        }
      }

      if (trailRef.current.length > 1) {
        ctx.beginPath();
        trailRef.current.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
        ctx.strokeStyle = 'rgba(63, 109, 98, 0.75)';
        ctx.lineWidth = 3;
        ctx.stroke();
      }

      // Push numbers to React a few times a second, not every frame.
      uiTick++;
      if (uiTick % 12 === 0) {
        const stats = statsRef.current;
        setProgress(stats.maxProgress);
        if (stats.samples > 0) {
          setOnPathPercent((stats.onPath / stats.samples) * 100);
          setMeanDeviationDeg(viewingGeometry.pixelsToDegrees(stats.deviationSum / stats.samples));
        }
      }

      frame = requestAnimationFrame(render);
    };

    frame = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', resize);
      unsubscribe();
    };
  }, [complete]);

  return (
    <div className="absolute inset-0 overflow-hidden">
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />

      <div className="absolute top-5 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2 surface rounded-full px-2 py-1.5">
        {LEVELS.map((l, i) => (
          <button
            key={l.id}
            onClick={() => setLevelIndex(i)}
            className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
              levelIndex === i ? 'bg-sage-100 text-sage-700' : 'text-ink-soft hover:text-ink'
            }`}
          >
            {l.name}
          </button>
        ))}
      </div>

      <p className="absolute top-20 left-1/2 -translate-x-1/2 text-sm text-ink-faint">{level.note}</p>

      <div className="absolute bottom-5 left-1/2 -translate-x-1/2 surface rounded-2xl px-5 py-3 flex items-center gap-6">
        <div className="text-center">
          <p className="text-xs text-ink-faint">Along the path</p>
          <p className="text-lg font-semibold text-ink tabular-nums">{Math.round(progress * 100)}%</p>
        </div>
        <div className="text-center">
          <p className="text-xs text-ink-faint">Stayed in the corridor</p>
          <p className="text-lg font-semibold text-ink tabular-nums">{Math.round(onPathPercent)}%</p>
        </div>
        <div className="text-center">
          <p className="text-xs text-ink-faint">Average drift</p>
          <p className="text-lg font-semibold text-ink tabular-nums">{meanDeviationDeg.toFixed(1)}°</p>
        </div>

        {complete ? (
          <span className="px-4 py-2 rounded-xl bg-sage-100 text-sage-700 text-sm font-medium">Finished</span>
        ) : (
          <button
            onClick={() => {
              if (running) {
                reset();
              } else {
                trailRef.current = [];
                statsRef.current = { samples: 0, onPath: 0, deviationSum: 0, maxProgress: 0 };
                setComplete(false);
                setRunning(true);
                soundEngine.playChime(520, 0.15);
              }
            }}
            className="px-4 py-2 rounded-xl bg-sage-500 hover:bg-sage-600 text-white text-sm font-medium flex items-center gap-2 transition-colors"
          >
            {running ? <RotateCcw className="w-4 h-4" /> : <Play className="w-4 h-4" />}
            {running ? 'Restart' : 'Start'}
          </button>
        )}
      </div>
    </div>
  );
};
