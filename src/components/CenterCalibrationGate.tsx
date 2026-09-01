import React, { useEffect, useState, useRef, useCallback } from 'react';
import { Focus, Sparkles, Sliders, Maximize2, ShieldCheck, Eye } from 'lucide-react';
import { GazeState, CalibrationSample } from '../types';
import { calibrationEngine } from '../services/calibration';
import { soundEngine } from '../services/audio';
import confetti from 'canvas-confetti';

interface CenterCalibrationGateProps {
  isOpen: boolean;
  gaze: GazeState | null;
  onActivated: () => void;
  onOpenFullCalibration: () => void;
}

export const CenterCalibrationGate: React.FC<CenterCalibrationGateProps> = ({
  isOpen,
  gaze,
  onActivated,
  onOpenFullCalibration,
}) => {
  const [progress, setProgress] = useState(0); // 0 to 1
  const [isLocked, setIsLocked] = useState(false);
  const [windowDims, setWindowDims] = useState({ width: window.innerWidth, height: window.innerHeight });

  const samplesRef = useRef<CalibrationSample[]>([]);
  const gazeRef = useRef<GazeState | null>(gaze);
  gazeRef.current = gaze;

  // Track window resizing
  useEffect(() => {
    const handleResize = () => {
      setWindowDims({ width: window.innerWidth, height: window.innerHeight });
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const completeActivation = useCallback(() => {
    setIsLocked(true);
    soundEngine.playLevelComplete();

    // If few samples collected, collect current gaze
    if (samplesRef.current.length < 5 && gazeRef.current) {
      for (let i = 0; i < 12; i++) {
        samplesRef.current.push({
          rawX: gazeRef.current.rawX,
          rawY: gazeRef.current.rawY,
          headYaw: gazeRef.current.headPose.yaw,
          headPitch: gazeRef.current.headPose.pitch,
        });
      }
    }

    calibrationEngine.calibrateCenter(samplesRef.current, window.innerWidth, window.innerHeight);

    try {
      confetti({
        particleCount: 50,
        spread: 60,
        origin: { x: 0.5, y: 0.5 },
        colors: ['#10b981', '#34d399', '#059669', '#38bdf8']
      });
    } catch {
      // Ignore
    }

    setTimeout(() => {
      onActivated();
      setIsLocked(false);
      setProgress(0);
      samplesRef.current = [];
    }, 450);
  }, [onActivated]);

  // Handle dwell progress when user fixates on the center
  useEffect(() => {
    if (!isOpen || isLocked) return;

    const centerX = windowDims.width / 2;
    const centerY = windowDims.height / 2;

    if (!gaze) {
      setProgress(0);
      return;
    }

    const distFromCenter = Math.hypot(gaze.screenX - centerX, gaze.screenY - centerY);
    const centerTolerance = Math.min(centerX * 0.4, 180);

    if (distFromCenter < centerTolerance) {
      // User is looking in center vicinity
      samplesRef.current.push({
        rawX: gaze.rawX,
        rawY: gaze.rawY,
        headYaw: gaze.headPose.yaw,
        headPitch: gaze.headPose.pitch,
      });
      if (samplesRef.current.length > 50) samplesRef.current.shift();

      setProgress(prev => {
        const next = prev + 0.055;
        if (next >= 1.0) {
          completeActivation();
          return 1.0;
        }
        return next;
      });
    } else {
      // Decay progress smoothly
      setProgress(prev => Math.max(0, prev - 0.035));
    }
  }, [isOpen, isLocked, gaze, windowDims, completeActivation]);

  // Spacebar / Enter manual activation listener
  useEffect(() => {
    if (!isOpen || isLocked) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' || e.code === 'Enter') {
        e.preventDefault();
        completeActivation();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isLocked, completeActivation]);

  if (!isOpen) return null;

  const centerX = windowDims.width / 2;
  const centerY = windowDims.height / 2;
  const radius = 54;
  const circumference = 2 * Math.PI * radius;

  return (
    <div
      id="center-calibration-gate-overlay"
      className="fixed inset-0 z-50 bg-[#050505]/92 backdrop-blur-xl flex flex-col items-center justify-between p-6 select-none animate-in fade-in duration-300"
    >
      {/* Top Telemetry Readout */}
      <div className="w-full max-w-4xl flex items-center justify-between pt-2 text-xs font-mono">
        <div className="flex items-center gap-3">
          <div className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse shadow-[0_0_10px_#10b981]" />
          <span className="text-white/80 font-bold uppercase tracking-wider">
            Spatial Zero Calibration & Activation
          </span>
        </div>

        <div className="flex items-center gap-4 text-white/40">
          <div className="flex items-center gap-1.5 bg-white/5 border border-white/10 px-3 py-1 rounded-full">
            <Maximize2 className="w-3.5 h-3.5 text-emerald-400" />
            <span>Viewport: {windowDims.width} × {windowDims.height} px</span>
          </div>
          <div className="hidden sm:flex items-center gap-1.5 bg-white/5 border border-white/10 px-3 py-1 rounded-full">
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
            <span>Aspect Ratio: {(windowDims.width / Math.max(1, windowDims.height)).toFixed(2)} : 1</span>
          </div>
        </div>
      </div>

      {/* Central Visual Focus Beacon */}
      <div className="relative flex flex-col items-center justify-center my-auto">
        {/* Subtle Background Target Grid Rings */}
        <div className="absolute w-[360px] h-[360px] rounded-full border border-emerald-500/10 animate-[spin_40s_linear_infinite] pointer-events-none" />
        <div className="absolute w-[240px] h-[240px] rounded-full border border-dashed border-emerald-500/20 pointer-events-none" />
        <div className="absolute w-[160px] h-[160px] rounded-full bg-emerald-500/5 blur-xl pointer-events-none" />

        {/* Central SVG Dwell Gauge */}
        <div className="relative w-36 h-36 flex items-center justify-center cursor-pointer" onClick={completeActivation}>
          <svg className="w-36 h-36 -rotate-90">
            {/* Background Track */}
            <circle
              cx={72}
              cy={72}
              r={radius}
              stroke="rgba(255, 255, 255, 0.08)"
              strokeWidth={5}
              fill="transparent"
            />
            {/* Progress Arc */}
            <circle
              cx={72}
              cy={72}
              r={radius}
              stroke="#10b981"
              strokeWidth={5}
              fill="transparent"
              strokeDasharray={circumference}
              strokeDashoffset={(1 - progress) * circumference}
              strokeLinecap="round"
              style={{ transition: 'stroke-dashoffset 40ms linear' }}
              className="drop-shadow-[0_0_12px_#10b981]"
            />
          </svg>

          {/* Glowing Center Core Reticle */}
          <div className={`absolute w-14 h-14 rounded-full border flex items-center justify-center transition-all duration-300 ${
            progress > 0.1 
              ? 'border-emerald-400 bg-emerald-500/20 shadow-[0_0_24px_#10b981]' 
              : 'border-white/40 bg-white/5'
          }`}>
            <div className={`w-4 h-4 rounded-full transition-all duration-300 ${
              progress > 0.1 ? 'bg-emerald-400 scale-125 shadow-[0_0_16px_#10b981]' : 'bg-white/80'
            }`} />
          </div>

          {/* Crosshair Lines */}
          <div className="absolute w-full h-0.5 bg-gradient-to-r from-transparent via-emerald-500/30 to-transparent pointer-events-none" />
          <div className="absolute h-full w-0.5 bg-gradient-to-b from-transparent via-emerald-500/30 to-transparent pointer-events-none" />
        </div>

        {/* Guidance Prompt */}
        <div className="mt-8 text-center space-y-2">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-xs font-mono font-semibold">
            <Focus className="w-3.5 h-3.5" />
            <span>LOOK AT THE CENTER TARGET TO ACTIVATE</span>
          </div>

          <h2 className="text-xl sm:text-2xl font-bold text-white font-['Outfit'] tracking-tight">
            Focus Gaze on Center to Auto-Zero
          </h2>
          <p className="text-xs sm:text-sm text-white/50 max-w-md mx-auto">
            Zeroes out resting camera posture and calibrates tracking to your exact window dimensions.
          </p>
        </div>

        {/* Real-time Dwell Progress Bar Indicator */}
        <div className="mt-6 w-64 bg-white/5 border border-white/10 rounded-full p-1">
          <div
            className="h-2 bg-gradient-to-r from-emerald-500 to-teal-400 rounded-full transition-all duration-75 shadow-[0_0_12px_#10b981]"
            style={{ width: `${Math.max(5, Math.round(progress * 100))}%` }}
          />
        </div>
      </div>

      {/* Bottom Action Controls */}
      <div className="w-full max-w-xl flex flex-col sm:flex-row items-center justify-between gap-3 pt-4 border-t border-white/10 text-xs font-mono">
        <button
          type="button"
          id="manual-activate-btn"
          onClick={completeActivation}
          className="w-full sm:w-auto px-5 py-2.5 rounded-xl bg-white/10 hover:bg-white/15 text-white font-medium flex items-center justify-center gap-2 border border-white/10 cursor-pointer transition-colors"
        >
          <span>Tap to Activate</span>
          <kbd className="px-1.5 py-0.5 bg-black/40 rounded text-[10px] text-white/50 border border-white/10">
            Space
          </kbd>
        </button>

        <button
          type="button"
          id="skip-to-full-calibration-btn"
          onClick={() => {
            completeActivation();
            setTimeout(onOpenFullCalibration, 100);
          }}
          className="w-full sm:w-auto px-4 py-2.5 rounded-xl bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 font-medium flex items-center justify-center gap-2 border border-emerald-500/30 cursor-pointer transition-colors"
        >
          <Eye className="w-4 h-4" />
          <span>Launch Full 9-Point Alignment</span>
        </button>
      </div>
    </div>
  );
};
