import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Download, Eraser, Flame, Pause, PenLine, Play } from 'lucide-react';
import { Point2D, TrackingSettings } from '../types';
import { gazeBus } from '../services/gazeBus';
import { soundEngine } from '../services/audio';
import { HeatmapRenderer } from '../utils/heatmap';

interface GazePaintProps {
  settings: TrackingSettings;
  onUpdateSettings: (patch: Partial<TrackingSettings>) => void;
}

const PALETTE = [
  { name: 'Sage', color: '#4e8779' },
  { name: 'Clay', color: '#b5714f' },
  { name: 'Sky', color: '#5b8fb0' },
  { name: 'Honey', color: '#c99a3c' },
  { name: 'Ink', color: '#2c3230' },
];

/** Points closer together than this are dropped, to keep the stroke smooth. */
const MIN_SEGMENT_PX = 3;
/** Cap on retained points, so a long session cannot grow without bound. */
const MAX_POINTS = 6000;

/**
 * Drawing with the eyes.
 *
 * Strokes live in a ref and are painted inside a single animation frame, not
 * held in React state. That matters here more than anywhere else in the app:
 * the previous version pushed every gaze sample into a state array and redrew
 * the whole canvas from a callback that was itself recreated on every sample,
 * so a minute of drawing meant thousands of reconciliations over an
 * ever-growing array.
 */
