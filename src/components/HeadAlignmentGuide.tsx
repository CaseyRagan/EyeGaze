import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Crosshair, Move } from 'lucide-react';
import { GazeState } from '../types';
import { calibrationEngine } from '../services/calibration';
import { gazeBus } from '../services/gazeBus';
import { drawHeadPosition, judgeAlignment } from './headPositionDraw';

interface HeadAlignmentGuideProps {
  onRecentre?: () => void;
}

/**
 * A persistent view of where the head is, against where it was at calibration.
 *
 * This is the same target the set-up screen shows, kept available during the
 * session. Someone who shifts in the chair, turns to speak to the therapist, or
 * simply relaxes over ten minutes needs to be able to line back up on their own
 * — and telling them "you have drifted 4 cm" does not help them find their way
 * back. A picture does.
 *
 * It draws itself on a canvas from a ref rather than re-rendering, because it is
 * on screen the whole time an activity is running and must cost nothing.
 */

const BOX_WIDTH = 168;
const BOX_HEIGHT = 126;

export const HeadAlignmentGuide: React.FC<HeadAlignmentGuideProps> = ({ onRecentre }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const gazeRef = useRef<GazeState | null>(gazeBus.get());
  const [collapsed, setCollapsed] = useState(false);
  const [aligned, setAligned] = useState(false);
  const [instruction, setInstruction] = useState<string | null>(null);
  const [distanceCm, setDistanceCm] = useState<number | null>(null);

  useEffect(() => gazeBus.subscribe(g => {
    gazeRef.current = g;
  }), []);

  useEffect(() => {
    if (collapsed) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = BOX_WIDTH * dpr;
    canvas.height = BOX_HEIGHT * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    let frame = 0;
    let uiTick = 0;

    const render = () => {
      const gaze = gazeRef.current;
      const posture = calibrationEngine.getPosture();

      if (!gaze || gaze.event === 'lost' || !posture) {
        drawHeadPosition(ctx, {
          width: BOX_WIDTH,
          height: BOX_HEIGHT,
          scale: 1,
          translateX: 0,
          translateY: 0,
          yaw: 0,
          pitch: 0,
          roll: 0,
          aligned: false,
          state: posture ? 'no-face' : 'no-target',
          emptyLabel: posture ? 'Face not found' : 'Not set up yet',
        });
        frame = requestAnimationFrame(render);
        return;
      }

      // Apparent eye separation against the calibrated pose gives relative
      // distance directly, so the outline grows when the client leans in — the
      // drift that costs the most and is hardest to feel.
      const scale =
        posture.interocularSpan > 1e-5 ? gaze.headPose.interocularSpan / posture.interocularSpan : 1;

      const verdict = judgeAlignment({
        scale,
        translateX: gaze.headPose.translateX,
        translateY: gaze.headPose.translateY,
        targetTranslateX: posture.translateX,
        targetTranslateY: posture.translateY,
        yaw: gaze.headPose.yaw - posture.yaw,
        pitch: gaze.headPose.pitch - posture.pitch,
      });

      drawHeadPosition(ctx, {
        width: BOX_WIDTH,
        height: BOX_HEIGHT,
        scale: Math.max(0.35, Math.min(2.2, scale)),
        translateX: gaze.headPose.translateX - posture.translateX,
        translateY: gaze.headPose.translateY - posture.translateY,
        yaw: gaze.headPose.yaw,
        pitch: gaze.headPose.pitch,
        roll: gaze.headPose.roll,
        aligned: verdict.aligned,
        state: 'tracking',
      });

      if (++uiTick % 15 === 0) {
        setInstruction(verdict.instruction);
        setAligned(verdict.aligned);
        setDistanceCm(gaze.headPose.distanceCm);
      }

      frame = requestAnimationFrame(render);
    };

    frame = requestAnimationFrame(render);
    return () => cancelAnimationFrame(frame);
  }, [collapsed]);

  // The label says what to do, not merely that something is wrong. "Drifting"
  // tells someone they have a problem and nothing about how to fix it.
  const tone = aligned
    ? { text: 'text-sage-700', label: 'Lined up', Icon: Check }
    : instruction
    ? { text: 'text-clay-500', label: instruction, Icon: Move }
    : { text: 'text-ink-faint', label: 'Head position', Icon: Crosshair };

  if (collapsed) {
    return (
      <button
        onClick={() => setCollapsed(false)}
        className="fixed left-5 bottom-5 z-30 surface rounded-full px-4 py-2.5 text-sm flex items-center gap-2 hover:brightness-95 transition-all"
        title="Show head position"
      >
        <tone.Icon className={`w-4 h-4 ${tone.text}`} />
        <span className={tone.text}>{tone.label}</span>
      </button>
    );
  }

  return (
    <div className="fixed left-5 bottom-5 z-30 surface rounded-2xl p-3 w-[192px]">
      <div className="flex items-center justify-between mb-2 pl-1">
        <span className={`text-xs font-medium flex items-center gap-1.5 ${tone.text}`}>
          <tone.Icon className="w-3.5 h-3.5" />
          {tone.label}
        </span>
        <button
          onClick={() => setCollapsed(true)}
          className="p-1 rounded-lg text-ink-faint hover:text-ink-soft transition-colors"
          aria-label="Hide head position"
        >
          <ChevronDown className="w-4 h-4" />
        </button>
      </div>

      <canvas
        ref={canvasRef}
        style={{ width: BOX_WIDTH, height: BOX_HEIGHT }}
        className="rounded-xl bg-[var(--surface-sunken)] w-full"
      />

      <div className="flex items-center justify-between mt-2 px-1">
        <span className="text-[11px] text-ink-faint">
          {distanceCm !== null ? `${distanceCm.toFixed(0)} cm away` : 'Distance unknown'}
        </span>
        {!aligned && onRecentre && (
          <button
            onClick={onRecentre}
            className="text-[11px] font-medium text-sage-600 hover:text-sage-700 underline underline-offset-2"
          >
            Re-centre
          </button>
        )}
      </div>
    </div>
  );
};
