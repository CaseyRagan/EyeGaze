import React, { useState, useEffect, useRef } from 'react';
import { 
  Activity, 
  Camera, 
  Compass, 
  Eye, 
  Focus,
  HelpCircle,
  MessageSquare, 
  MousePointer, 
  PenTool, 
  RefreshCw, 
  Settings, 
  Sparkles, 
  Star, 
  Target, 
  Video, 
  VideoOff, 
  Zap,
  BrainCircuit
} from 'lucide-react';
import { ActivityMode, GazeState, TrackingSettings } from './types';
import { FaceMeshTracker, TrackerStatus } from './services/faceMeshTracker';
import { calibrationEngine } from './services/calibration';
import { soundEngine } from './services/audio';
import { GazeCursor } from './components/GazeCursor';
import { CameraFeed } from './components/CameraFeed';
import { CalibrationModal } from './components/CalibrationModal';
import { CenterCalibrationGate } from './components/CenterCalibrationGate';
import { SettingsModal } from './components/SettingsModal';
import { DrawingCanvas } from './components/DrawingCanvas';
import { ConstellationTask } from './components/Activities/ConstellationTask';
import { GazeMazeTask } from './components/Activities/GazeMazeTask';
import { TargetPopTask } from './components/Activities/TargetPopTask';
import { GazeTypingTask } from './components/Activities/GazeTypingTask';
import { ReadingAnalysisTask } from './components/ReadingAnalysisTask';
import { StatsBar } from './components/StatsBar';

