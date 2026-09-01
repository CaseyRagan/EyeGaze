import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, Eye, Video } from 'lucide-react';
import { gazeBus } from '../services/gazeBus';
import { GazeState } from '../types';

interface CameraPreviewProps {
  videoElement: HTMLVideoElement | null;
  landmarksRef: React.MutableRefObject<any[] | null>;
  showMesh: boolean;
  onToggleMesh: () => void;
}

const PREVIEW_WIDTH = 224;
const PREVIEW_HEIGHT = 168;

/**
 * A small live view of the camera, so the person in the chair can see that they
 * are framed correctly and the clinician can see what the tracker sees.
 *
 * Landmarks arrive through a ref rather than a prop: passing them as a prop
 * meant this component re-rendered — and restarted its render loop — on every
 * captured frame.
 */
export const CameraPreview: React.FC<CameraPreviewProps> = ({
  videoElement,
  landmarksRef,
  showMesh,
  onToggleMesh,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const gazeRef = useRef<GazeState | null>(gazeBus.get());
  const showMeshRef = useRef(showMesh);
  showMeshRef.current = showMesh;
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => gazeBus.subscribe(g => {
    gazeRef.current = g;
  }), []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !videoElement || collapsed) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    canvas.width = PREVIEW_WIDTH;
    canvas.height = PREVIEW_HEIGHT;

    let frame = 0;
    const render = () => {
      if (videoElement.readyState >= 2) {
        ctx.save();
        // Mirrored, so moving right on screen matches moving right in the view.
        ctx.translate(PREVIEW_WIDTH, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(videoElement, 0, 0, PREVIEW_WIDTH, PREVIEW_HEIGHT);
        ctx.restore();

        const landmarks = landmarksRef.current;
        if (showMeshRef.current && landmarks && landmarks.length > 470) {
          drawEyeOutline(ctx, landmarks, [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246]);
          drawEyeOutline(ctx, landmarks, [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466]);
          drawIris(ctx, landmarks[468]);
          drawIris(ctx, landmarks[473]);
        }
      }
      frame = requestAnimationFrame(render);
    };

    frame = requestAnimationFrame(render);
    return () => cancelAnimationFrame(frame);
  }, [videoElement, landmarksRef, collapsed]);

  if (collapsed) {
    return (
      <button
        onClick={() => setCollapsed(false)}
        className="fixed bottom-5 right-5 z-30 surface rounded-full px-4 py-2.5 text-sm text-ink-soft hover:text-ink flex items-center gap-2 transition-colors"
      >
        <Video className="w-4 h-4 text-sage-500" />
        <span>Show camera</span>
      </button>
    );
  }

  return (
    <div className="fixed bottom-5 right-5 z-30 surface rounded-2xl p-2.5 w-[248px]">
      <div className="flex items-center justify-between px-1 pb-2">
        <span className="text-xs font-medium text-ink-soft">Camera view</span>
        <div className="flex items-center gap-0.5">
          <button
            onClick={onToggleMesh}
            title={showMesh ? 'Hide eye outlines' : 'Show eye outlines'}
            className={`p-1.5 rounded-lg transition-colors ${
              showMesh ? 'bg-sage-100 text-sage-600' : 'text-ink-faint hover:text-ink-soft'
            }`}
          >
            <Eye className="w-4 h-4" />
          </button>
          <button
            onClick={() => setCollapsed(true)}
            title="Hide camera view"
            className="p-1.5 rounded-lg text-ink-faint hover:text-ink-soft transition-colors"
          >
            <ChevronDown className="w-4 h-4" />
          </button>
        </div>
      </div>
      <canvas
        ref={canvasRef}
        className="w-full rounded-xl bg-[var(--surface-sunken)]"
        style={{ aspectRatio: '4 / 3' }}
      />
    </div>
  );
};

function drawEyeOutline(ctx: CanvasRenderingContext2D, landmarks: any[], indices: number[]) {
  ctx.beginPath();
  indices.forEach((idx, i) => {
    const p = landmarks[idx];
    if (!p) return;
    const x = (1 - p.x) * PREVIEW_WIDTH;
    const y = p.y * PREVIEW_HEIGHT;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.closePath();
  ctx.strokeStyle = 'rgba(143, 188, 175, 0.9)';
  ctx.lineWidth = 1.2;
  ctx.stroke();
}

function drawIris(ctx: CanvasRenderingContext2D, point: any) {
  if (!point) return;
  ctx.beginPath();
  ctx.arc((1 - point.x) * PREVIEW_WIDTH, point.y * PREVIEW_HEIGHT, 3, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(204, 143, 110, 0.95)';
  ctx.fill();
}
