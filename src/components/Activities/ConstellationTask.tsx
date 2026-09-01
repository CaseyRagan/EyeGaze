import React, { useState, useEffect, useRef } from 'react';
import { Sparkles, Trophy, RotateCcw, ArrowRight, Star } from 'lucide-react';
import { ConstellationLevel, GazeState, Point2D } from '../../types';
import { soundEngine } from '../../services/audio';
import confetti from 'canvas-confetti';

const CONSTELLATIONS: ConstellationLevel[] = [
  {
    id: 'orion-belt',
    title: 'The Hunter (Orion)',
    subtitle: 'Connect the 5 bright stars of Orion with your gaze stroke',
    stars: [
      { id: 1, x: 25, y: 30, name: 'Betelgeuse' },
      { id: 2, x: 42, y: 50, name: 'Alnitak' },
      { id: 3, x: 50, y: 50, name: 'Alnilam' },
      { id: 4, x: 58, y: 50, name: 'Mintaka' },
      { id: 5, x: 75, y: 72, name: 'Rigel' },
    ],
    connections: [[1, 2], [2, 3], [3, 4], [4, 5]],
  },
  {
    id: 'cassiopeia',
    title: 'The Queen (Cassiopeia)',
    subtitle: 'Trace the legendary cosmic W-shape in the sky',
    stars: [
      { id: 1, x: 20, y: 40, name: 'Caph' },
      { id: 2, x: 35, y: 65, name: 'Schedar' },
      { id: 3, x: 50, y: 35, name: 'Navi' },
      { id: 4, x: 65, y: 70, name: 'Ruchbah' },
      { id: 5, x: 80, y: 45, name: 'Segin' },
    ],
    connections: [[1, 2], [2, 3], [3, 4], [4, 5]],
  },
  {
    id: 'ursa-major',
    title: 'The Great Bear (Ursa Major)',
    subtitle: 'Follow the 7 celestial stars of the celestial ladle',
    stars: [
      { id: 1, x: 18, y: 35, name: 'Alkaid' },
      { id: 2, x: 30, y: 42, name: 'Mizar' },
      { id: 3, x: 42, y: 50, name: 'Alioth' },
      { id: 4, x: 55, y: 52, name: 'Megrez' },
      { id: 5, x: 52, y: 70, name: 'Phecda' },
      { id: 6, x: 72, y: 72, name: 'Merak' },
      { id: 7, x: 75, y: 50, name: 'Dubhe' },
    ],
    connections: [[1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 4]],
  },
];

interface ConstellationTaskProps {
  gaze: GazeState | null;
}

