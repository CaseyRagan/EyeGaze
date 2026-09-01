import React, { useEffect, useRef } from 'react';
import { GazeState } from '../types';

interface GazeCursorProps {
  gaze: GazeState | null;
  dwellProgress?: number; // 0 to 1
  isDrawing?: boolean;
  color?: string;
  glowColor?: string;
  showTrail?: boolean;
}

export const GazeCursor: React.FC<GazeCursorProps> = ({
  gaze,
  dwellProgress = 0,
  isDrawing = false,
  color = '#38bdf8',
  glowColor = '#0284c7',
  showTrail = true,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const trailRef = useRef<Array<{ x: number; y: number; alpha: number; radius: number }>>([]);
  const animRef = useRef<number | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const handleResize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    handleResize();
    window.addEventListener('resize', handleResize);

    const render = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      if (gaze && showTrail) {
        trailRef.current.push({
          x: gaze.screenX,
          y: gaze.screenY,
          alpha: 0.8,
          radius: isDrawing ? 4 : 2.5,
        });

        if (trailRef.current.length > 24) {
          trailRef.current.shift();
        }
      }

      // Draw particle trail
      for (let i = 0; i < trailRef.current.length; i++) {
        const p = trailRef.current[i];
        p.alpha *= 0.92;
        p.radius *= 0.96;

        if (p.alpha > 0.05) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, Math.max(1, p.radius), 0, Math.PI * 2);
          ctx.fillStyle = isDrawing
            ? `rgba(16, 185, 129, ${p.alpha * 0.7})`
            : `rgba(45, 212, 191, ${p.alpha * 0.4})`;
          ctx.shadowColor = '#10b981';
          ctx.shadowBlur = 8;
          ctx.fill();
        }
      }

      animRef.current = requestAnimationFrame(render);
    };

    animRef.current = requestAnimationFrame(render);

    return () => {
      if (animRef.current) cancelAnimationFrame(animRef.current);
      window.removeEventListener('resize', handleResize);
    };
  }, [gaze, isDrawing, showTrail, glowColor]);

  if (!gaze) return null;

  const { screenX, screenY, isBlinkingBoth, isFixating } = gaze;
  
  // Calculate instant velocity for stretching effect
  let stretchX = 1;
  let stretchY = 1;
  let angle = 0;
  
  if (trailRef.current.length >= 2) {
    const recent = trailRef.current[trailRef.current.length - 1];
    const prev = trailRef.current[trailRef.current.length - 2];
    const dx = recent.x - prev.x;
    const dy = recent.y - prev.y;
    const velocity = Math.hypot(dx, dy);
    
    // Stretch if moving fast, max stretch 1.8x
    const stretchFactor = Math.min(1.8, 1 + velocity / 40);
    stretchX = stretchFactor;
    stretchY = Math.max(0.6, 1 / (stretchFactor * 0.8)); // Squeeze perpendicular
    angle = Math.atan2(dy, dx) * (180 / Math.PI);
  }

  const outerRadius = isDrawing ? 20 : 16;
  const circumference = 2 * Math.PI * 13;
  const strokeDashoffset = circumference - dwellProgress * circumference;

  return (
    <>
      <canvas
        ref={canvasRef}
        className="fixed inset-0 pointer-events-none z-40"
        aria-hidden="true"
      />
      <div
        id="gaze-cursor-reticle"
        className="fixed pointer-events-none z-50 transition-transform ease-out"
        style={{
          transform: `translate(${screenX - outerRadius}px, ${screenY - outerRadius}px) rotate(${angle}deg) scale(${isBlinkingBoth ? 1.3 : 1})`,
          width: `${outerRadius * 2}px`,
          height: `${outerRadius * 2}px`,
          transitionDuration: isBlinkingBoth ? '150ms' : '40ms'
        }}
      >
        <div style={{ transform: `scaleX(${stretchX}) scaleY(${stretchY})`, width: '100%', height: '100%', transition: 'transform 40ms linear' }}>
          {/* Subtle ethereal emerald glow */}
          <div
            className={`absolute inset-0 rounded-full blur-[4px] transition-all ${
              isBlinkingBoth ? 'opacity-80 bg-amber-500 scale-125' : isDrawing ? 'opacity-60 bg-emerald-500' : 'opacity-20 bg-teal-400'
            }`}
          />

          {/* Outer reticle ring: crisp white/50 with fine border */}
          <div
            className={`absolute inset-0 rounded-full border transition-all duration-150 ${
              gaze.isSnapped
                ? 'scale-110 border-emerald-400 bg-emerald-500/20 shadow-[0_0_16px_#10b981]'
                : isBlinkingBoth
                ? 'border-amber-400 bg-amber-500/30 border-2'
                : isFixating
                ? 'scale-105 border-white/80'
                : 'border-white/50'
            }`}
            style={{
              boxShadow: `0 0 10px rgba(16, 185, 129, ${isBlinkingBoth ? '0' : '0.4'})`,
            }}
          />

          {/* Eye Blink Indicator Dot */}
          {isBlinkingBoth && (
             <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-4 h-1.5 bg-amber-200 rounded-full shadow-[0_0_8px_#fcd34d]" />
          )}

          {/* Dwell progress SVG ring */}
          {dwellProgress > 0 && !isBlinkingBoth && (
            <svg className="absolute inset-0 w-full h-full -rotate-90">
              <circle
                cx={outerRadius}
                cy={outerRadius}
                r={13}
                stroke="rgba(255, 255, 255, 0.15)"
                strokeWidth={2}
                fill="transparent"
              />
              <circle
                cx={outerRadius}
                cy={outerRadius}
                r={13}
                stroke="#10b981"
                strokeWidth={2}
                fill="transparent"
                strokeDasharray={circumference}
                strokeDashoffset={strokeDashoffset}
                strokeLinecap="round"
                style={{ transition: 'stroke-dashoffset 40ms linear' }}
            />
          </svg>
        )}

        {/* Center Active Iris Core (Pulsing white dot) */}
        <div className="absolute inset-0 flex items-center justify-center">
          <div
            className={`rounded-full transition-all duration-100 ${
              isDrawing
                ? 'w-2 h-2 bg-emerald-400 shadow-[0_0_8px_#34d399]'
                : isFixating
                ? 'w-2 h-2 bg-white shadow-[0_0_8px_#ffffff] animate-pulse'
                : 'w-1 h-1 bg-white/90'
            }`}
          />
        </div>

        {/* Precision Optical Crosshairs */}
        <div className="absolute top-1/2 left-0 w-1 h-[1px] -translate-y-1/2 bg-white/60" />
        <div className="absolute top-1/2 right-0 w-1 h-[1px] -translate-y-1/2 bg-white/60" />
        <div className="absolute top-0 left-1/2 w-[1px] h-1 -translate-x-1/2 bg-white/60" />
        <div className="absolute bottom-0 left-1/2 w-[1px] h-1 -translate-x-1/2 bg-white/60" />
        </div>
      </div>
    </>
  );
};