export const GazePaint: React.FC<GazePaintProps> = ({ settings, onUpdateSettings }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const strokesRef = useRef<Point2D[][]>([]);
  const currentRef = useRef<Point2D[]>([]);
  const heatmapRef = useRef(new HeatmapRenderer());

  const [drawing, setDrawing] = useState(true);
  const [colorIndex, setColorIndex] = useState(0);
  const [width, setWidth] = useState(settings.strokeWidth || 6);
  const [showHeatmap, setShowHeatmap] = useState(false);
  const [pointCount, setPointCount] = useState(0);

  const drawingRef = useRef(drawing);
  drawingRef.current = drawing;
  const colorRef = useRef(PALETTE[colorIndex].color);
  colorRef.current = PALETTE[colorIndex].color;
  const widthRef = useRef(width);
  widthRef.current = width;
  const heatmapOnRef = useRef(showHeatmap);
  heatmapOnRef.current = showHeatmap;

  const clear = useCallback(() => {
    strokesRef.current = [];
    currentRef.current = [];
    heatmapRef.current.clear();
    setPointCount(0);
    soundEngine.playChime(360, 0.18, 'triangle');
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let dpr = window.devicePixelRatio || 1;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      dpr = window.devicePixelRatio || 1;
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      heatmapRef.current.resize(rect.width, rect.height);
    };
    resize();
    window.addEventListener('resize', resize);

    let latest: Point2D | null = null;
    const unsubscribe = gazeBus.subscribe(gaze => {
      if (gaze.isHeld || gaze.event === 'lost') return;
      latest = { x: gaze.screenX, y: gaze.screenY, time: gaze.timestamp };
    });

    let frame = 0;
    let uiTick = 0;

    const render = () => {
      const rect = canvas.getBoundingClientRect();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, rect.width, rect.height);

      if (latest) {
        const local: Point2D = { x: latest.x - rect.left, y: latest.y - rect.top, time: latest.time };
        const inside = local.x >= 0 && local.x <= rect.width && local.y >= 0 && local.y <= rect.height;

        if (inside) {
          heatmapRef.current.addPoint(local.x, local.y, true);

          if (drawingRef.current) {
            const last = currentRef.current[currentRef.current.length - 1];
            if (!last || Math.hypot(local.x - last.x, local.y - last.y) >= MIN_SEGMENT_PX) {
              currentRef.current.push(local);
              if (currentRef.current.length > MAX_POINTS) currentRef.current.shift();
            }
          }
        }
      }

      if (heatmapOnRef.current) heatmapRef.current.render(ctx);

      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      const drawStroke = (points: Point2D[], stroke: string, lineWidth: number) => {
        if (points.length < 2) return;
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        // Quadratic smoothing through midpoints removes the visible corners a
        // sampled gaze path would otherwise leave on every frame boundary.
        for (let i = 1; i < points.length - 1; i++) {
          const mid = { x: (points[i].x + points[i + 1].x) / 2, y: (points[i].y + points[i + 1].y) / 2 };
          ctx.quadraticCurveTo(points[i].x, points[i].y, mid.x, mid.y);
        }
        ctx.lineTo(points[points.length - 1].x, points[points.length - 1].y);
        ctx.strokeStyle = stroke;
        ctx.lineWidth = lineWidth;
        ctx.stroke();
      };

      strokesRef.current.forEach(stroke => drawStroke(stroke, colorRef.current, widthRef.current));
      drawStroke(currentRef.current, colorRef.current, widthRef.current);

      uiTick++;
      if (uiTick % 20 === 0) {
        const total = strokesRef.current.reduce((sum, s) => sum + s.length, 0) + currentRef.current.length;
        setPointCount(total);
      }

      frame = requestAnimationFrame(render);
    };

    frame = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', resize);
      unsubscribe();
    };
  }, []);

  // Pausing ends the current stroke so resuming starts a new one rather than
  // drawing a straight line across the gap.
  const togglePause = () => {
    setDrawing(prev => {
      if (prev && currentRef.current.length > 1) {
        strokesRef.current.push(currentRef.current);
        currentRef.current = [];
      }
      return !prev;
    });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.code === 'Space') {
        e.preventDefault();
        togglePause();
      } else if (e.key === 'm' || e.key === 'M') {
        // H is the global head-guide toggle, so the heatmap uses M for map.
        setShowHeatmap(v => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const download = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const link = document.createElement('a');
    link.download = `gaze-drawing-${Date.now()}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
  };

  return (
    <div className="absolute inset-0">
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />

      <div className="absolute bottom-5 left-1/2 -translate-x-1/2 surface rounded-2xl px-4 py-3 flex items-center gap-4 flex-wrap justify-center">
        <button
          onClick={togglePause}
          className={`px-4 py-2 rounded-xl text-sm font-medium flex items-center gap-2 transition-colors ${
            drawing ? 'bg-sage-500 text-white hover:bg-sage-600' : 'border border-strong text-ink hover:bg-[var(--surface-sunken)]'
          }`}
        >
          {drawing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
          {drawing ? 'Drawing' : 'Paused'}
        </button>

        <div className="flex items-center gap-1.5">
          {PALETTE.map((swatch, i) => (
            <button
              key={swatch.name}
              onClick={() => setColorIndex(i)}
              title={swatch.name}
              className={`w-7 h-7 rounded-full border-2 transition-transform ${
                colorIndex === i ? 'border-ink scale-110' : 'border-transparent'
              }`}
              style={{ backgroundColor: swatch.color }}
            />
          ))}
        </div>

        <label className="flex items-center gap-2 text-sm text-ink-soft">
          <PenLine className="w-4 h-4" />
          <input
            type="range"
            min={2}
            max={22}
            value={width}
            onChange={e => {
              setWidth(Number(e.target.value));
              onUpdateSettings({ strokeWidth: Number(e.target.value) });
            }}
            className="w-24"
          />
        </label>

        <button
          onClick={() => setShowHeatmap(v => !v)}
          title="Show where your gaze spent the most time"
          className={`p-2 rounded-xl transition-colors ${
            showHeatmap ? 'bg-clay-100 text-clay-500' : 'text-ink-faint hover:text-ink hover:bg-[var(--surface-sunken)]'
          }`}
        >
          <Flame className="w-4 h-4" />
        </button>

        <button
          onClick={download}
          className="p-2 rounded-xl text-ink-faint hover:text-ink hover:bg-[var(--surface-sunken)] transition-colors"
          aria-label="Save the drawing"
        >
          <Download className="w-4 h-4" />
        </button>

        <button
          onClick={clear}
          className="p-2 rounded-xl text-ink-faint hover:text-ink hover:bg-[var(--surface-sunken)] transition-colors"
          aria-label="Clear"
        >
          <Eraser className="w-4 h-4" />
        </button>

        <span className="text-xs text-ink-faint tabular-nums w-16 text-right">{pointCount} pts</span>
      </div>
    </div>
  );
};