export const ConstellationTask: React.FC<ConstellationTaskProps> = ({ gaze }) => {
  const [levelIndex, setLevelIndex] = useState(0);
  const [connectedStars, setConnectedStars] = useState<number[]>([]);
  const [gazeStroke, setGazeStroke] = useState<Point2D[]>([]);
  const [isCompleted, setIsCompleted] = useState(false);
  const [dwellTimers, setDwellTimers] = useState<{ [key: number]: number }>({});
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const currentLevel = CONSTELLATIONS[levelIndex];
  const nextTargetStarId = currentLevel.stars[connectedStars.length]?.id;

  // Reset on level switch
  useEffect(() => {
    setConnectedStars([]);
    setGazeStroke([]);
    setIsCompleted(false);
    setDwellTimers({});
  }, [levelIndex]);

  // Main game loop
  useEffect(() => {
    if (!gaze || isCompleted) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const gx = gaze.screenX - rect.left;
    const gy = gaze.screenY - rect.top;

    if (gx < 0 || gx > rect.width || gy < 0 || gy > rect.height) return;

    // Track active gaze line
    setGazeStroke(prev => {
      const p = { x: gx, y: gy };
      if (prev.length > 300) return [...prev.slice(1), p];
      return [...prev, p];
    });

    // Check hit test for next target star
    if (nextTargetStarId !== undefined) {
      const star = currentLevel.stars.find(s => s.id === nextTargetStarId);
      if (star) {
        const starPixelX = (star.x / 100) * rect.width;
        const starPixelY = (star.y / 100) * rect.height;
        const dist = Math.hypot(gx - starPixelX, gy - starPixelY);

        // Magnetic hit radius (generous 110px with gravitational capture)
        if (dist < 110) {
          setDwellTimers(prev => {
            const increment = dist < 50 ? 2 : 1;
            const current = (prev[star.id] || 0) + increment;
            if (current >= 12) {
              // Star connected!
              const newConnected = [...connectedStars, star.id];
              setConnectedStars(newConnected);
              soundEngine.playStarConnect(newConnected.length - 1);

              if (newConnected.length === currentLevel.stars.length) {
                setIsCompleted(true);
                soundEngine.playLevelComplete();
                try {
                  confetti({
                    particleCount: 80,
                    spread: 80,
                    origin: { y: 0.5 },
                    colors: ['#38bdf8', '#fbbf24', '#c084fc', '#34d399']
                  });
                } catch {}
              }
              return { ...prev, [star.id]: 0 };
            }
            return { ...prev, [star.id]: current };
          });
        } else {
          setDwellTimers(prev => ({ ...prev, [star.id]: Math.max(0, (prev[star.id] || 0) - 1) }));
        }
      }
    }
  }, [gaze, connectedStars, nextTargetStarId, isCompleted, currentLevel]);

  // Canvas rendering
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

    // Draw background nebula stars
    ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
    for (let i = 0; i < 40; i++) {
      const sx = ((i * 137.5) % w);
      const sy = ((i * 293.7) % h);
      ctx.beginPath();
      ctx.arc(sx, sy, (i % 3 === 0) ? 1.5 : 0.8, 0, Math.PI * 2);
      ctx.fill();
    }

    // Draw established constellation lines
    ctx.save();
    for (let i = 0; i < connectedStars.length - 1; i++) {
      const s1 = currentLevel.stars.find(s => s.id === connectedStars[i]);
      const s2 = currentLevel.stars.find(s => s.id === connectedStars[i + 1]);
      if (s1 && s2) {
        const x1 = (s1.x / 100) * w;
        const y1 = (s1.y / 100) * h;
        const x2 = (s2.x / 100) * w;
        const y2 = (s2.y / 100) * h;

        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 4;
        ctx.shadowColor = '#0284c7';
        ctx.shadowBlur = 14;
        ctx.stroke();

        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.shadowBlur = 4;
        ctx.stroke();
      }
    }

    // Draw active gaze line thread
    if (gazeStroke.length > 1) {
      ctx.beginPath();
      ctx.moveTo(gazeStroke[0].x, gazeStroke[0].y);
      for (let i = 1; i < gazeStroke.length; i++) {
        ctx.lineTo(gazeStroke[i].x, gazeStroke[i].y);
      }
      ctx.strokeStyle = 'rgba(251, 191, 36, 0.45)';
      ctx.lineWidth = 2.5;
      ctx.shadowColor = '#d97706';
      ctx.shadowBlur = 8;
      ctx.stroke();
    }

    ctx.restore();
  }, [connectedStars, gazeStroke, currentLevel]);

  return (
    <div id="constellation-task-view" className="relative w-full h-full flex flex-col bg-slate-950 select-none overflow-hidden">
      {/* Top Header Controls */}
      <div className="absolute top-4 left-4 right-4 z-20 flex items-center justify-between pointer-events-auto">
        <div className="bg-slate-900/90 border border-slate-800/90 backdrop-blur-xl px-5 py-2.5 rounded-2xl shadow-xl">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-amber-400" />
            <h3 className="text-sm font-bold font-['Outfit'] text-white">
              {currentLevel.title}
            </h3>
            <span className="text-xs text-slate-400 font-mono">
              ({connectedStars.length}/{currentLevel.stars.length} Stars)
            </span>
          </div>
          <p className="text-xs text-slate-400 mt-0.5">
            {currentLevel.subtitle}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            id="reset-constellation-btn"
            onClick={() => {
              setConnectedStars([]);
              setGazeStroke([]);
              setIsCompleted(false);
              soundEngine.playChime(350, 0.2);
            }}
            className="p-2.5 bg-slate-900/90 border border-slate-800 rounded-xl text-slate-400 hover:text-white transition-colors cursor-pointer"
            title="Reset Constellation"
          >
            <RotateCcw className="w-4 h-4" />
          </button>

          <button
            id="next-constellation-level-btn"
            onClick={() => setLevelIndex((levelIndex + 1) % CONSTELLATIONS.length)}
            className="px-3.5 py-2 bg-slate-900/90 border border-slate-800 hover:border-cyan-500/50 rounded-xl text-xs font-semibold text-slate-200 hover:text-white flex items-center gap-2 transition-all cursor-pointer"
          >
            <span>Next Level</span>
            <ArrowRight className="w-3.5 h-3.5 text-cyan-400" />
          </button>
        </div>
      </div>

      {/* Canvas Area */}
      <div className="relative flex-1 w-full h-full">
        <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />

        {/* Render Constellation Star Nodes */}
        {currentLevel.stars.map((star) => {
          const isConnected = connectedStars.includes(star.id);
          const isNext = star.id === nextTargetStarId;
          const dwell = (dwellTimers[star.id] || 0) / 12;

          return (
            <div
              key={star.id}
              className="absolute -translate-x-1/2 -translate-y-1/2 pointer-events-none transition-transform duration-200"
              style={{ left: `${star.x}%`, top: `${star.y}%` }}
            >
              <div className="relative flex items-center justify-center">
                {/* Glow ring */}
                {isNext && (
                  <>
                    <div className="absolute w-20 h-20 rounded-full border border-amber-400/40 animate-ping" />
                    <div className="absolute w-14 h-14 rounded-full border-2 border-amber-400/80 animate-pulse" />
                    
                    {/* Dwell charge progress */}
                    {dwell > 0 && (
                      <svg className="absolute w-16 h-16 -rotate-90">
                        <circle
                          cx={32}
                          cy={32}
                          r={24}
                          stroke="#fbbf24"
                          strokeWidth={3}
                          fill="transparent"
                          strokeDasharray={2 * Math.PI * 24}
                          strokeDashoffset={(1 - dwell) * (2 * Math.PI * 24)}
                        />
                      </svg>
                    )}
                  </>
                )}

                {/* Star Core */}
                <div
                  className={`rounded-full flex items-center justify-center transition-all duration-300 ${
                    isConnected
                      ? 'w-9 h-9 bg-cyan-500 shadow-[0_0_20px_#38bdf8] text-white'
                      : isNext
                      ? 'w-9 h-9 bg-amber-400 shadow-[0_0_24px_#fbbf24] text-slate-950 font-bold scale-110'
                      : 'w-7 h-7 bg-slate-800 border border-slate-700 text-slate-400'
                  }`}
                >
                  <Star className={`w-4 h-4 ${isConnected ? 'fill-white' : isNext ? 'fill-slate-950 animate-spin' : ''}`} />
                </div>

                {/* Star Label */}
                <div className="absolute top-10 whitespace-nowrap px-2 py-0.5 rounded-md bg-slate-900/80 backdrop-blur-md border border-slate-800 text-[11px] font-mono text-slate-300">
                  {star.id}. {star.name}
                </div>
              </div>
            </div>
          );
        })}

        {/* Completion Modal Overlay */}
        {isCompleted && (
          <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-md flex items-center justify-center p-6 z-30 animate-in fade-in zoom-in-95">
            <div className="bg-slate-900 border border-cyan-500/30 rounded-3xl p-8 max-w-sm text-center shadow-2xl space-y-5">
              <div className="w-16 h-16 rounded-2xl bg-cyan-500/20 border border-cyan-400 flex items-center justify-center mx-auto text-cyan-300 shadow-[0_0_30px_rgba(6,182,212,0.4)]">
                <Trophy className="w-8 h-8 animate-bounce" />
              </div>
              <div>
                <h4 className="text-xl font-bold font-['Outfit'] text-white">
                  Constellation Awakened!
                </h4>
                <p className="text-xs text-slate-300 mt-1">
                  You connected all {currentLevel.stars.length} stars of {currentLevel.title} with a single eye gaze stroke!
                </p>
              </div>

              <div className="flex gap-3">
                <button
                  id="replay-constellation-btn"
                  onClick={() => {
                    setConnectedStars([]);
                    setGazeStroke([]);
                    setIsCompleted(false);
                  }}
                  className="flex-1 py-2.5 px-4 rounded-xl border border-slate-700 text-xs font-semibold text-slate-300 hover:bg-slate-800 transition-colors cursor-pointer"
                >
                  Replay
                </button>
                <button
                  id="next-level-btn"
                  onClick={() => setLevelIndex((levelIndex + 1) % CONSTELLATIONS.length)}
                  className="flex-1 py-2.5 px-4 rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 text-xs font-semibold text-white shadow-lg shadow-cyan-500/25 transition-all cursor-pointer"
                >
                  Next Sky Map
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
