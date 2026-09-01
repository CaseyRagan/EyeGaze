import React, { useState, useEffect, useRef } from 'react';
import { Compass, RotateCcw, Trophy, ShieldAlert, Award } from 'lucide-react';
import { GazeState, Point2D } from '../../types';
import { soundEngine } from '../../services/audio';
import confetti from 'canvas-confetti';

interface GazeMazeTaskProps {
  gaze: GazeState | null;
}

interface MazePath {
  start: Point2D;
  end: Point2D;
  waypoints: Point2D[];
  corridorWidth: number;
}

const MAZE_LEVELS: { id: string; name: string; difficulty: string; path: MazePath }[] = [
  {
    id: 'river-glide',
    name: 'Serpentine River',
    difficulty: 'Novice',
    path: {
      start: { x: 12, y: 50 },
      end: { x: 88, y: 50 },
      waypoints: [
        { x: 12, y: 50 },
        { x: 28, y: 25 },
        { x: 50, y: 75 },
        { x: 72, y: 25 },
        { x: 88, y: 50 },
      ],
      corridorWidth: 90,
    },
  },
  {
    id: 'spiral-zen',
    name: 'Cosmic Vortex',
    difficulty: 'Adept',
    path: {
      start: { x: 15, y: 20 },
      end: { x: 85, y: 80 },
      waypoints: [
        { x: 15, y: 20 },
        { x: 80, y: 20 },
        { x: 80, y: 50 },
        { x: 25, y: 50 },
        { x: 25, y: 80 },
        { x: 85, y: 80 },
      ],
      corridorWidth: 75,
    },
  },
];

