import React, { useEffect, useRef } from 'react';
import { GazeState } from '../types';
import { gazeBus } from '../services/gazeBus';

interface GazePointerProps {
  color?: string;
  showTrail?: boolean;
  dwellProgress?: number;
  /** Softens the pointer to a faint dot — useful during reading tasks, where a
   *  bright marker under the eyes changes how people read. */
  subdued?: boolean;
}

interface TrailPoint {
  x: number;
  y: number;
  born: number;
}

const TRAIL_LIFETIME_MS = 420;

/**
 * The on-screen gaze marker.
 *
 * It owns a single canvas and a single animation frame for the lifetime of the
 * component, reading the newest sample from a ref. The previous implementation
 * listed the live gaze sample in its effect dependencies, so every frame tore
 * down the loop, rebuilt it, and resized the canvas — which cleared the bitmap
 * and made the trail flicker while burning a surprising amount of CPU.
 */
export const GazePointer: React.FC<GazePointerProps> = ({
  color = '#4e8779',
  showTrail = true,
  dwellProgress = 0,
  subdued = false,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const gazeRef = useRef<GazeState | null>(gazeBus.get());
  const trailRef = useRef<TrailPoint[]>([]);
  const settingsRef = useRef({ color, showTrail, dwellProgress, subdued });
  settingsRef.current = { color, showTrail, dwellProgress, subdued };

  useEffect(() => gazeBus.subscribe(gaze => {
    gazeRef.current = gaze;
  }), []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let frame = 0;
    let dpr = window.devicePixelRatio || 1;

    const resize = () => {
      dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(window.innerWidth * dpr);
      canvas.height = Math.floor(window.innerHeight * dpr);
      canvas.style.width = `${window.innerWidth}px`;
      canvas.style.height = `${window.innerHeight}px`;
    };
    resize();
    window.addEventListener('resize', resize);

    const render = () => {
      const { color: strokeColor, showTrail: trailOn, dwellProgress: dwell, subdued: quiet } = settingsRef.current;
      const gaze = gazeRef.current;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

      if (!gaze) {
        frame = requestAnimationFrame(render);
        return;
      }

      const now = performance.now();

      // The trail keeps extending through a blink. Breaking it every time the
      // lids close left a visible stutter in the line for no benefit.
      if (trailOn && !gaze.isVisiblyInterrupted) {
        const last = trailRef.current[trailRef.current.length - 1];
        if (!last || Math.hypot(gaze.screenX - last.x, gaze.screenY - last.y) > 2) {
          trailRef.current.push({ x: gaze.screenX, y: gaze.screenY, born: now });
        }
      }
      trailRef.current = trailRef.current.filter(p => now - p.born < TRAIL_LIFETIME_MS);

      if (trailOn && trailRef.current.length > 1) {
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        for (let i = 1; i < trailRef.current.length; i++) {
          const a = trailRef.current[i - 1];
          const b = trailRef.current[i];
          const age = (now - b.born) / TRAIL_LIFETIME_MS;
          const alpha = Math.max(0, (1 - age) * (quiet ? 0.12 : 0.3));
          ctx.strokeStyle = withAlpha(strokeColor, alpha);
          ctx.lineWidth = Math.max(1, (1 - age) * (quiet ? 2 : 4));
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }

      const x = gaze.screenX;
      const y = gaze.screenY;

      // The marker grows a little when the eye settles, so a fixation is
      // legible at a glance without a colour change or a flash.
      const settled = gaze.isFixating ? 1 : 0;
      const baseRadius = quiet ? 7 : 13;
      const radius = baseRadius + settled * 2;

      // A genuinely stalled estimate is drawn hollow and faint so nobody
      // mistakes a frozen marker for a live one — but only once the stall has
      // outlasted a blink. Flagging every blink taught the user to stop
      // blinking, which dries the eyes and makes tracking worse.
      const interrupted = gaze.isVisiblyInterrupted;
      const confidenceAlpha = interrupted ? 0.25 : 0.35 + gaze.confidence * 0.45;

      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fillStyle = withAlpha(strokeColor, interrupted ? 0.04 : 0.1);
      ctx.fill();
      ctx.lineWidth = quiet ? 1.5 : 2;
      ctx.strokeStyle = withAlpha(strokeColor, confidenceAlpha);
      if (interrupted) ctx.setLineDash([3, 4]);
      ctx.stroke();
      ctx.setLineDash([]);

      if (!quiet) {
        ctx.beginPath();
        ctx.arc(x, y, 2.5, 0, Math.PI * 2);
        ctx.fillStyle = withAlpha(strokeColor, interrupted ? 0.3 : 0.85);
        ctx.fill();
      }

      if (dwell > 0.01) {
        ctx.beginPath();
        ctx.arc(x, y, radius + 6, -Math.PI / 2, -Math.PI / 2 + dwell * Math.PI * 2);
        ctx.lineWidth = 3;
        ctx.strokeStyle = withAlpha(strokeColor, 0.8);
        ctx.lineCap = 'round';
        ctx.stroke();
      }

      frame = requestAnimationFrame(render);
    };

    frame = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return <canvas ref={canvasRef} className="fixed inset-0 pointer-events-none z-50" aria-hidden="true" />;
};

function withAlpha(hex: string, alpha: number): string {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map(c => c + c).join('') : clean;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  if ([r, g, b].some(Number.isNaN)) return `rgba(78, 135, 121, ${alpha})`;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
