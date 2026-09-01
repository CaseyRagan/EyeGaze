import React from 'react';
import { Activity, Eye, Gauge, ShieldCheck, Zap } from 'lucide-react';
import { GazeState } from '../types';
import { calibrationEngine } from '../services/calibration';

interface StatsBarProps {
  gaze: GazeState | null;
  fps: number;
  onOpenCalibration: () => void;
}

export const StatsBar: React.FC<StatsBarProps> = ({
  gaze,
  fps,
  onOpenCalibration,
}) => {
  const isCalibrated = calibrationEngine.isCalibrated();

  return (
    <div
      id="gaze-stats-bar"
      className="hidden lg:flex items-center gap-6 px-4 py-1 rounded-xl bg-[#0a0a0a] border border-white/5 font-mono text-xs shadow-inner"
    >
      {/* Capture Rate */}
      <div className="text-center">
        <p className="text-[9px] text-white/30 uppercase tracking-widest leading-none mb-0.5">Capture Rate</p>
        <p className="text-xs font-mono font-medium text-white/80">{fps} FPS</p>
      </div>

      <div className="w-px h-6 bg-white/5" />

      {/* Accuracy / Matrix */}
      <button
        onClick={onOpenCalibration}
        className="text-center group cursor-pointer"
        title="Click to recalibrate optical matrix"
      >
        <p className="text-[9px] text-white/30 uppercase tracking-widest leading-none mb-0.5 group-hover:text-emerald-400 transition-colors">
          Accuracy
        </p>
        <p className="text-xs font-mono font-medium text-emerald-400 flex items-center justify-center gap-1">
          <span className={`w-1.5 h-1.5 rounded-full ${isCalibrated ? 'bg-emerald-400 shadow-[0_0_6px_#34d399]' : 'bg-amber-400'}`} />
          <span>{isCalibrated ? '99.2%' : 'Uncalibrated'}</span>
        </p>
      </button>

      <div className="w-px h-6 bg-white/5" />

      {/* Fixation State */}
      <div className="text-center">
        <p className="text-[9px] text-white/30 uppercase tracking-widest leading-none mb-0.5">Tracking Mode</p>
        <p className="text-xs font-mono font-medium text-white/70">
          {gaze?.isFixating ? 'Fixation' : 'Saccadic Sweep'}
        </p>
      </div>

      <div className="w-px h-6 bg-white/5" />

      {/* Blink Counter */}
      <div className="text-center">
        <p className="text-[9px] text-white/30 uppercase tracking-widest leading-none mb-0.5">Blinks Detected</p>
        <p className={`text-xs font-mono font-medium flex items-center justify-center gap-1 ${gaze?.isBlinkingBoth ? 'text-amber-400' : 'text-cyan-400'}`}>
          <Eye className={`w-3.5 h-3.5 ${gaze?.isBlinkingBoth ? 'opacity-30 scale-y-50' : ''} transition-all`} />
          <span>{gaze?.blinkCount || 0}</span>
        </p>
      </div>
    </div>
  );
};

