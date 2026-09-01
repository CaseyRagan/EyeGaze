import React from 'react';
import { 
  X, 
  Sliders, 
  Eye, 
  Volume2, 
  VolumeX, 
  RotateCcw, 
  ShieldCheck, 
  Sparkles, 
  Video,
  PenTool,
  Grid,
  FlipHorizontal,
  FlipVertical,
  Activity,
  Zap,
  Cpu
} from 'lucide-react';
import { PenActivationMode, TrackingSettings } from '../types';
import { calibrationEngine } from '../services/calibration';
import { soundEngine } from '../services/audio';

interface SettingsModalProps {
  isOpen: boolean;
  settings: TrackingSettings;
  onClose: () => void;
  onUpdateSettings: (newSettings: Partial<TrackingSettings>) => void;
  onRecalibrate: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  settings,
  onClose,
  onUpdateSettings,
  onRecalibrate,
}) => {
  if (!isOpen) return null;

  return (
    <div
      id="settings-modal-overlay"
      className="fixed inset-0 z-50 bg-[#050505]/85 backdrop-blur-md flex items-center justify-center p-4 sm:p-6 select-none"
    >
      <div className="max-w-xl w-full bg-[#0a0a0a] border border-white/10 rounded-3xl p-6 shadow-2xl space-y-6 max-h-[92vh] overflow-y-auto font-sans">
        {/* Header */}
        <div className="flex items-center justify-between pb-4 border-b border-white/10">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
              <Sliders className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold font-mono text-white tracking-wide uppercase">
                Tracking & Precision Engine
              </h2>
              <p className="text-xs text-white/50">
                1€ Adaptive Filtering, Quadratic Surface Mapping, & Anatomical Optics
              </p>
            </div>
          </div>

          <button
            id="close-settings-btn"
            onClick={onClose}
            className="p-2 rounded-full text-white/40 hover:text-white hover:bg-white/5 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Section: Tracking Engine Mode */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-[11px] font-mono font-bold uppercase tracking-wider text-cyan-400 flex items-center gap-1.5">
              <Eye className="w-3.5 h-3.5 text-cyan-400" />
              <span>Tracking Engine Mode</span>
            </h3>
            <span className="text-[10px] font-mono text-white/40">Select input algorithm</span>
          </div>

          <div className="grid grid-cols-3 gap-2">
            {[
              {
                id: 'hybrid_gaze',
                title: 'Hybrid Gaze',
                desc: 'Iris + Blendshapes + Head Dampening',
              },
              {
                id: 'head_laser',
                title: 'Head-Laser',
                desc: '3D Head-Vector (Ultra-Steady Lines)',
              },
              {
                id: 'iris_only',
                title: 'Pure Iris',
                desc: 'Anatomical Canthus-Ratio Only',
              },
            ].map(m => {
              const active = (settings.trackingEngineMode || 'hybrid_gaze') === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => {
                    onUpdateSettings({ trackingEngineMode: m.id as any });
                    soundEngine.playChime(active ? 400 : 560, 0.15);
                  }}
                  className={`p-3 rounded-2xl border text-left transition-all cursor-pointer ${
                    active
                      ? 'border-cyan-400 bg-cyan-500/15 text-white shadow-[0_0_12px_rgba(6,182,212,0.2)]'
                      : 'border-white/10 bg-white/5 text-white/70 hover:border-white/20'
                  }`}
                >
                  <div className="text-xs font-mono font-bold text-white">{m.title}</div>
                  <div className="text-[9px] text-white/40 mt-1 leading-tight">{m.desc}</div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Section: Axis Inversion (Address inverted tracking) */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-[11px] font-mono font-bold uppercase tracking-wider text-emerald-400 flex items-center gap-1.5">
              <Activity className="w-3.5 h-3.5 text-emerald-400" />
              <span>Coordinate Inversion (Flip Axis)</span>
            </h3>
            <span className="text-[10px] font-mono text-white/40">Adjust if tracking feels reversed</span>
          </div>

          <div className="grid grid-cols-2 gap-2.5">
            {/* Invert X */}
            <button
              type="button"
              id="toggle-invert-x-btn"
              onClick={() => {
                onUpdateSettings({ invertX: !settings.invertX });
                soundEngine.playChime(settings.invertX ? 440 : 520, 0.15);
              }}
              className={`p-3.5 rounded-2xl border text-left transition-all cursor-pointer flex items-center justify-between ${
                settings.invertX
                  ? 'border-amber-500/50 bg-amber-500/10 text-white'
                  : 'border-white/10 bg-white/5 text-white/70 hover:border-white/20'
              }`}
            >
              <div className="flex items-center gap-2">
                <FlipHorizontal className={`w-4 h-4 ${settings.invertX ? 'text-amber-400' : 'text-white/40'}`} />
                <div>
                  <div className="text-xs font-mono font-semibold">Invert X (Horizontal)</div>
                  <div className="text-[10px] text-white/40">Flip Left / Right</div>
                </div>
              </div>
              <span className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded ${settings.invertX ? 'bg-amber-400/20 text-amber-300' : 'bg-black/30 text-white/40'}`}>
                {settings.invertX ? 'INVERTED' : 'NORMAL'}
              </span>
            </button>

            {/* Invert Y */}
            <button
              type="button"
              id="toggle-invert-y-btn"
              onClick={() => {
                onUpdateSettings({ invertY: !settings.invertY });
                soundEngine.playChime(settings.invertY ? 440 : 520, 0.15);
              }}
              className={`p-3.5 rounded-2xl border text-left transition-all cursor-pointer flex items-center justify-between ${
                settings.invertY
                  ? 'border-amber-500/50 bg-amber-500/10 text-white'
                  : 'border-white/10 bg-white/5 text-white/70 hover:border-white/20'
              }`}
            >
              <div className="flex items-center gap-2">
                <FlipVertical className={`w-4 h-4 ${settings.invertY ? 'text-amber-400' : 'text-white/40'}`} />
                <div>
                  <div className="text-xs font-mono font-semibold">Invert Y (Vertical)</div>
                  <div className="text-[10px] text-white/40">Flip Up / Down</div>
                </div>
              </div>
              <span className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded ${settings.invertY ? 'bg-amber-400/20 text-amber-300' : 'bg-black/30 text-white/40'}`}>
                {settings.invertY ? 'INVERTED' : 'NORMAL'}
              </span>
            </button>
          </div>
        </div>

        {/* Section: Sensitivity & 1-Euro Adaptive Filter Controls */}
        <div className="space-y-4 pt-2 border-t border-white/10">
          <div className="flex items-center justify-between">
            <h3 className="text-[11px] font-mono font-bold uppercase tracking-wider text-emerald-400 flex items-center gap-1.5">
              <Zap className="w-3.5 h-3.5 text-emerald-400" />
              <span>Sensitivity & 1€ Adaptive Filter</span>
            </h3>
            <div className="flex gap-1">
              {[
                { label: '0.8x', sx: 0.8, sy: 0.8 },
                { label: '1.3x', sx: 1.3, sy: 1.3 },
                { label: '1.8x', sx: 1.8, sy: 1.8 },
                { label: '2.4x', sx: 2.4, sy: 2.4 },
              ].map(preset => (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => onUpdateSettings({ sensitivityX: preset.sx, sensitivityY: preset.sy })}
                  className="px-2 py-0.5 bg-white/5 hover:bg-white/10 border border-white/10 rounded text-[9px] font-mono text-white/60 hover:text-white cursor-pointer"
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          {/* Horizontal Sensitivity */}
          <div className="space-y-1.5">
            <div className="flex justify-between text-xs font-mono text-white/70">
              <span>Horizontal Sensitivity (X-Axis)</span>
              <span className="text-emerald-400 font-bold">{settings.sensitivityX.toFixed(2)}x</span>
            </div>
            <input
              type="range"
              min="0.4"
              max="3.0"
              step="0.05"
              value={settings.sensitivityX}
              onChange={(e) => onUpdateSettings({ sensitivityX: parseFloat(e.target.value) })}
              className="w-full h-1.5 bg-white/10 rounded-lg appearance-none cursor-pointer accent-emerald-400"
            />
          </div>

          {/* Vertical Sensitivity */}
          <div className="space-y-1.5">
            <div className="flex justify-between text-xs font-mono text-white/70">
              <span>Vertical Sensitivity (Y-Axis)</span>
              <span className="text-emerald-400 font-bold">{settings.sensitivityY.toFixed(2)}x</span>
            </div>
            <input
              type="range"
              min="0.4"
              max="3.0"
              step="0.05"
              value={settings.sensitivityY}
              onChange={(e) => onUpdateSettings({ sensitivityY: parseFloat(e.target.value) })}
              className="w-full h-1.5 bg-white/10 rounded-lg appearance-none cursor-pointer accent-emerald-400"
            />
          </div>

          {/* 1€ Filter Minimum Cutoff */}
          <div className="space-y-1.5">
            <div className="flex justify-between text-xs font-mono text-white/70">
              <span>1€ Filter Resting Stability (Min Cutoff)</span>
              <span className="text-emerald-400 font-bold">{(settings.oneEuroMinCutoff || 0.8).toFixed(2)} Hz</span>
            </div>
            <input
              type="range"
              min="0.2"
              max="2.5"
              step="0.05"
              value={settings.oneEuroMinCutoff || 0.8}
              onChange={(e) => onUpdateSettings({ oneEuroMinCutoff: parseFloat(e.target.value) })}
              className="w-full h-1.5 bg-white/10 rounded-lg appearance-none cursor-pointer accent-emerald-400"
            />
            <div className="text-[10px] text-white/40 flex justify-between">
              <span>Ultra-Still Fixation</span>
              <span>Light Filtering</span>
            </div>
          </div>

          {/* 1€ Filter Beta Velocity Scale */}
          <div className="space-y-1.5">
            <div className="flex justify-between text-xs font-mono text-white/70">
              <span>1€ Filter Saccade Speed Coefficient (Beta)</span>
              <span className="text-emerald-400 font-bold">{(settings.oneEuroBeta || 0.04).toFixed(3)}</span>
            </div>
            <input
              type="range"
              min="0.005"
              max="0.15"
              step="0.005"
              value={settings.oneEuroBeta || 0.04}
              onChange={(e) => onUpdateSettings({ oneEuroBeta: parseFloat(e.target.value) })}
              className="w-full h-1.5 bg-white/10 rounded-lg appearance-none cursor-pointer accent-emerald-400"
            />
            <div className="text-[10px] text-white/40 flex justify-between">
              <span>Smooth Motion</span>
              <span>Instant Ballistic Saccades</span>
            </div>
          </div>

          {/* Deadzone Threshold */}
          <div className="space-y-1.5">
            <div className="flex justify-between text-xs font-mono text-white/70">
              <span>Tremor Deadzone Filter</span>
              <span className="text-emerald-400 font-bold">{settings.deadzone || 5} px</span>
            </div>
            <input
              type="range"
              min="0"
              max="20"
              step="1"
              value={settings.deadzone || 5}
              onChange={(e) => onUpdateSettings({ deadzone: parseInt(e.target.value) })}
              className="w-full h-1.5 bg-white/10 rounded-lg appearance-none cursor-pointer accent-emerald-400"
            />
          </div>
        </div>

        {/* Section: Quadratic Mapping & Mathematical Surface Model */}
        <div className="space-y-3 pt-3 border-t border-white/10">
          <div className="flex items-center justify-between">
            <h3 className="text-[11px] font-mono font-bold uppercase tracking-wider text-emerald-400 flex items-center gap-1.5">
              <Cpu className="w-3.5 h-3.5 text-emerald-400" />
              <span>Quadratic Bivariate Surface Mapping</span>
            </h3>
            <span className="text-[10px] font-mono text-white/40">2nd-Degree Polynomial Fit</span>
          </div>

          <div className="bg-[#050505] border border-white/10 rounded-2xl p-4 flex items-center justify-between">
            <div className="pr-4">
              <div className="text-xs font-mono font-semibold text-white">
                Non-Linear Parallax & Corner Correction
              </div>
              <div className="text-[11px] text-white/50 mt-0.5">
                Applies least-squares quadratic regression ($x, y, x^2, y^2, xy$) to compensate for peripheral optical curvature.
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                const next = settings.useQuadraticMapping === false;
                onUpdateSettings({ useQuadraticMapping: next });
                soundEngine.playChime(next ? 600 : 350, 0.15);
              }}
              className={`px-3 py-1.5 rounded-xl font-mono text-xs font-bold transition-all cursor-pointer ${
                settings.useQuadraticMapping !== false
                  ? 'bg-emerald-500 text-black shadow-[0_0_12px_rgba(16,185,129,0.3)]'
                  : 'bg-white/10 text-white/50 hover:bg-white/15'
              }`}
            >
              {settings.useQuadraticMapping !== false ? 'QUADRATIC' : 'LINEAR'}
            </button>
          </div>
        </div>

        {/* Section: Snap To Grid on Focus */}
        <div className="space-y-3 pt-3 border-t border-white/10">
          <div className="flex items-center justify-between">
            <h3 className="text-[11px] font-mono font-bold uppercase tracking-wider text-emerald-400 flex items-center gap-1.5">
              <Grid className="w-3.5 h-3.5 text-emerald-400" />
              <span>Snap to Grid on Focus Lock</span>
            </h3>
            <span className="text-[10px] font-mono text-white/40">Locks gaze to coordinates on dwell</span>
          </div>

          <div className="bg-[#050505] border border-white/10 rounded-2xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs font-mono font-semibold text-white">
                  Magnetic Grid Snapping
                </div>
                <div className="text-[11px] text-white/50">
                  When eye focus rests in an area, coordinate locks to crisp grid nodes.
                </div>
              </div>
              <button
                type="button"
                id="toggle-snap-to-grid-btn"
                onClick={() => {
                  const next = !settings.snapToGrid;
                  onUpdateSettings({ snapToGrid: next });
                  soundEngine.playChime(next ? 600 : 350, 0.15);
                }}
                className={`px-3 py-1.5 rounded-xl font-mono text-xs font-bold transition-all cursor-pointer ${
                  settings.snapToGrid
                    ? 'bg-emerald-500 text-black shadow-[0_0_12px_rgba(16,185,129,0.3)]'
                    : 'bg-white/10 text-white/50 hover:bg-white/15'
                }`}
              >
                {settings.snapToGrid ? 'ACTIVE' : 'DISABLED'}
              </button>
            </div>

            {settings.snapToGrid && (
              <div className="pt-2 border-t border-white/5 flex items-center justify-between text-xs font-mono">
                <span className="text-white/60">Grid Node Interval:</span>
                <div className="flex gap-1.5">
                  {[20, 40, 60, 80].map((size) => (
                    <button
                      key={size}
                      type="button"
                      onClick={() => onUpdateSettings({ gridSnapSize: size })}
                      className={`px-2.5 py-1 rounded-lg text-[10px] font-mono cursor-pointer transition-colors ${
                        (settings.gridSnapSize || 40) === size
                          ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-400/40'
                          : 'bg-white/5 text-white/40 hover:text-white border border-white/5'
                      }`}
                    >
                      {size}px
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Section: Pen & Drawing Activation Mode */}
        <div className="space-y-3 pt-3 border-t border-white/10">
          <h3 className="text-[11px] font-mono font-bold uppercase tracking-wider text-emerald-400 flex items-center gap-1.5">
            <PenTool className="w-3.5 h-3.5 text-emerald-400" />
            <span>Single Line Drawing Activation Mode</span>
          </h3>

          <div className="grid grid-cols-2 gap-2">
            {[
              { id: 'auto_stream', label: 'Continuous Stream', desc: 'Draws fluidly whenever eyes move' },
              { id: 'hold_space', label: 'Spacebar Toggle', desc: 'Hit Space to start / pause single stroke' },
              { id: 'blink_toggle', label: 'Blink Mark', desc: 'Blink both eyes to drop / raise pen' },
              { id: 'dwell_trigger', label: 'Dwell Start', desc: 'Fixate 0.6s to start / stop line' },
            ].map(mode => (
              <button
                key={mode.id}
                type="button"
                onClick={() => onUpdateSettings({ penMode: mode.id as PenActivationMode })}
                className={`p-3 rounded-2xl border text-left transition-all cursor-pointer ${
                  settings.penMode === mode.id
                    ? 'border-emerald-400 bg-emerald-500/10 text-white shadow-[0_0_12px_rgba(16,185,129,0.15)]'
                    : 'border-white/10 bg-[#050505] text-white/50 hover:border-white/20'
                }`}
              >
                <div className="text-xs font-mono font-semibold text-white">{mode.label}</div>
                <div className="text-[10px] text-white/40 mt-0.5">{mode.desc}</div>
              </button>
            ))}
          </div>
        </div>

        {/* Section: Audio & Display Toggles */}
        <div className="space-y-3 pt-3 border-t border-white/10">
          <h3 className="text-[11px] font-mono font-bold uppercase tracking-wider text-emerald-400">
            Audio & Viewport Telemetry
          </h3>

          <div className="grid grid-cols-2 gap-2.5">
            {/* Audio Toggle */}
            <button
              type="button"
              onClick={() => {
                const next = !settings.audioEnabled;
                onUpdateSettings({ audioEnabled: next });
                soundEngine.setEnabled(next);
                if (next) soundEngine.playChime(520, 0.2);
              }}
              className="p-3.5 rounded-2xl border border-white/10 bg-[#050505] flex items-center justify-between text-xs text-white/70 hover:border-white/20 cursor-pointer"
            >
              <div className="flex items-center gap-2">
                {settings.audioEnabled ? <Volume2 className="w-4 h-4 text-emerald-400" /> : <VolumeX className="w-4 h-4 text-white/30" />}
                <span className="font-mono text-xs">Audio Synth</span>
              </div>
              <span className={`text-[10px] font-mono font-bold ${settings.audioEnabled ? 'text-emerald-400' : 'text-white/30'}`}>
                {settings.audioEnabled ? 'ON' : 'OFF'}
              </span>
            </button>

            {/* Camera PiP Toggle */}
            <button
              type="button"
              onClick={() => onUpdateSettings({ showWebcamPiP: !settings.showWebcamPiP })}
              className="p-3.5 rounded-2xl border border-white/10 bg-[#050505] flex items-center justify-between text-xs text-white/70 hover:border-white/20 cursor-pointer"
            >
              <div className="flex items-center gap-2">
                <Video className="w-4 h-4 text-emerald-400" />
                <span className="font-mono text-xs">Webcam PiP</span>
              </div>
              <span className={`text-[10px] font-mono font-bold ${settings.showWebcamPiP ? 'text-emerald-400' : 'text-white/30'}`}>
                {settings.showWebcamPiP ? 'SHOW' : 'HIDE'}
              </span>
            </button>

            {/* Particle Trail Toggle */}
            <button
              type="button"
              onClick={() => onUpdateSettings({ showGazeTrail: !settings.showGazeTrail })}
              className="p-3.5 rounded-2xl border border-white/10 bg-[#050505] flex items-center justify-between text-xs text-white/70 hover:border-white/20 cursor-pointer"
            >
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-teal-400" />
                <span className="font-mono text-xs">Particle Trail</span>
              </div>
              <span className={`text-[10px] font-mono font-bold ${settings.showGazeTrail ? 'text-teal-400' : 'text-white/30'}`}>
                {settings.showGazeTrail ? 'ON' : 'OFF'}
              </span>
            </button>

            {/* Head Compensation */}
            <button
              type="button"
              onClick={() => onUpdateSettings({ useHeadCompensation: !settings.useHeadCompensation })}
              className="p-3.5 rounded-2xl border border-white/10 bg-[#050505] flex items-center justify-between text-xs text-white/70 hover:border-white/20 cursor-pointer"
            >
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-emerald-400" />
                <span className="font-mono text-xs">Head Tracking</span>
              </div>
              <span className={`text-[10px] font-mono font-bold ${settings.useHeadCompensation ? 'text-emerald-400' : 'text-white/30'}`}>
                {settings.useHeadCompensation ? 'ON' : 'OFF'}
              </span>
            </button>
          </div>
        </div>

        {/* Section: Calibration Action */}
        <div className="pt-3 border-t border-white/10 flex gap-3">
          <button
            type="button"
            id="reset-calibration-data-btn"
            onClick={() => {
              calibrationEngine.resetCalibration();
              soundEngine.playChime(300, 0.2);
            }}
            className="flex-1 py-3 px-4 rounded-2xl border border-white/10 bg-white/5 hover:bg-white/10 text-xs font-mono font-semibold text-white/70 flex items-center justify-center gap-2 cursor-pointer transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Reset Alignment Cache</span>
          </button>

          <button
            type="button"
            id="launch-calibration-modal-btn"
            onClick={() => {
              onClose();
              onRecalibrate();
            }}
            className="flex-1 py-3 px-4 rounded-2xl bg-emerald-500 hover:bg-emerald-400 text-xs font-mono font-bold text-black shadow-lg shadow-emerald-500/20 flex items-center justify-center gap-2 cursor-pointer transition-all"
          >
            <Eye className="w-3.5 h-3.5" />
            <span>Start 9-Point Alignment</span>
          </button>
        </div>
      </div>
    </div>
  );
};
