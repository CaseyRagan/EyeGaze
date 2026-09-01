import React, { useEffect, useRef, useState } from 'react';
import { Camera, Eye, Maximize2, Minimize2, Video, VideoOff } from 'lucide-react';
import { GazeState, HeadPose } from '../types';

interface CameraFeedProps {
  videoElement: HTMLVideoElement | null;
  landmarks: any[] | null;
  gaze: GazeState | null;
  showMeshOverlay: boolean;
  onToggleMesh: () => void;
}

export const CameraFeed: React.FC<CameraFeedProps> = ({
  videoElement,
  landmarks,
  gaze,
  showMeshOverlay,
  onToggleMesh,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [isMinimized, setIsMinimized] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !videoElement) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animId: number;

    const render = () => {
      if (videoElement.readyState >= 2) {
        canvas.width = 240;
        canvas.height = 180;

        ctx.save();
        // Mirror horizontally so webcam feels natural
        ctx.translate(canvas.width, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(videoElement, 0, 0, canvas.width, canvas.height);
        ctx.restore();

        // Render landmark points & iris dots
        if (showMeshOverlay && landmarks && landmarks.length > 0) {
          ctx.save();
          // Adjust for mirrored coordinates
          const w = canvas.width;
          const h = canvas.height;

          // Key eye landmarks
          // Left eye: 33, 133, 159, 145, Iris: 468
          // Right eye: 263, 362, 386, 374, Iris: 473
          const leftEyeIndices = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246];
          const rightEyeIndices = [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466];

          // Draw left eye boundary
          ctx.beginPath();
          leftEyeIndices.forEach((idx, i) => {
            const p = landmarks[idx];
            if (!p) return;
            const x = (1 - p.x) * w;
            const y = p.y * h;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          });
          ctx.closePath();
          ctx.strokeStyle = '#10b981';
          ctx.lineWidth = 1.2;
          ctx.stroke();

          // Draw right eye boundary
          ctx.beginPath();
          rightEyeIndices.forEach((idx, i) => {
            const p = landmarks[idx];
            if (!p) return;
            const x = (1 - p.x) * w;
            const y = p.y * h;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          });
          ctx.closePath();
          ctx.strokeStyle = '#10b981';
          ctx.lineWidth = 1.2;
          ctx.stroke();

          // Highlight Left Iris
          const irisL = landmarks[468];
          if (irisL) {
            const ix = (1 - irisL.x) * w;
            const iy = irisL.y * h;
            ctx.beginPath();
            ctx.arc(ix, iy, 3.5, 0, Math.PI * 2);
            ctx.fillStyle = '#34d399';
            ctx.shadowColor = '#10b981';
            ctx.shadowBlur = 6;
            ctx.fill();
          }

          // Highlight Right Iris
          const irisR = landmarks[473];
          if (irisR) {
            const ix = (1 - irisR.x) * w;
            const iy = irisR.y * h;
            ctx.beginPath();
            ctx.arc(ix, iy, 3.5, 0, Math.PI * 2);
            ctx.fillStyle = '#34d399';
            ctx.shadowColor = '#10b981';
            ctx.shadowBlur = 6;
            ctx.fill();
          }

          // Nose direction indicator
          const nose = landmarks[1];
          if (nose) {
            const nx = (1 - nose.x) * w;
            const ny = nose.y * h;
            ctx.beginPath();
            ctx.arc(nx, ny, 2, 0, Math.PI * 2);
            ctx.fillStyle = '#a855f7';
            ctx.fill();
          }

          ctx.restore();
        }
      }
      animId = requestAnimationFrame(render);
    };

    animId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animId);
  }, [videoElement, landmarks, showMeshOverlay]);

  if (isMinimized) {
    return (
      <button
        id="camera-pip-maximize-btn"
        onClick={() => setIsMinimized(false)}
        className="fixed bottom-4 right-4 z-30 bg-[#0a0a0a]/90 border border-white/10 backdrop-blur-md px-3.5 py-2 rounded-xl text-xs font-mono text-white/70 hover:text-white flex items-center gap-2 shadow-2xl hover:border-emerald-500/50 transition-all cursor-pointer"
        title="Show Camera Feed"
      >
        <Camera className="w-3.5 h-3.5 text-emerald-400 animate-pulse" />
        <span className="tracking-wider uppercase text-[10px]">Sensor PiP</span>
      </button>
    );
  }

  return (
    <div
      id="camera-pip-container"
      className={`fixed z-30 transition-all duration-300 ${
        isExpanded
          ? 'top-20 right-6 w-80'
          : 'bottom-5 right-5 w-60'
      } bg-[#0a0a0a]/95 border border-white/10 rounded-2xl p-2.5 backdrop-blur-xl shadow-2xl overflow-hidden`}
    >
      {/* Top Header */}
      <div className="flex items-center justify-between px-1.5 py-1 mb-1.5 border-b border-white/5">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
          </span>
          <span className="text-[10px] font-mono font-semibold tracking-widest text-white/80 uppercase">
            Sensor Matrix
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            id="toggle-mesh-btn"
            onClick={onToggleMesh}
            className={`p-1 rounded-md text-[10px] transition-colors cursor-pointer ${
              showMeshOverlay
                ? 'bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30'
                : 'text-white/40 hover:bg-white/5'
            }`}
            title="Toggle Landmark Overlay"
          >
            <Eye className="w-3.5 h-3.5" />
          </button>
          <button
            id="toggle-expand-btn"
            onClick={() => setIsExpanded(!isExpanded)}
            className="p-1 rounded-md text-white/40 hover:bg-white/5 text-[10px] cursor-pointer"
            title={isExpanded ? 'Shrink' : 'Expand'}
          >
            {isExpanded ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
          </button>
          <button
            id="minimize-camera-btn"
            onClick={() => setIsMinimized(true)}
            className="p-1 rounded-md text-white/40 hover:bg-white/5 text-[10px] cursor-pointer"
            title="Minimize PiP"
          >
            <Minimize2 className="w-3.5 h-3.5 rotate-45" />
          </button>
        </div>
      </div>

      {/* Video / Canvas Preview */}
      <div className="relative rounded-xl overflow-hidden bg-[#050505] aspect-[4/3] flex items-center justify-center border border-white/5">
        <canvas
          ref={canvasRef}
          className="w-full h-full object-cover rounded-xl"
        />

        {/* Real-time Blinking & Confidence Badges */}
        <div className="absolute bottom-2 left-2 right-2 flex items-center justify-between pointer-events-none">
          <div className="flex items-center gap-1.5 bg-black/70 backdrop-blur-md px-2 py-0.5 rounded-md border border-white/10">
            <span
              className={`w-1.5 h-1.5 rounded-full ${
                gaze?.isBlinkingLeft ? 'bg-amber-400' : 'bg-emerald-400'
              }`}
            />
            <span className="text-[9px] text-white/60 font-mono">L</span>
            <span
              className={`w-1.5 h-1.5 rounded-full ml-1 ${
                gaze?.isBlinkingRight ? 'bg-amber-400' : 'bg-emerald-400'
              }`}
            />
            <span className="text-[9px] text-white/60 font-mono">R</span>
          </div>

          <div className="bg-black/70 backdrop-blur-md px-2 py-0.5 rounded-md border border-white/10 text-[9px] text-emerald-400 font-mono tracking-wider">
            {gaze?.isFixating ? 'FIXATED' : 'SACCADE'}
          </div>
        </div>
      </div>

      {/* Head Pose / Yaw Indicator */}
      <div className="mt-2 grid grid-cols-2 gap-1.5 text-[9px] text-white/40 font-mono bg-white/[0.02] border border-white/5 p-1.5 rounded-lg">
        <div>
          Yaw: <span className="text-white/80">{(gaze?.headPose.yaw ? gaze.headPose.yaw * 100 : 0).toFixed(0)}°</span>
        </div>
        <div>
          Pitch: <span className="text-white/80">{(gaze?.headPose.pitch ? gaze.headPose.pitch * 100 : 0).toFixed(0)}°</span>
        </div>
      </div>
    </div>
  );
};