export default function App() {
  const [activeTab, setActiveTab] = useState<ActivityMode>('single_line');
  const [trackerStatus, setTrackerStatus] = useState<TrackerStatus>('uninitialized');
  const [trackerError, setTrackerError] = useState<string | null>(null);
  const [gaze, setGaze] = useState<GazeState | null>(null);
  const [videoElement, setVideoElement] = useState<HTMLVideoElement | null>(null);
  const [landmarks, setLandmarks] = useState<any[] | null>(null);
  const [showMeshOverlay, setShowMeshOverlay] = useState(true);
  const [isCalibrationOpen, setIsCalibrationOpen] = useState(false);
  const [isCenterGateOpen, setIsCenterGateOpen] = useState(true);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [mouseSimMode, setMouseSimMode] = useState(false);
  const [fps, setFps] = useState(60);

  const trackerRef = useRef<FaceMeshTracker | null>(null);
  const fpsFrameCount = useRef(0);
  const lastFpsTime = useRef(Date.now());

  const [settings, setSettings] = useState<TrackingSettings>({
    smoothingFactor: 0.18,
    oneEuroMinCutoff: 0.8,
    oneEuroBeta: 0.04,
    saccadeThreshold: 45,
    sensitivityX: 1.3,
    sensitivityY: 1.3,
    deadzone: 5,
    nudgeOffsetX: 0,
    nudgeOffsetY: 0,
    trackingEngineMode: 'hybrid_gaze',
    magneticSnapAssist: true,
    snapToGrid: false,
    gridSnapSize: 40,
    dwellDurationMs: 800,
    invertX: false,
    invertY: false,
    useHeadCompensation: true,
    useQuadraticMapping: true,
    penMode: 'auto_stream',
    audioEnabled: true,
    showWebcamPiP: true,
    showLandmarkMesh: true,
    showGazeTrail: true,
    showGazeReticle: true,
    strokeColor: '#10b981',
    strokeGlowColor: '#059669',
    strokeWidth: 6,
  });

  // Initialize eye tracker on mount
  useEffect(() => {
    const tracker = new FaceMeshTracker({
      onStatusChange: (status, errorMsg) => {
        setTrackerStatus(status);
        if (errorMsg) setTrackerError(errorMsg);
      },
      onGazeUpdate: (newGaze) => {
        setGaze(newGaze);

        // FPS tracking
        fpsFrameCount.current++;
        const now = Date.now();
        if (now - lastFpsTime.current >= 1000) {
          setFps(fpsFrameCount.current);
          fpsFrameCount.current = 0;
          lastFpsTime.current = now;
        }
      },
      onVideoFrame: (video, frameLandmarks) => {
        setVideoElement(video);
        setLandmarks(frameLandmarks);
      },
    });

    trackerRef.current = tracker;
    tracker.initialize();

    return () => {
      tracker.dispose();
    };
  }, []);

  // Global keyboard shortcuts (C for Re-Zero Center, K for Calibration)
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'c' || e.key === 'C') {
        e.preventDefault();
        setIsCenterGateOpen(true);
        soundEngine.playChime(540, 0.15);
      }
    };
    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, []);

  const handleUpdateSettings = (newSettings: Partial<TrackingSettings>) => {
    setSettings(prev => {
      const updated = { ...prev, ...newSettings };
      trackerRef.current?.updateSettings(updated);
      return updated;
    });
  };

  // Mouse fallback pointer movement
  const handlePointerMove = (e: React.PointerEvent) => {
    if (mouseSimMode && trackerRef.current) {
      trackerRef.current.simulateGazeFromPointer(e.clientX, e.clientY);
    }
  };

  const handlePointerDown = () => {
    if (mouseSimMode && trackerRef.current) {
      soundEngine.playBlinkClick();
    }
  };

  return (
    <div
      id="gazeflow-app-root"
      onPointerMove={handlePointerMove}
      onPointerDown={handlePointerDown}
      className="relative w-screen h-screen overflow-hidden bg-[#050505] flex flex-col font-['Plus_Jakarta_Sans',sans-serif] text-[#e0e0e0] select-none"
    >
      {/* Top Main Navigation & Optics Status Bar */}
      <header className="relative z-30 flex items-center justify-between px-6 py-3.5 border-b border-white/5 bg-[#080808]/80 backdrop-blur-md shrink-0">
        {/* Brand & Technical Status */}
        <div className="flex items-center gap-4">
          <div className="w-2.5 h-2.5 bg-emerald-500 rounded-full shadow-[0_0_10px_rgba(16,185,129,0.6)] animate-pulse" />
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xs font-bold tracking-[0.35em] uppercase text-white/90 font-mono-tech">
                GazeFlow Optics v4.0
              </h1>
              <span className="text-[9px] uppercase font-mono font-semibold tracking-widest px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                Active
              </span>
            </div>
            <p className="text-[10px] text-white/30 tracking-wider font-mono hidden md:block">
              NEURAL GAZE VECTOR INTERFACE
            </p>
          </div>
        </div>

        {/* Activity Tab Switcher */}
        <nav className="flex items-center gap-1 bg-[#0d0d0d] border border-white/10 p-1 rounded-xl shadow-inner">
          <button
            id="tab-single-line"
            onClick={() => {
              setActiveTab('single_line');
              soundEngine.playChime(440, 0.2);
            }}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer ${
              activeTab === 'single_line'
                ? 'bg-white/10 text-white border border-white/20 shadow-[0_0_12px_rgba(16,185,129,0.15)]'
                : 'text-white/40 hover:text-white/80 hover:bg-white/5'
            }`}
          >
            <PenTool className="w-3.5 h-3.5 text-emerald-400" />
            <span className="tracking-wide">Single Line</span>
          </button>

          <button
            id="tab-constellation"
            onClick={() => {
              setActiveTab('constellation');
              soundEngine.playChime(520, 0.2);
            }}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer ${
              activeTab === 'constellation'
                ? 'bg-white/10 text-white border border-white/20 shadow-[0_0_12px_rgba(16,185,129,0.15)]'
                : 'text-white/40 hover:text-white/80 hover:bg-white/5'
            }`}
          >
            <Star className="w-3.5 h-3.5 text-cyan-400" />
            <span className="tracking-wide">Constellations</span>
          </button>

          <button
            id="tab-maze"
            onClick={() => {
              setActiveTab('maze');
              soundEngine.playChime(580, 0.2);
            }}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer ${
              activeTab === 'maze'
                ? 'bg-white/10 text-white border border-white/20 shadow-[0_0_12px_rgba(16,185,129,0.15)]'
                : 'text-white/40 hover:text-white/80 hover:bg-white/5'
            }`}
          >
            <Compass className="w-3.5 h-3.5 text-teal-400" />
            <span className="tracking-wide">Gaze Maze</span>
          </button>

          <button
            id="tab-target-pop"
            onClick={() => {
              setActiveTab('target_pop');
              soundEngine.playChime(640, 0.2);
            }}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer ${
              activeTab === 'target_pop'
                ? 'bg-white/10 text-white border border-white/20 shadow-[0_0_12px_rgba(16,185,129,0.15)]'
                : 'text-white/40 hover:text-white/80 hover:bg-white/5'
            }`}
          >
            <Target className="w-3.5 h-3.5 text-emerald-400" />
            <span className="tracking-wide">Target Burst</span>
          </button>

          <button
            id="tab-quick-type"
            onClick={() => {
              setActiveTab('quick_type');
              soundEngine.playChime(700, 0.2);
            }}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer ${
              activeTab === 'quick_type'
                ? 'bg-white/10 text-white border border-white/20 shadow-[0_0_12px_rgba(16,185,129,0.15)]'
                : 'text-white/40 hover:text-white/80 hover:bg-white/5'
            }`}
          >
            <MessageSquare className="w-3.5 h-3.5 text-cyan-400" />
            <span className="tracking-wide">Communicator</span>
          </button>

          <button
            id="tab-reading-analysis"
            onClick={() => {
              setActiveTab('reading_analysis');
              soundEngine.playChime(750, 0.2);
            }}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer ${
              activeTab === 'reading_analysis'
                ? 'bg-white/10 text-white border border-white/20 shadow-[0_0_12px_rgba(16,185,129,0.15)]'
                : 'text-white/40 hover:text-white/80 hover:bg-white/5'
            }`}
          >
            <BrainCircuit className="w-3.5 h-3.5 text-purple-400" />
            <span className="tracking-wide">ReadAlyzer</span>
          </button>
        </nav>

        {/* Right Status Columns & Controls */}
        <div className="flex items-center gap-4">
          {/* Live Telemetry Bar */}
          <StatsBar
            gaze={gaze}
            fps={fps}
            onOpenCalibration={() => setIsCalibrationOpen(true)}
          />

          {/* Mouse / Pointer Simulation Fallback Toggle */}
          <button
            id="toggle-mouse-sim-btn"
            onClick={() => {
              setMouseSimMode(!mouseSimMode);
              soundEngine.playChime(mouseSimMode ? 350 : 650, 0.2);
            }}
            className={`px-3 py-1.5 rounded-lg text-xs font-mono font-medium border flex items-center gap-1.5 transition-colors cursor-pointer ${
              mouseSimMode
                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30 shadow-[0_0_10px_rgba(16,185,129,0.2)]'
                : 'bg-[#0d0d0d] border-white/10 text-white/40 hover:text-white/80 hover:border-white/20'
            }`}
            title="Toggle pointer simulation mode"
          >
            <MousePointer className="w-3.5 h-3.5" />
            <span className="hidden xl:inline">{mouseSimMode ? 'Sim: ON' : 'Pointer Sim'}</span>
          </button>

          {/* Quick Re-Zero Center Gate */}
          <button
            id="header-rezero-center-btn"
            onClick={() => setIsCenterGateOpen(true)}
            className="px-3 py-1.5 rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 text-emerald-400 text-xs font-mono font-medium flex items-center gap-1.5 transition-colors cursor-pointer"
            title="Re-Zero Center Gaze Offset (Hotkey: C)"
          >
            <Focus className="w-3.5 h-3.5" />
            <span className="hidden lg:inline">RE-ZERO</span>
            <kbd className="hidden sm:inline px-1 bg-black/40 rounded text-[9px] text-white/40 border border-white/10">C</kbd>
          </button>

          {/* 9-Point Calibration Action */}
          <button
            id="header-calibrate-btn"
            onClick={() => setIsCalibrationOpen(true)}
            className="px-3.5 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-white/80 text-xs font-mono font-semibold tracking-wider flex items-center gap-1.5 transition-colors cursor-pointer"
            title="Launch 9-Point Gaze Calibration"
          >
            <Zap className="w-3.5 h-3.5 text-yellow-400" />
            <span>9-PT CALIB</span>
          </button>

          {/* Settings Button */}
          <button
            id="header-settings-btn"
            onClick={() => setIsSettingsOpen(true)}
            className="p-2 rounded-lg bg-[#0d0d0d] border border-white/10 text-white/40 hover:text-white hover:border-white/20 transition-colors cursor-pointer"
            title="Open Eye Tracking Settings"
          >
            <Settings className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* Main Interactive Stage */}
      <main className="relative flex-1 w-full h-full overflow-hidden bg-[#050505]">
        {/* Four Calibration Precision Corners (Sophisticated Dark Aesthetic) */}
        <div className="absolute top-4 left-4 w-5 h-5 border-l-2 border-t-2 border-white/20 pointer-events-none z-10" />
        <div className="absolute top-4 right-4 w-5 h-5 border-r-2 border-t-2 border-white/20 pointer-events-none z-10" />
        <div className="absolute bottom-4 left-4 w-5 h-5 border-l-2 border-b-2 border-white/20 pointer-events-none z-10" />
        <div className="absolute bottom-4 right-4 w-5 h-5 border-r-2 border-b-2 border-white/20 pointer-events-none z-10" />

        {/* Loading / Error Banner */}
        {trackerStatus !== 'running' && (
          <div className="absolute inset-0 z-40 bg-[#050505]/95 backdrop-blur-md flex flex-col items-center justify-center p-6 text-center">
            <div className="max-w-md w-full bg-[#080808] border border-white/10 rounded-2xl p-8 shadow-2xl space-y-6">
              <div className="w-14 h-14 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center mx-auto text-emerald-400">
                <Camera className="w-7 h-7 animate-pulse" />
              </div>

              <div>
                <span className="inline-block px-3 py-1 bg-emerald-500/10 text-emerald-400 text-[10px] font-bold tracking-widest uppercase rounded-full mb-3 font-mono">
                  Optical Sensor Feed
                </span>
                <h3 className="text-xl font-light text-white font-serif-chic italic">
                  {trackerStatus === 'loading_model' && 'Initializing Vision Matrix...'}
                  {trackerStatus === 'requesting_camera' && 'Connecting to Optical Sensor...'}
                  {trackerStatus === 'error' && 'Optical Stream Interrupted'}
                  {trackerStatus === 'uninitialized' && 'Preparing Neural Eye Tracker...'}
                </h3>
                <p className="mt-2 text-xs text-white/50 leading-relaxed font-mono">
                  {trackerStatus === 'loading_model' && 'Downloading 478-point 3D iris neural network model.'}
                  {trackerStatus === 'requesting_camera' && 'Please grant webcam permission to activate real-time gaze telemetry.'}
                  {trackerStatus === 'error' && (trackerError || 'Sensor initialization timed out. Pointer simulation is available.')}
                </p>
              </div>

              <div className="flex gap-3">
                <button
                  id="retry-camera-init-btn"
                  onClick={() => trackerRef.current?.initialize()}
                  className="flex-1 py-2.5 px-4 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-black font-semibold text-xs shadow-lg shadow-emerald-500/20 flex items-center justify-center gap-2 cursor-pointer transition-all font-mono"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>Retry Camera</span>
                </button>
                <button
                  id="enable-pointer-sim-fallback-btn"
                  onClick={() => {
                    setMouseSimMode(true);
                    setTrackerStatus('running');
                  }}
                  className="flex-1 py-2.5 px-4 rounded-xl border border-white/15 bg-white/5 hover:bg-white/10 text-white/80 text-xs font-semibold flex items-center justify-center gap-2 cursor-pointer transition-colors font-mono"
                >
                  <MousePointer className="w-3.5 h-3.5" />
                  <span>Use Pointer Sim</span>
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Selected Activity Views */}
        {activeTab === 'single_line' && (
          <DrawingCanvas
            gaze={gaze}
            settings={settings}
            onUpdateSettings={handleUpdateSettings}
            onOpenCalibration={() => setIsCalibrationOpen(true)}
          />
        )}

        {activeTab === 'constellation' && (
          <ConstellationTask gaze={gaze} />
        )}

        {activeTab === 'maze' && (
          <GazeMazeTask gaze={gaze} />
        )}

        {activeTab === 'target_pop' && (
          <TargetPopTask gaze={gaze} />
        )}

        {activeTab === 'quick_type' && (
          <GazeTypingTask gaze={gaze} />
        )}

        {activeTab === 'reading_analysis' && (
          <ReadingAnalysisTask gaze={gaze} />
        )}
      </main>

      {/* Floating Gaze Reticle & Trail Particles */}
      {settings.showGazeReticle && (
        <GazeCursor
          gaze={gaze}
          color={settings.strokeColor}
          glowColor={settings.strokeGlowColor}
          showTrail={settings.showGazeTrail}
        />
      )}

      {/* Picture-In-Picture Camera Feed */}
      {settings.showWebcamPiP && (
        <CameraFeed
          videoElement={videoElement}
          landmarks={landmarks}
          gaze={gaze}
          showMeshOverlay={showMeshOverlay}
          onToggleMesh={() => setShowMeshOverlay(!showMeshOverlay)}
        />
      )}

      {/* Center Calibration & Activation Gate */}
      <CenterCalibrationGate
        isOpen={isCenterGateOpen && (trackerStatus === 'running' || mouseSimMode)}
        gaze={gaze}
        onActivated={() => setIsCenterGateOpen(false)}
        onOpenFullCalibration={() => {
          setIsCenterGateOpen(false);
          setIsCalibrationOpen(true);
        }}
      />

      {/* 9-Point & Freeform Manual Click Calibration Modal */}
      <CalibrationModal
        isOpen={isCalibrationOpen}
        gaze={gaze}
        settings={settings}
        onUpdateSettings={handleUpdateSettings}
        onClose={() => setIsCalibrationOpen(false)}
        onCompleted={() => setIsCalibrationOpen(false)}
      />

      {/* Settings Modal */}
      <SettingsModal
        isOpen={isSettingsOpen}
        settings={settings}
        onClose={() => setIsSettingsOpen(false)}
        onUpdateSettings={handleUpdateSettings}
        onRecalibrate={() => setIsCalibrationOpen(true)}
      />

      {/* Sophisticated Dark Bottom Technical Telemetry Footer */}
      <footer className="px-6 py-2 flex justify-between items-center text-[10px] text-white/25 tracking-widest uppercase font-mono font-medium border-t border-white/5 bg-[#050505] shrink-0 z-20">
        <span>© 2024 Neural Optics Interface</span>
        <div className="flex gap-6">
          <span className="text-white/40">SENSOR: {trackerStatus === 'running' ? 'Webcam 1080p Optical Feed' : 'Offline'}</span>
          <span>CALIBRATION: {calibrationEngine.isCalibrated() ? 'Dual-Axis Matrix Active' : 'Default Matrix'}</span>
        </div>
      </footer>
    </div>
  );
}
