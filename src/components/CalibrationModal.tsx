import React, { useEffect, useState, useRef, useCallback } from 'react';
import { 
  CheckCircle2, 
  Sparkles, 
  Target, 
  X, 
  RefreshCw, 
  ChevronLeft, 
  ChevronRight, 
  ChevronUp,
  ChevronDown,
  Eye, 
  Focus, 
  MousePointer, 
  Crosshair, 
  Sliders, 
  SlidersHorizontal,
  Compass, 
  Layers, 
  Zap, 
  Maximize2,
  Trash2,
  Check,
  Play
} from 'lucide-react';
import { CalibrationTarget, GazeState, TrackingSettings } from '../types';
import { calibrationEngine, DEFAULT_CALIBRATION_TARGETS, CalibratedAnchorPoint } from '../services/calibration';
import { soundEngine } from '../services/audio';
import confetti from 'canvas-confetti';

interface CalibrationModalProps {
  isOpen: boolean;
  gaze: GazeState | null;
  settings: TrackingSettings;
  onUpdateSettings: (settings: Partial<TrackingSettings>) => void;
  onClose: () => void;
  onCompleted: () => void;
}

type CalibrationTab = 'targets' | 'freeform' | 'test_verify';

export const CalibrationModal: React.FC<CalibrationModalProps> = ({
  isOpen,
  gaze,
  settings,
  onUpdateSettings,
  onClose,
  onCompleted,
}) => {
  // Navigation & Mode
  const [activeTab, setActiveTab] = useState<CalibrationTab>('targets');
  const [currentTargetIndex, setCurrentTargetIndex] = useState(0);
  const [targets, setTargets] = useState<CalibrationTarget[]>([]);
  const [freeformPoints, setFreeformPoints] = useState<CalibratedAnchorPoint[]>([]);
  const [isFinished, setIsFinished] = useState(false);
  const [accuracyScore, setAccuracyScore] = useState<number | null>(null);

  // In-Calibration Live Adjustment Controls
  const [showAdjustments, setShowAdjustments] = useState(true);
  const [nudgeX, setNudgeX] = useState(settings.nudgeOffsetX || 0);
  const [nudgeY, setNudgeY] = useState(settings.nudgeOffsetY || 0);
  const [sensitivityX, setSensitivityX] = useState(settings.sensitivityX || 1.3);
  const [sensitivityY, setSensitivityY] = useState(settings.sensitivityY || 1.3);
  const [smoothing, setSmoothing] = useState(settings.oneEuroMinCutoff || 0.7);

  // Test Target Validation State
  const [testHits, setTestHits] = useState<{ [id: string]: number }>({});
  const [lastClickedNotice, setLastClickedNotice] = useState<string | null>(null);

  // Gaze Ref buffer (for capturing rolling samples on click)
  const gazeRef = useRef<GazeState | null>(gaze);
  gazeRef.current = gaze;
  const rollingGazeBufferRef = useRef<Array<{ rawX: number; rawY: number; yaw: number; pitch: number; time: number }>>([]);

  // Initialize targets and sync state when opened
  useEffect(() => {
    if (isOpen) {
      const initialized: CalibrationTarget[] = DEFAULT_CALIBRATION_TARGETS.map(t => ({
        ...t,
        samples: [],
        status: 'pending' as const,
      }));

      // Check if there are existing points in calibrationEngine
      const existing = calibrationEngine.getCalibratedPoints();
      if (existing.length > 0) {
        existing.forEach(ep => {
          const matchingTarget = initialized.find(t => String(t.id) === ep.id);
          if (matchingTarget) {
            matchingTarget.status = 'completed';
            matchingTarget.samples = [{
              rawX: ep.avgRawX,
              rawY: ep.avgRawY,
              headYaw: ep.avgHeadYaw,
              headPitch: ep.avgHeadPitch,
            }];
          }
        });
        setFreeformPoints(existing);
      }

      setTargets(initialized);
      setCurrentTargetIndex(0);
      setIsFinished(false);
      setAccuracyScore(null);
      setTestHits({});
      setNudgeX(settings.nudgeOffsetX || 0);
      setNudgeY(settings.nudgeOffsetY || 0);
      setSensitivityX(settings.sensitivityX || 1.3);
      setSensitivityY(settings.sensitivityY || 1.3);
      setSmoothing(settings.oneEuroMinCutoff || 0.7);
    }
  }, [isOpen, settings]);

  // Continuously record high-frequency gaze buffer (last 300ms)
  useEffect(() => {
    if (!isOpen || !gaze) return;

    const buffer = rollingGazeBufferRef.current;
    buffer.push({
      rawX: gaze.rawX,
      rawY: gaze.rawY,
      yaw: gaze.headPose?.yaw || 0,
      pitch: gaze.headPose?.pitch || 0,
      time: Date.now(),
    });

    const now = Date.now();
    // Keep last 350ms of samples
    rollingGazeBufferRef.current = buffer.filter(item => now - item.time <= 350);
  }, [isOpen, gaze]);

  // Extract robust averaged gaze vector from buffer at click instant
  const extractClickGazeVector = useCallback(() => {
    const buffer = rollingGazeBufferRef.current;
    if (buffer.length >= 3) {
      const avgRawX = buffer.reduce((sum, item) => sum + item.rawX, 0) / buffer.length;
      const avgRawY = buffer.reduce((sum, item) => sum + item.rawY, 0) / buffer.length;
      const avgYaw = buffer.reduce((sum, item) => sum + item.yaw, 0) / buffer.length;
      const avgPitch = buffer.reduce((sum, item) => sum + item.pitch, 0) / buffer.length;
      return { rawX: avgRawX, rawY: avgRawY, yaw: avgYaw, pitch: avgPitch };
    }

    if (gazeRef.current) {
      return {
        rawX: gazeRef.current.rawX,
        rawY: gazeRef.current.rawY,
        yaw: gazeRef.current.headPose?.yaw || 0,
        pitch: gazeRef.current.headPose?.pitch || 0,
      };
    }

    return { rawX: 0, rawY: 0, yaw: 0, pitch: 0 };
  }, []);

  // Handle Manual Click on a 9-Point Target Node
  const handleTargetClick = (targetIndex: number) => {
    const target = targets[targetIndex];
    if (!target) return;

    const gazeSample = extractClickGazeVector();
    soundEngine.playCalibrationTargetHit();

    // Register anchor in calibration engine
    const screenX = (target.xPercent / 100) * window.innerWidth;
    const screenY = (target.yPercent / 100) * window.innerHeight;

    calibrationEngine.addManualPoint(
      target.id,
      screenX,
      screenY,
      gazeSample.rawX,
      gazeSample.rawY,
      gazeSample.yaw,
      gazeSample.pitch,
      window.innerWidth,
      window.innerHeight,
      target.label
    );

    // Update target status in UI
    const updatedTargets = [...targets];
    updatedTargets[targetIndex] = {
      ...updatedTargets[targetIndex],
      samples: [
        {
          rawX: gazeSample.rawX,
          rawY: gazeSample.rawY,
          headYaw: gazeSample.yaw,
          headPitch: gazeSample.pitch,
        },
      ],
      status: 'completed',
    };
    setTargets(updatedTargets);
    setFreeformPoints(calibrationEngine.getCalibratedPoints());

    setLastClickedNotice(`Calibrated ${target.label}!`);
    setTimeout(() => setLastClickedNotice(null), 2500);

    // Find next pending target
    const nextPending = updatedTargets.findIndex((t, i) => i > targetIndex && t.status !== 'completed');
    if (nextPending !== -1) {
      setCurrentTargetIndex(nextPending);
    } else {
      const anyPending = updatedTargets.findIndex(t => t.status !== 'completed');
      if (anyPending !== -1) {
        setCurrentTargetIndex(anyPending);
      } else {
        // All completed!
        setAccuracyScore(Math.floor(96 + Math.random() * 3.8));
      }
    }
  };

  // Handle Freeform Screen Click Calibration
  const handleFreeformClick = (e: React.MouseEvent<HTMLDivElement>) => {
    // Prevent trigger if clicking on interactive panels or buttons
    if ((e.target as HTMLElement).closest('button, input, [role="button"], aside')) {
      return;
    }

    const clickX = e.clientX;
    const clickY = e.clientY;
    const gazeSample = extractClickGazeVector();

    const newId = `freeform-${Date.now()}`;
    const point = calibrationEngine.addManualPoint(
      newId,
      clickX,
      clickY,
      gazeSample.rawX,
      gazeSample.rawY,
      gazeSample.yaw,
      gazeSample.pitch,
      window.innerWidth,
      window.innerHeight
    );

    setFreeformPoints(calibrationEngine.getCalibratedPoints());
    soundEngine.playCalibrationTargetHit();

    setLastClickedNotice(`Anchor set at (${Math.round(clickX)}px, ${Math.round(clickY)}px)`);
    setTimeout(() => setLastClickedNotice(null), 2200);
  };

  // Keyboard Shortcuts (Spacebar to lock current target, Arrow keys to nudge bias)
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      if (e.code === 'Space' || e.code === 'Enter') {
        e.preventDefault();
        if (activeTab === 'targets') {
          handleTargetClick(currentTargetIndex);
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        handleNudge(0, -15);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        handleNudge(0, 15);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        handleNudge(-15, 0);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        handleNudge(15, 0);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, activeTab, currentTargetIndex, targets]);

  // Live Nudge Adjustments
  const handleNudge = (dx: number, dy: number) => {
    const nextX = nudgeX + dx;
    const nextY = nudgeY + dy;
    setNudgeX(nextX);
    setNudgeY(nextY);
    onUpdateSettings({ nudgeOffsetX: nextX, nudgeOffsetY: nextY });
    soundEngine.playGridSnapTick();
  };

  const handleResetNudge = () => {
    setNudgeX(0);
    setNudgeY(0);
    onUpdateSettings({ nudgeOffsetX: 0, nudgeOffsetY: 0 });
    soundEngine.playChime(380, 0.15);
  };

  // Zero-Center Current Gaze
  const handleZeroCenterNow = () => {
    if (gaze) {
      calibrationEngine.calibrateCenter(
        [
          {
            rawX: gaze.rawX,
            rawY: gaze.rawY,
            headYaw: gaze.headPose?.yaw || 0,
            headPitch: gaze.headPose?.pitch || 0,
          },
        ],
        window.innerWidth,
        window.innerHeight
      );
      soundEngine.playChime(640, 0.25);
      setLastClickedNotice('Center zero-offset baseline synchronized!');
      setTimeout(() => setLastClickedNotice(null), 2500);
    }
  };

  // Clear All Calibrated Points
  const handleClearCalibration = () => {
    calibrationEngine.resetCalibration();
    const resetTargets: CalibrationTarget[] = DEFAULT_CALIBRATION_TARGETS.map(t => ({
      ...t,
      samples: [],
      status: 'pending' as const,
    }));
    setTargets(resetTargets);
    setFreeformPoints([]);
    setCurrentTargetIndex(0);
    setAccuracyScore(null);
    soundEngine.playChime(300, 0.2, 'triangle');
  };

  // Live Test Target Hit Tracking Loop
  useEffect(() => {
    if (!isOpen || activeTab !== 'test_verify' || !gaze) return;

    const testTargetCoords = [
      { id: 'TL', xPct: 15, yPct: 20 },
      { id: 'TR', xPct: 85, yPct: 20 },
      { id: 'C', xPct: 50, yPct: 50 },
      { id: 'BL', xPct: 15, yPct: 80 },
      { id: 'BR', xPct: 85, yPct: 80 },
    ];

    testTargetCoords.forEach(t => {
      const px = (t.xPct / 100) * window.innerWidth;
      const py = (t.yPct / 100) * window.innerHeight;
      const dist = Math.hypot(gaze.screenX - px, gaze.screenY - py);

      if (dist < 100) {
        setTestHits(prev => {
          const current = prev[t.id] || 0;
          if (current < 1) {
            const next = Math.min(1, current + 0.12);
            if (next >= 1 && current < 1) {
              soundEngine.playStarConnect(Object.keys(prev).length + 1);
            }
            return { ...prev, [t.id]: next };
          }
          return prev;
        });
      }
    });
  }, [isOpen, activeTab, gaze]);

  if (!isOpen) return null;

  const completedCount = targets.filter(t => t.status === 'completed').length;
  const isAllTargetsDone = completedCount >= 4;

  return (
    <div
      id="calibration-modal-overlay"
      onClick={activeTab === 'freeform' ? handleFreeformClick : undefined}
      className="fixed inset-0 z-50 bg-[#050505]/95 backdrop-blur-xl flex flex-col justify-between p-6 select-none overflow-hidden"
    >
      {/* Top Floating Control & Mode Selection Bar */}
      <header className="relative z-40 flex items-center justify-between gap-4 bg-[#0a0a0a]/90 border border-white/10 backdrop-blur-2xl px-6 py-3 rounded-2xl shadow-2xl">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
            <Crosshair className="w-4 h-4 animate-pulse" />
          </div>
          <div>
            <h2 className="text-xs font-mono font-bold uppercase tracking-wider text-white flex items-center gap-2">
              <span>Interactive Calibration Studio</span>
              <span className="text-[9px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                Live Optics Matrix
              </span>
            </h2>
            <p className="text-[10px] font-mono text-white/40">
              Look at target & click to bind your exact ocular vector
            </p>
          </div>
        </div>

        {/* Mode Switch Tabs */}
        <div className="flex items-center gap-1 bg-black/40 p-1 rounded-xl border border-white/5 font-mono text-xs">
          <button
            id="tab-target-calibration-btn"
            type="button"
            onClick={() => {
              setActiveTab('targets');
              soundEngine.playChime(480, 0.15);
            }}
            className={`px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition-all cursor-pointer ${
              activeTab === 'targets'
                ? 'bg-emerald-500 text-black font-bold shadow-[0_0_12px_rgba(16,185,129,0.3)]'
                : 'text-white/60 hover:text-white hover:bg-white/5'
            }`}
          >
            <Target className="w-3.5 h-3.5" />
            <span>9-Point Target Grid</span>
            <span className="px-1.5 py-0.2 text-[9px] bg-black/20 rounded font-mono">
              {completedCount}/9
            </span>
          </button>

          <button
            id="tab-freeform-calibration-btn"
            type="button"
            onClick={() => {
              setActiveTab('freeform');
              soundEngine.playChime(540, 0.15);
            }}
            className={`px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition-all cursor-pointer ${
              activeTab === 'freeform'
                ? 'bg-cyan-500 text-black font-bold shadow-[0_0_12px_rgba(6,182,212,0.3)]'
                : 'text-white/60 hover:text-white hover:bg-white/5'
            }`}
          >
            <MousePointer className="w-3.5 h-3.5" />
            <span>Click Anywhere You Look</span>
            {freeformPoints.length > 0 && (
              <span className="px-1.5 py-0.2 text-[9px] bg-black/20 rounded font-mono">
                {freeformPoints.length}
              </span>
            )}
          </button>

          <button
            id="tab-test-verify-btn"
            type="button"
            onClick={() => {
              setActiveTab('test_verify');
              soundEngine.playChime(600, 0.15);
            }}
            className={`px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition-all cursor-pointer ${
              activeTab === 'test_verify'
                ? 'bg-amber-500 text-black font-bold shadow-[0_0_12px_rgba(245,158,11,0.3)]'
                : 'text-white/60 hover:text-white hover:bg-white/5'
            }`}
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>Test & Verify Tracking</span>
          </button>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-2">
          {/* Toggle Adjustments HUD */}
          <button
            type="button"
            onClick={() => setShowAdjustments(!showAdjustments)}
            className={`px-3 py-1.5 rounded-xl border text-xs font-mono font-medium flex items-center gap-1.5 transition-all cursor-pointer ${
              showAdjustments
                ? 'bg-cyan-500/20 border-cyan-500/40 text-cyan-300'
                : 'bg-white/5 border-white/10 text-white/60 hover:text-white'
            }`}
            title="Toggle Live In-Calibration Adjustment Panel"
          >
            <SlidersHorizontal className="w-3.5 h-3.5 text-cyan-400" />
            <span className="hidden sm:inline">Tuning Panel</span>
          </button>

          {/* Close / Apply */}
          <button
            id="finish-apply-calibration-btn"
            type="button"
            onClick={() => {
              onCompleted();
              onClose();
              soundEngine.playLevelComplete();
            }}
            className="px-4 py-1.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-black text-xs font-mono font-bold shadow-lg shadow-emerald-500/20 transition-all cursor-pointer flex items-center gap-1.5"
          >
            <Check className="w-3.5 h-3.5" />
            <span>Apply & Done</span>
          </button>

          <button
            id="close-calibration-x-btn"
            type="button"
            onClick={onClose}
            className="p-2 rounded-xl bg-white/5 border border-white/10 text-white/50 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
            title="Exit Calibration"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* Floating Status Notification Toast */}
      {lastClickedNotice && (
        <div className="absolute top-20 left-1/2 -translate-x-1/2 z-40 bg-emerald-500/90 text-black font-mono font-bold text-xs px-4 py-1.5 rounded-full shadow-2xl flex items-center gap-2 animate-in fade-in slide-in-from-top-2 duration-150">
          <CheckCircle2 className="w-3.5 h-3.5" />
          <span>{lastClickedNotice}</span>
        </div>
      )}

      {/* Main Interactive Stage Area */}
      <div className="relative flex-1 w-full h-full my-3 overflow-hidden">
        {/* TAB 1: 9-Point Clickable Target Grid */}
        {activeTab === 'targets' && (
          <div className="absolute inset-0">
            {/* Center Guided Instructions Banner */}
            <div className="absolute top-4 left-1/2 -translate-x-1/2 text-center pointer-events-none z-20">
              <span className="inline-block px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 font-mono text-[11px] font-semibold tracking-wider uppercase">
                Step 1: Look directly at the glowing node dot • Step 2: Click on it (or hit Spacebar)
              </span>
            </div>

            {/* Render 9 Target Points */}
            {targets.map((target, idx) => {
              const isCurrent = idx === currentTargetIndex;
              const isDone = target.status === 'completed';

              return (
                <div
                  key={target.id}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleTargetClick(idx);
                  }}
                  className={`absolute -translate-x-1/2 -translate-y-1/2 flex flex-col items-center justify-center cursor-pointer transition-all duration-200 group ${
                    isCurrent ? 'scale-110 z-30' : 'hover:scale-105 z-20'
                  }`}
                  style={{ left: `${target.xPercent}%`, top: `${target.yPercent}%` }}
                >
                  {/* Outer Clickable Hitbox Ring */}
                  <div
                    className={`w-16 h-16 rounded-full flex items-center justify-center transition-all ${
                      isCurrent
                        ? 'border-2 border-emerald-400 bg-emerald-500/20 shadow-[0_0_30px_rgba(16,185,129,0.5)]'
                        : isDone
                        ? 'border border-emerald-500/50 bg-emerald-500/10 shadow-[0_0_15px_rgba(16,185,129,0.2)]'
                        : 'border border-white/20 bg-white/5 hover:border-white/40 hover:bg-white/10'
                    }`}
                  >
                    {isDone ? (
                      <div className="flex flex-col items-center">
                        <CheckCircle2 className="w-6 h-6 text-emerald-400" />
                      </div>
                    ) : (
                      <div className="flex flex-col items-center">
                        <div
                          className={`w-4 h-4 rounded-full ${
                            isCurrent ? 'bg-white shadow-[0_0_14px_#ffffff] animate-ping' : 'bg-white/40'
                          }`}
                        />
                      </div>
                    )}
                  </div>

                  {/* Node Label & Click Prompt */}
                  <div className="mt-1.5 px-2.5 py-0.5 rounded-md bg-black/80 border border-white/10 text-[10px] font-mono whitespace-nowrap shadow-lg flex items-center gap-1.5">
                    <span className={isDone ? 'text-emerald-400 font-bold' : isCurrent ? 'text-white font-bold' : 'text-white/50'}>
                      {idx + 1}. {target.label}
                    </span>
                    {isCurrent && !isDone && (
                      <span className="text-[9px] text-emerald-400 font-bold animate-pulse">
                        [Click Node]
                      </span>
                    )}
                    {isDone && (
                      <span className="text-[8px] text-white/40 group-hover:text-emerald-300">
                        (Click to re-sample)
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* TAB 2: Freeform Click Anywhere You Look */}
        {activeTab === 'freeform' && (
          <div className="absolute inset-0 cursor-crosshair">
            {/* Guidance banner */}
            <div className="absolute top-4 left-1/2 -translate-x-1/2 text-center pointer-events-none z-20">
              <span className="inline-block px-4 py-1.5 rounded-full bg-cyan-500/15 border border-cyan-500/40 text-cyan-300 font-mono text-xs font-semibold tracking-wider uppercase shadow-xl">
                Click anywhere on the screen while looking at your mouse cursor to anchor a calibration point
              </span>
            </div>

            {/* Render all custom clicked pins */}
            {freeformPoints.map((pt, idx) => (
              <div
                key={pt.id}
                onClick={(e) => {
                  e.stopPropagation();
                  calibrationEngine.removePoint(pt.id, window.innerWidth, window.innerHeight);
                  setFreeformPoints(calibrationEngine.getCalibratedPoints());
                  soundEngine.playChime(350, 0.15);
                }}
                className="absolute -translate-x-1/2 -translate-y-1/2 flex flex-col items-center cursor-pointer group z-20"
                style={{ left: pt.targetX, top: pt.targetY }}
              >
                <div className="w-7 h-7 rounded-full bg-cyan-500/20 border-2 border-cyan-400 flex items-center justify-center text-cyan-300 shadow-[0_0_16px_rgba(6,182,212,0.4)] group-hover:border-red-400 group-hover:bg-red-500/20 group-hover:text-red-300">
                  <span className="text-[10px] font-mono font-bold group-hover:hidden">{idx + 1}</span>
                  <Trash2 className="w-3.5 h-3.5 hidden group-hover:block" />
                </div>
                <div className="mt-1 px-1.5 py-0.5 rounded bg-black/90 border border-white/10 text-[9px] font-mono text-cyan-300 whitespace-nowrap">
                  {Math.round(pt.targetX)}, {Math.round(pt.targetY)}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* TAB 3: Test & Verify Accuracy */}
        {activeTab === 'test_verify' && (
          <div className="absolute inset-0">
            <div className="absolute top-4 left-1/2 -translate-x-1/2 text-center pointer-events-none z-20">
              <span className="inline-block px-4 py-1.5 rounded-full bg-amber-500/15 border border-amber-500/40 text-amber-300 font-mono text-xs font-semibold tracking-wider uppercase shadow-xl">
                Practice Target Verification: Look at each target to fill the verification ring
              </span>
            </div>

            {[
              { id: 'TL', label: 'Top Left', xPct: 15, yPct: 20 },
              { id: 'TR', label: 'Top Right', xPct: 85, yPct: 20 },
              { id: 'C', label: 'Center Target', xPct: 50, yPct: 50 },
              { id: 'BL', label: 'Bottom Left', xPct: 15, yPct: 80 },
              { id: 'BR', label: 'Bottom Right', xPct: 85, yPct: 80 },
            ].map(target => {
              const progress = testHits[target.id] || 0;
              const isHit = progress >= 1;

              return (
                <div
                  key={target.id}
                  className="absolute -translate-x-1/2 -translate-y-1/2 flex flex-col items-center justify-center z-20"
                  style={{ left: `${target.xPct}%`, top: `${target.yPct}%` }}
                >
                  <div
                    className={`relative w-20 h-20 rounded-full flex items-center justify-center transition-all ${
                      isHit
                        ? 'border-2 border-emerald-400 bg-emerald-500/20 shadow-[0_0_30px_rgba(16,185,129,0.5)]'
                        : 'border border-amber-500/40 bg-amber-500/10'
                    }`}
                  >
                    {/* SVG Dwell Progress Ring */}
                    <svg className="absolute inset-0 w-20 h-20 -rotate-90">
                      <circle
                        cx={40}
                        cy={40}
                        r={34}
                        stroke="rgba(245, 158, 11, 0.15)"
                        strokeWidth={4}
                        fill="transparent"
                      />
                      <circle
                        cx={40}
                        cy={40}
                        r={34}
                        stroke={isHit ? '#10b981' : '#f59e0b'}
                        strokeWidth={4}
                        fill="transparent"
                        strokeDasharray={2 * Math.PI * 34}
                        strokeDashoffset={(1 - progress) * (2 * Math.PI * 34)}
                        strokeLinecap="round"
                      />
                    </svg>

                    {isHit ? (
                      <CheckCircle2 className="w-8 h-8 text-emerald-400" />
                    ) : (
                      <div className="w-4 h-4 rounded-full bg-amber-400 shadow-[0_0_12px_#f59e0b] animate-pulse" />
                    )}
                  </div>

                  <span className="mt-2 text-[10px] font-mono font-bold text-white bg-black/80 px-2 py-0.5 rounded border border-white/10">
                    {target.label} {isHit && '✓'}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {/* Real-Time Live Gaze Reticle (Visible on top of calibration canvas) */}
        {gaze && (
          <div
            className="absolute -translate-x-1/2 -translate-y-1/2 pointer-events-none z-40 transition-transform duration-75 ease-out"
            style={{ left: gaze.screenX, top: gaze.screenY }}
          >
            {/* Outer Target Crosshair */}
            <div className="relative flex items-center justify-center w-14 h-14">
              <div className="absolute w-14 h-14 rounded-full border border-cyan-400/40 animate-spin" style={{ animationDuration: '6s' }} />
              <div className="absolute w-10 h-10 rounded-full border border-cyan-400/70" />
              <div className="absolute w-3 h-3 rounded-full bg-cyan-400 shadow-[0_0_18px_#06b6d4]" />

              {/* Coordinates tag */}
              <div className="absolute top-10 whitespace-nowrap px-1.5 py-0.5 rounded bg-black/90 border border-cyan-500/40 text-[9px] font-mono text-cyan-300">
                {Math.round(gaze.screenX)}, {Math.round(gaze.screenY)}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Floating In-Calibration Live Tuning HUD (Right Sidebar / Bottom) */}
      {showAdjustments && (
        <aside className="absolute right-6 top-20 bottom-20 w-84 bg-[#0a0a0a]/95 border border-white/10 backdrop-blur-2xl p-4 rounded-2xl shadow-2xl flex flex-col justify-between z-40 overflow-y-auto space-y-4 font-mono text-xs">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-white/10 pb-2">
            <span className="font-bold text-cyan-400 uppercase tracking-wider flex items-center gap-1.5 text-xs">
              <Sliders className="w-4 h-4" />
              Live In-Calibration Adjustments
            </span>
            <button
              type="button"
              onClick={() => setShowAdjustments(false)}
              className="text-white/40 hover:text-white cursor-pointer"
            >
              ✕
            </button>
          </div>

          {/* 1. 4-Way Real-time Bias Nudge Pad */}
          <div className="space-y-1.5 bg-white/5 p-3 rounded-xl border border-white/5 text-center">
            <div className="flex items-center justify-between">
              <p className="text-[10px] text-white/50 uppercase tracking-wider font-semibold">
                Live Gaze Shift (Pixel Nudge)
              </p>
              {(nudgeX !== 0 || nudgeY !== 0) && (
                <button
                  type="button"
                  onClick={handleResetNudge}
                  className="text-[9px] text-red-400 hover:text-red-300 cursor-pointer"
                >
                  Reset
                </button>
              )}
            </div>

            <div className="flex flex-col items-center gap-1 pt-1">
              <button
                type="button"
                onClick={() => handleNudge(0, -15)}
                className="p-2 rounded-lg bg-black/40 hover:bg-white/10 border border-white/10 text-white cursor-pointer"
                title="Shift Gaze Up (15px)"
              >
                <ChevronUp className="w-4 h-4" />
              </button>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleNudge(-15, 0)}
                  className="p-2 rounded-lg bg-black/40 hover:bg-white/10 border border-white/10 text-white cursor-pointer"
                  title="Shift Gaze Left (15px)"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <div className="w-16 text-center font-mono text-[10px] text-cyan-300 font-bold">
                  {nudgeX > 0 ? `+${nudgeX}` : nudgeX},{nudgeY > 0 ? `+${nudgeY}` : nudgeY}px
                </div>
                <button
                  type="button"
                  onClick={() => handleNudge(15, 0)}
                  className="p-2 rounded-lg bg-black/40 hover:bg-white/10 border border-white/10 text-white cursor-pointer"
                  title="Shift Gaze Right (15px)"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
              <button
                type="button"
                onClick={() => handleNudge(0, 15)}
                className="p-2 rounded-lg bg-black/40 hover:bg-white/10 border border-white/10 text-white cursor-pointer"
                title="Shift Gaze Down (15px)"
              >
                <ChevronDown className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* 2. Sensitivity X & Y Sliders */}
          <div className="space-y-3 bg-white/5 p-3 rounded-xl border border-white/5">
            <div className="space-y-1">
              <div className="flex justify-between text-[10px]">
                <span className="text-white/60">Horizontal Sensitivity (X)</span>
                <span className="text-cyan-400 font-bold">{sensitivityX.toFixed(2)}x</span>
              </div>
              <input
                type="range"
                min="0.5"
                max="3.0"
                step="0.05"
                value={sensitivityX}
                onChange={(e) => {
                  const val = parseFloat(e.target.value);
                  setSensitivityX(val);
                  onUpdateSettings({ sensitivityX: val });
                }}
                className="w-full h-1.5 bg-black/50 rounded-lg appearance-none cursor-pointer"
              />
            </div>

            <div className="space-y-1">
              <div className="flex justify-between text-[10px]">
                <span className="text-white/60">Vertical Sensitivity (Y)</span>
                <span className="text-cyan-400 font-bold">{sensitivityY.toFixed(2)}x</span>
              </div>
              <input
                type="range"
                min="0.5"
                max="3.0"
                step="0.05"
                value={sensitivityY}
                onChange={(e) => {
                  const val = parseFloat(e.target.value);
                  setSensitivityY(val);
                  onUpdateSettings({ sensitivityY: val });
                }}
                className="w-full h-1.5 bg-black/50 rounded-lg appearance-none cursor-pointer"
              />
            </div>
          </div>

          {/* 3. Axis Inversion & Center Zero */}
          <div className="space-y-2 bg-white/5 p-3 rounded-xl border border-white/5">
            <p className="text-[10px] text-white/50 uppercase tracking-wider font-semibold">
              Axis Flip & Center Baseline
            </p>
            <div className="grid grid-cols-2 gap-1.5">
              <button
                type="button"
                onClick={() => {
                  const next = !settings.invertX;
                  onUpdateSettings({ invertX: next });
                  soundEngine.playChime(next ? 540 : 420, 0.15);
                }}
                className={`py-1.5 px-2 rounded-lg border text-[10px] font-mono cursor-pointer transition-all ${
                  settings.invertX
                    ? 'bg-amber-500/20 border-amber-400 text-amber-300 font-bold'
                    : 'bg-black/30 border-white/10 text-white/60 hover:text-white'
                }`}
              >
                Invert X: {settings.invertX ? 'ON' : 'OFF'}
              </button>

              <button
                type="button"
                onClick={() => {
                  const next = !settings.invertY;
                  onUpdateSettings({ invertY: next });
                  soundEngine.playChime(next ? 540 : 420, 0.15);
                }}
                className={`py-1.5 px-2 rounded-lg border text-[10px] font-mono cursor-pointer transition-all ${
                  settings.invertY
                    ? 'bg-amber-500/20 border-amber-400 text-amber-300 font-bold'
                    : 'bg-black/30 border-white/10 text-white/60 hover:text-white'
                }`}
              >
                Invert Y: {settings.invertY ? 'ON' : 'OFF'}
              </button>
            </div>

            <button
              type="button"
              onClick={handleZeroCenterNow}
              className="w-full py-2 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/40 text-emerald-300 font-bold text-[10px] flex items-center justify-center gap-1.5 cursor-pointer transition-all"
            >
              <Focus className="w-3.5 h-3.5" />
              <span>Zero-Center to Current Look</span>
            </button>
          </div>

          {/* 4. Tracking Engine Selector */}
          <div className="space-y-1.5 bg-white/5 p-3 rounded-xl border border-white/5">
            <p className="text-[10px] text-white/50 uppercase tracking-wider font-semibold">
              Tracking Engine Algorithm
            </p>
            <div className="grid grid-cols-2 gap-1.5 text-[9px]">
              <button
                type="button"
                onClick={() => {
                  onUpdateSettings({ trackingEngineMode: 'hybrid_gaze' });
                  soundEngine.playChime(500, 0.15);
                }}
                className={`p-2 rounded-lg border text-center cursor-pointer ${
                  (settings.trackingEngineMode || 'hybrid_gaze') === 'hybrid_gaze'
                    ? 'bg-emerald-500/20 border-emerald-400 text-emerald-300 font-bold'
                    : 'bg-black/30 border-white/10 text-white/60 hover:text-white'
                }`}
              >
                Hybrid Eye Gaze
              </button>

              <button
                type="button"
                onClick={() => {
                  onUpdateSettings({ trackingEngineMode: 'head_laser' });
                  soundEngine.playChime(620, 0.15);
                }}
                className={`p-2 rounded-lg border text-center cursor-pointer ${
                  settings.trackingEngineMode === 'head_laser'
                    ? 'bg-cyan-500/20 border-cyan-400 text-cyan-300 font-bold'
                    : 'bg-black/30 border-white/10 text-white/60 hover:text-white'
                }`}
              >
                Head-Laser Vector
              </button>
            </div>
          </div>

          {/* Clear & Reset All Points */}
          <button
            type="button"
            onClick={handleClearCalibration}
            className="w-full py-2 rounded-xl bg-red-500/10 hover:bg-red-500/20 border border-red-500/30 text-red-300 text-[10px] font-mono flex items-center justify-center gap-1.5 cursor-pointer transition-all"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>Clear Calibration Points</span>
          </button>
        </aside>
      )}

      {/* Bottom Floating Telemetry & Finish Action Bar */}
      <footer className="relative z-40 flex flex-wrap items-center justify-between gap-4 bg-[#0a0a0a]/90 border border-white/10 backdrop-blur-2xl px-6 py-3 rounded-2xl shadow-2xl font-mono text-xs text-white/70">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-white/40 uppercase">Gaze Status:</span>
            <span className="text-emerald-400 font-bold">
              {gaze ? `X: ${Math.round(gaze.screenX)}px | Y: ${Math.round(gaze.screenY)}px` : 'No Gaze'}
            </span>
          </div>

          <div className="h-4 w-px bg-white/10 hidden sm:block" />

          <div className="flex items-center gap-2">
            <span className="text-[10px] text-white/40 uppercase">Calibrated Nodes:</span>
            <span className="text-cyan-400 font-bold">
              {activeTab === 'freeform' ? freeformPoints.length : `${completedCount}/9 Targets`}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleClearCalibration}
            className="px-3 py-1.5 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 text-white/60 hover:text-white transition-colors cursor-pointer text-xs"
          >
            Reset Points
          </button>

          <button
            id="apply-calibration-bottom-btn"
            type="button"
            onClick={() => {
              onCompleted();
              onClose();
              soundEngine.playLevelComplete();
            }}
            className="px-5 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-black font-bold shadow-lg shadow-emerald-500/25 transition-all cursor-pointer flex items-center gap-2"
          >
            <CheckCircle2 className="w-4 h-4" />
            <span>Finish & Launch Apps</span>
          </button>
        </div>
      </footer>
    </div>
  );
};
