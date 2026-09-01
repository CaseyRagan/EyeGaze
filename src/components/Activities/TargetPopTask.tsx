import React, { useState, useEffect, useRef } from 'react';
import { Sparkles, Flame, RotateCcw, Target, Zap } from 'lucide-react';
import { GazeState, TargetOrb } from '../../types';
import { soundEngine } from '../../services/audio';
import confetti from 'canvas-confetti';

interface TargetPopTaskProps {
  gaze: GazeState | null;
}

const ORB_COLORS = [
  { bg: 'bg-cyan-500/20', border: 'border-cyan-400', glow: '#06b6d4', text: 'text-cyan-300' },
  { bg: 'bg-amber-500/20', border: 'border-amber-400', glow: '#f59e0b', text: 'text-amber-300' },
  { bg: 'bg-emerald-500/20', border: 'border-emerald-400', glow: '#10b981', text: 'text-emerald-300' },
  { bg: 'bg-purple-500/20', border: 'border-purple-400', glow: '#a855f7', text: 'text-purple-300' },
  { bg: 'bg-rose-500/20', border: 'border-rose-400', glow: '#f43f5e', text: 'text-rose-300' },
];

export const TargetPopTask: React.FC<TargetPopTaskProps> = ({ gaze }) => {
  const [orbs, setOrbs] = useState<TargetOrb[]>([]);
  const [score, setScore] = useState(0);
  const [combo, setCombo] = useState(1);
  const [poppedCount, setPoppedCount] = useState(0);
  const [highScore, setHighScore] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Spawn initial orbs
  const spawnOrb = (): TargetOrb => {
    return {
      id: `orb-${Date.now()}-${Math.random()}`,
      x: 15 + Math.random() * 70, // 15% - 85%
      y: 20 + Math.random() * 65, // 20% - 85%
      radius: 42,
      color: ORB_COLORS[Math.floor(Math.random() * ORB_COLORS.length)].glow,
      value: 100,
      dwellProgress: 0,
      isPopped: false,
      pulsePhase: Math.random() * Math.PI * 2,
    };
  };

  useEffect(() => {
    // Initial 4 orbs
    setOrbs([spawnOrb(), spawnOrb(), spawnOrb(), spawnOrb()]);
  }, []);

  // Main game tick
  useEffect(() => {
    if (!gaze || !containerRef.current) return;

    const rect = containerRef.current.getBoundingClientRect();
    const gx = gaze.screenX - rect.left;
    const gy = gaze.screenY - rect.top;

    if (gx < 0 || gx > rect.width || gy < 0 || gy > rect.height) return;

    const w = rect.width;
    const h = rect.height;

    setOrbs(prevOrbs => {
      let anyPopped = false;
      const activeOrbs = prevOrbs.filter(o => !o.isPopped);

      // Find nearest orb to gaze within magnetic gravity radius (140px)
      let nearestOrbId: string | null = null;
      let minDistance = Infinity;

      activeOrbs.forEach(orb => {
        const orbPxX = (orb.x / 100) * w;
        const orbPxY = (orb.y / 100) * h;
        const dist = Math.hypot(gx - orbPxX, gy - orbPxY);
        if (dist < 140 && dist < minDistance) {
          minDistance = dist;
          nearestOrbId = orb.id;
        }
      });

      const updated = prevOrbs.map(orb => {
        if (orb.isPopped) return orb;

        const orbPxX = (orb.x / 100) * w;
        const orbPxY = (orb.y / 100) * h;
        const dist = Math.hypot(gx - orbPxX, gy - orbPxY);

        // Magnetic gravity well: If nearest within 140px or inside 80px radius
        const isMagnetLocked = orb.id === nearestOrbId || dist < orb.radius + 35;

        if (isMagnetLocked) {
          // Charge dwell progress smoothly based on proximity
          const chargeSpeed = dist < orb.radius ? 0.08 : 0.055;
          const nextProgress = orb.dwellProgress + chargeSpeed;
          if (nextProgress >= 1) {
            anyPopped = true;
            soundEngine.playBubblePop(440 + Math.min(combo * 40, 400));
            return { ...orb, isPopped: true, dwellProgress: 1 };
          }
          return { ...orb, dwellProgress: nextProgress };
        } else {
          return { ...orb, dwellProgress: Math.max(0, orb.dwellProgress - 0.035) };
        }
      });

      if (anyPopped) {
        setScore(s => {
          const newS = s + 100 * combo;
          if (newS > highScore) setHighScore(newS);
          return newS;
        });
        setCombo(c => Math.min(c + 1, 10));
        setPoppedCount(p => p + 1);

        // Respawn new orb
        setTimeout(() => {
          setOrbs(current => [
            ...current.filter(o => !o.isPopped),
            spawnOrb(),
            spawnOrb(),
          ]);
        }, 150);
      }

      return updated;
    });
  }, [gaze, combo, highScore]);

  const resetGame = () => {
    setScore(0);
    setCombo(1);
    setPoppedCount(0);
    setOrbs([spawnOrb(), spawnOrb(), spawnOrb(), spawnOrb()]);
    soundEngine.playChime(350, 0.2);
  };

  return (
    <div
      ref={containerRef}
      id="target-pop-view"
      className="relative w-full h-full flex flex-col bg-slate-950 select-none overflow-hidden"
    >
      {/* Header telemetry */}
      <div className="absolute top-4 left-4 right-4 z-20 flex items-center justify-between pointer-events-auto">
        <div className="bg-slate-900/90 border border-slate-800/90 backdrop-blur-xl px-5 py-2.5 rounded-2xl shadow-xl flex items-center gap-4">
          <div className="flex items-center gap-2">
            <Target className="w-4 h-4 text-cyan-400" />
            <h3 className="text-sm font-bold font-['Outfit'] text-white">
              Gaze Focus & Dwell Burst
            </h3>
          </div>

          <div className="w-px h-4 bg-slate-800" />

          <div className="flex items-center gap-3 text-xs font-mono">
            <div>
              <span className="text-slate-400">Score: </span>
              <span className="text-amber-400 font-bold">{score}</span>
            </div>
            <div>
              <span className="text-slate-400">Popped: </span>
              <span className="text-emerald-300 font-bold">{poppedCount}</span>
            </div>
            {combo > 1 && (
              <div className="flex items-center gap-1 text-purple-400 font-bold animate-pulse">
                <Flame className="w-3.5 h-3.5" />
                <span>{combo}x Multiplier</span>
              </div>
            )}
          </div>
        </div>

        <button
          id="reset-target-pop-btn"
          onClick={resetGame}
          className="p-2.5 bg-slate-900/90 border border-slate-800 rounded-xl text-slate-400 hover:text-white transition-colors cursor-pointer"
          title="Restart Target Pop"
        >
          <RotateCcw className="w-4 h-4" />
        </button>
      </div>

      {/* Floating Target Orbs */}
      <div className="relative flex-1 w-full h-full">
        {orbs.map(orb => {
          if (orb.isPopped) return null;

          return (
            <div
              key={orb.id}
              className="absolute -translate-x-1/2 -translate-y-1/2 pointer-events-none transition-transform duration-75"
              style={{ left: `${orb.x}%`, top: `${orb.y}%` }}
            >
              <div className="relative flex items-center justify-center">
                {/* Glow ring */}
                <div
                  className="absolute w-24 h-24 rounded-full blur-md opacity-40 animate-pulse"
                  style={{ backgroundColor: orb.color }}
                />

                {/* Dwell Progress Ring */}
                <svg className="w-20 h-20 -rotate-90">
                  <circle
                    cx={40}
                    cy={40}
                    r={32}
                    stroke="rgba(255, 255, 255, 0.15)"
                    strokeWidth={4}
                    fill="transparent"
                  />
                  <circle
                    cx={40}
                    cy={40}
                    r={32}
                    stroke={orb.color}
                    strokeWidth={4}
                    fill="transparent"
                    strokeDasharray={2 * Math.PI * 32}
                    strokeDashoffset={(1 - orb.dwellProgress) * (2 * Math.PI * 32)}
                    strokeLinecap="round"
                  />
                </svg>

                {/* Orb Core */}
                <div
                  className="absolute w-14 h-14 rounded-full flex items-center justify-center backdrop-blur-md border border-white/20 shadow-lg"
                  style={{
                    backgroundColor: `${orb.color}33`,
                    boxShadow: `0 0 16px ${orb.color}`,
                  }}
                >
                  <Sparkles className="w-6 h-6 text-white" />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