export const GazeMazeTask: React.FC<GazeMazeTaskProps> = ({ gaze }) => {
  const [levelIdx, setLevelIdx] = useState(0);
  const [mazeStroke, setMazeStroke] = useState<Point2D[]>([]);
  const [gameState, setGameState] = useState<'idle' | 'running' | 'failed' | 'victory'>('idle');
  const [offCourseCount, setOffCourseCount] = useState(0);
  const [progressPercent, setProgressPercent] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const currentLevel = MAZE_LEVELS[levelIdx];

  const resetGame = () => {
    setMazeStroke([]);
    setGameState('idle');
    setOffCourseCount(0);
    setProgressPercent(0);
    soundEngine.playChime(400, 0.2);
  };

  useEffect(() => {
    resetGame();
  }, [levelIdx]);

  // Distance from point to line segment
  const distToSegment = (p: Point2D, v: Point2D, w: Point2D) => {
    const l2 = (v.x - w.x) ** 2 + (v.y - w.y) ** 2;
    if (l2 === 0) return Math.hypot(p.x - v.x, p.y - v.y);
    let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (v.x + t * (w.x - v.x)), p.y - (v.y + t * (w.y - v.y)));
  };

  // Main maze loop
  useEffect(() => {
    if (!gaze || gameState === 'failed' || gameState === 'victory') return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const gx = gaze.screenX - rect.left;
    const gy = gaze.screenY - rect.top;

    if (gx < 0 || gx > rect.width || gy < 0 || gy > rect.height) return;

    const w = rect.width;
    const h = rect.height;
    const currentPt: Point2D = { x: gx, y: gy };

    const startPx: Point2D = {
      x: (currentLevel.path.start.x / 100) * w,
      y: (currentLevel.path.start.y / 100) * h,
    };
    const endPx: Point2D = {
      x: (currentLevel.path.end.x / 100) * w,
      y: (currentLevel.path.end.y / 100) * h,
    };

    // Check Start Portal
    if (gameState === 'idle') {
      if (Math.hypot(gx - startPx.x, gy - startPx.y) < 55) {
        setGameState('running');
        setMazeStroke([currentPt]);
        soundEngine.playChime(523, 0.3);
      }
      return;
    }

    if (gameState === 'running') {
      setMazeStroke(prev => [...prev.slice(-300), currentPt]);

      // Check distance to any waypoint segment
      const pts = currentLevel.path.waypoints.map(wp => ({
        x: (wp.x / 100) * w,
        y: (wp.y / 100) * h,
      }));

      let minDist = Infinity;
      for (let i = 0; i < pts.length - 1; i++) {
        const d = distToSegment(currentPt, pts[i], pts[i + 1]);
        minDist = Math.min(minDist, d);
      }

      // Check boundary breach
      if (minDist > currentLevel.path.corridorWidth / 2) {
        setOffCourseCount(c => c + 1);
        soundEngine.playChime(150, 0.15, 'sawtooth');
      }

      // Check distance to End Portal
      const distToEnd = Math.hypot(gx - endPx.x, gy - endPx.y);
      if (distToEnd < 50) {
        setGameState('victory');
        soundEngine.playLevelComplete();
        try {
          confetti({
            particleCount: 70,
            spread: 70,
            origin: { y: 0.5 },
          });
        } catch {}
      }
    }
  }, [gaze, gameState, currentLevel]);

  // Render Maze Canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    canvas.width = canvas.parentElement?.clientWidth || 800;
    canvas.height = canvas.parentElement?.clientHeight || 600;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const w = canvas.width;
    const h = canvas.height;
    const wp = currentLevel.path.waypoints.map(p => ({
      x: (p.x / 100) * w,
      y: (p.y / 100) * h,
    }));

    // Draw Path Corridor (Safe Zone)
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(wp[0].x, wp[0].y);
    for (let i = 1; i < wp.length; i++) {
      ctx.lineTo(wp[i].x, wp[i].y);
    }
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = currentLevel.path.corridorWidth;
    ctx.strokeStyle = 'rgba(30, 41, 59, 0.7)';
    ctx.stroke();

    // Corridor Boundaries Glow
    ctx.lineWidth = currentLevel.path.corridorWidth + 4;
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.2)';
    ctx.stroke();

    // Center Guide dashed line
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 8]);
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.3)';
    ctx.stroke();
    ctx.setLineDash([]);

    // Draw active user gaze trace
    if (mazeStroke.length > 1) {
      ctx.beginPath();
      ctx.moveTo(mazeStroke[0].x, mazeStroke[0].y);
      for (let i = 1; i < mazeStroke.length; i++) {
        ctx.lineTo(mazeStroke[i].x, mazeStroke[i].y);
      }
      ctx.lineWidth = 4;
      ctx.strokeStyle = offCourseCount > 15 ? '#f43f5e' : '#38bdf8';
      ctx.shadowColor = '#0284c7';
      ctx.shadowBlur = 12;
      ctx.stroke();
    }

    ctx.restore();
  }, [mazeStroke, currentLevel, offCourseCount]);

  return (
    <div id="gaze-maze-view" className="relative w-full h-full flex flex-col bg-slate-950 select-none overflow-hidden">
      {/* Top Controls */}
      <div className="absolute top-4 left-4 right-4 z-20 flex items-center justify-between pointer-events-auto">
        <div className="bg-slate-900/90 border border-slate-800/90 backdrop-blur-xl px-5 py-2.5 rounded-2xl shadow-xl">
          <div className="flex items-center gap-2">
            <Compass className="w-4 h-4 text-cyan-400" />
            <h3 className="text-sm font-bold font-['Outfit'] text-white">
              {currentLevel.name}
            </h3>
            <span className="text-xs px-2 py-0.5 rounded-full bg-cyan-500/10 border border-cyan-500/20 text-cyan-300 font-mono">
              {currentLevel.difficulty}
            </span>
          </div>
          <p className="text-xs text-slate-400 mt-0.5">
            {gameState === 'idle'
              ? 'Focus on START circle to begin'
              : 'Guide your continuous eye gaze thread to the GOAL portal'}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            id="reset-maze-btn"
            onClick={resetGame}
            className="p-2.5 bg-slate-900/90 border border-slate-800 rounded-xl text-slate-400 hover:text-white transition-colors cursor-pointer"
            title="Restart Maze"
          >
            <RotateCcw className="w-4 h-4" />
          </button>
          <button
            id="next-maze-level-btn"
            onClick={() => setLevelIdx((levelIdx + 1) % MAZE_LEVELS.length)}
            className="px-3.5 py-2 bg-slate-900/90 border border-slate-800 hover:border-cyan-500/50 rounded-xl text-xs font-semibold text-slate-200 hover:text-white transition-all cursor-pointer"
          >
            Next Track
          </button>
        </div>
      </div>

      {/* Canvas */}
      <div className="relative flex-1 w-full h-full">
        <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />

        {/* Start Node */}
        <div
          className="absolute -translate-x-1/2 -translate-y-1/2 pointer-events-none"
          style={{ left: `${currentLevel.path.start.x}%`, top: `${currentLevel.path.start.y}%` }}
        >
          <div className="w-16 h-16 rounded-full bg-emerald-500/20 border-2 border-emerald-400 flex flex-col items-center justify-center text-emerald-300 shadow-[0_0_20px_#10b981] animate-pulse">
            <span className="text-[11px] font-bold tracking-wider">START</span>
          </div>
        </div>

        {/* End / Goal Node */}
        <div
          className="absolute -translate-x-1/2 -translate-y-1/2 pointer-events-none"
          style={{ left: `${currentLevel.path.end.x}%`, top: `${currentLevel.path.end.y}%` }}
        >
          <div className="w-16 h-16 rounded-full bg-purple-500/20 border-2 border-purple-400 flex flex-col items-center justify-center text-purple-300 shadow-[0_0_20px_#a855f7] animate-pulse">
            <Trophy className="w-4 h-4 mb-0.5" />
            <span className="text-[10px] font-bold tracking-wider">GOAL</span>
          </div>
        </div>

        {/* Victory Dialog */}
        {gameState === 'victory' && (
          <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-6 z-30 animate-in fade-in zoom-in-95">
            <div className="bg-slate-900 border border-emerald-500/30 rounded-3xl p-8 max-w-sm text-center shadow-2xl space-y-5">
              <div className="w-16 h-16 rounded-2xl bg-emerald-500/20 border border-emerald-400 flex items-center justify-center mx-auto text-emerald-300 shadow-[0_0_30px_rgba(16,185,129,0.4)]">
                <Award className="w-8 h-8" />
              </div>
              <div>
                <h4 className="text-xl font-bold font-['Outfit'] text-white">
                  Labyrinth Conquered!
                </h4>
                <p className="text-xs text-slate-300 mt-1">
                  Remarkable gaze motor precision! You traversed {currentLevel.name} without losing path stability.
                </p>
              </div>

              <div className="flex gap-3">
                <button
                  id="replay-maze-btn"
                  onClick={resetGame}
                  className="flex-1 py-2.5 px-4 rounded-xl border border-slate-700 text-xs font-semibold text-slate-300 hover:bg-slate-800 transition-colors cursor-pointer"
                >
                  Replay
                </button>
                <button
                  id="advance-maze-btn"
                  onClick={() => setLevelIdx((levelIdx + 1) % MAZE_LEVELS.length)}
                  className="flex-1 py-2.5 px-4 rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 text-xs font-semibold text-white shadow-lg shadow-cyan-500/25 transition-all cursor-pointer"
                >
                  Next Maze
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
