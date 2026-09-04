import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  BookOpen,
  Camera,
  Compass,
  Crosshair,
  Menu,
  MessageSquare,
  MousePointer,
  PenLine,
  RefreshCw,
  Settings,
  Sparkles,
  Target,
} from 'lucide-react';
import { ActivityMode, TrackingSettings } from './types';
import {
  DEFAULT_TRACKING_SETTINGS,
  FaceMeshTracker,
  TrackerStatus,
  loadTrackingSettings,
  saveTrackingSettings,
} from './services/faceMeshTracker';
import { viewingGeometry } from './services/viewingGeometry';
import { soundEngine } from './services/audio';
import { setSpeechEnabled } from './services/speech';
import { GazePointer } from './components/GazePointer';
import { CameraPreview } from './components/CameraPreview';
import { CalibrationFlow } from './components/CalibrationFlow';
import { RecentreOverlay } from './components/RecentreOverlay';
import { driftGuard } from './services/driftGuard';
import { SettingsPanel } from './components/SettingsPanel';
import { DiagnosticsPanel } from './components/DiagnosticsPanel';
import { HeadAlignmentGuide } from './components/HeadAlignmentGuide';
import { SessionBar } from './components/SessionBar';
import { GazePaint } from './components/GazePaint';
import { ConstellationTask } from './components/Activities/ConstellationTask';
import { GazeMazeTask } from './components/Activities/GazeMazeTask';
import { TargetPopTask } from './components/Activities/TargetPopTask';
import { GazeTypingTask } from './components/Activities/GazeTypingTask';
import { ReadingAssessment } from './components/ReadingAssessment';
import { ActivityDefinition, HomeScreen } from './components/HomeScreen';

/** One place to change the product name. */
const APP_NAME = 'Lantern';

const ACTIVITIES: ActivityDefinition[] = [
  { id: 'target_pop', label: 'Find and hold', icon: Target, group: 'play', purpose: 'Locate a target and hold your gaze on it.' },
  { id: 'constellation', label: 'Join the dots', icon: Sparkles, group: 'play', purpose: 'Move accurately from one point to the next.' },
  { id: 'maze', label: 'Maze', icon: Compass, group: 'play', purpose: 'Follow a path smoothly without straying.' },
  { id: 'single_line', label: 'Draw', icon: PenLine, group: 'play', purpose: 'Free drawing with your eyes.' },
  { id: 'quick_type', label: 'Talk', icon: MessageSquare, group: 'play', purpose: 'Spell words by looking at letters.' },
  { id: 'reading_analysis', label: 'Reading', icon: BookOpen, group: 'assess', purpose: 'Measure reading eye movements against developmental norms.' },
];

export default function App() {
  // `null` means the home screen, where the camera is off. Everything about the
  // camera's lifecycle follows from this one piece of state.
  const [activeTab, setActiveTab] = useState<ActivityMode | null>(null);
  const [trackerStatus, setTrackerStatus] = useState<TrackerStatus>('uninitialized');
  const [trackerError, setTrackerError] = useState<string | null>(null);
  const [videoElement, setVideoElement] = useState<HTMLVideoElement | null>(null);
  const [showMesh, setShowMesh] = useState(true);
  const [isCalibrationOpen, setIsCalibrationOpen] = useState(false);
  const [isRecentreOpen, setIsRecentreOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isDiagnosticsOpen, setIsDiagnosticsOpen] = useState(false);
  /**
   * Drive the pointer with the mouse instead of the eyes.
   *
   * Normally reached from the "use the mouse" button after the camera fails.
   * The ?mouse=1 URL also switches it on up front, which is how the app gets
   * demonstrated on a machine with no webcam — a therapist showing a family
   * what the activities look like before setting anything up — and how the
   * calibration flow is driven end to end in a browser test, where the
   * expected error is exactly zero and any coordinate mistake is unmissable.
   */
  const [mouseMode, setMouseMode] = useState(
    () => new URLSearchParams(window.location.search).get('mouse') === '1'
  );
  const [theme, setTheme] = useState<'light' | 'dim'>('light');
  const [toast, setToast] = useState<string | null>(null);
  const [navOpen, setNavOpen] = useState(false);

  const trackerRef = useRef<FaceMeshTracker | null>(null);
  /** Guards against pausing the camera if the user dived straight into something. */
  const startedInsideActivityRef = useRef(false);
  // Landmarks go into a ref, not state: they arrive with every captured frame,
  // and putting them in state re-rendered the entire application at camera rate.
  const landmarksRef = useRef<any[] | null>(null);

  // Restored from storage rather than reset each visit: these are a clinician's
  // choices about a particular client — dwell time, filter response, whether
  // prompts are spoken — and having to set them again after every refresh made
  // them not worth setting.
  const [settings, setSettings] = useState<TrackingSettings>(loadTrackingSettings);
  // Read by the keyboard handler, which is registered once and must not close
  // over a stale copy of the settings.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme === 'dim' ? 'dim' : 'light');
  }, [theme]);

  useEffect(() => {
    setSpeechEnabled(settings.spokenPrompts);
  }, [settings.spokenPrompts]);

  useEffect(() => {
    driftGuard.setEnabled(settings.autoDriftCorrection);
  }, [settings.autoDriftCorrection]);

  useEffect(() => {
    const tracker = new FaceMeshTracker({
      onStatusChange: (status, errorMsg) => {
        setTrackerStatus(status);
        setTrackerError(errorMsg ?? null);
      },
      onVideoFrame: (video, frameLandmarks) => {
        landmarksRef.current = frameLandmarks ?? null;
        setVideoElement(prev => (prev === video ? prev : video));
      },
    });

    trackerRef.current = tracker;
    tracker.updateSettings(settings);
    if (new URLSearchParams(window.location.search).get('mouse') === '1') {
      tracker.setSimulatedPointer(true);
    }
    // The model is fetched up front so the first activity starts promptly, but
    // the camera is released again immediately: the app opens on home.
    tracker.initialize().then(() => {
      if (!startedInsideActivityRef.current) tracker.pause();
    });

    return () => tracker.dispose();
    // Deliberately runs once: the tracker owns the camera for the session and
    // receives setting changes through updateSettings rather than by restarting.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The camera is only open while it is being used: inside an activity, or
  // during set-up. Leaving it running on the home screen would put a live
  // camera light on someone who is not using the tool.
  const shouldTrack = activeTab !== null || isCalibrationOpen || isRecentreOpen;

  useEffect(() => {
    const tracker = trackerRef.current;
    if (!tracker || mouseMode) return;
    if (shouldTrack) {
      if (tracker.getStatus() === 'paused') void tracker.resume();
    } else if (tracker.getStatus() === 'running') {
      tracker.pause();
    }
  }, [shouldTrack, mouseMode, trackerStatus]);

  const handleResetSettings = useCallback(() => {
    const defaults = { ...DEFAULT_TRACKING_SETTINGS };
    setSettings(defaults);
    trackerRef.current?.updateSettings(defaults);
    saveTrackingSettings(defaults);
    setToast('Settings put back to their defaults');
  }, []);

  const handleUpdateSettings = useCallback((patch: Partial<TrackingSettings>) => {
    setSettings(prev => {
      const next = { ...prev, ...patch };
      trackerRef.current?.updateSettings(next);
      saveTrackingSettings(next);
      return next;
    });
  }, []);

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(null), 3200);
  }, []);

  // Keyboard shortcuts, chosen so a clinician can drive the session without
  // looking away from the client.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === 'c' || e.key === 'C') {
        e.preventDefault();
        setIsRecentreOpen(true);
      } else if (e.key === 'k' || e.key === 'K') {
        e.preventDefault();
        setIsCalibrationOpen(true);
      } else if (e.key === 'h' || e.key === 'H') {
        e.preventDefault();
        handleUpdateSettings({ showPostureGuide: !settingsRef.current.showPostureGuide });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleUpdateSettings]);

  const handlePointerMove = (e: React.PointerEvent) => {
    if (mouseMode) trackerRef.current?.simulateGazeFromPointer(e.clientX, e.clientY);
  };

  const activeDefinition = ACTIVITIES.find(a => a.id === activeTab);
  const atHome = activeTab === null;

  const openActivity = useCallback((id: ActivityMode) => {
    startedInsideActivityRef.current = true;
    setActiveTab(id);
    setNavOpen(false);
    soundEngine.playChime(480, 0.12);
  }, []);

  const goHome = useCallback(() => {
    startedInsideActivityRef.current = false;
    setActiveTab(null);
    setNavOpen(false);
  }, []);

  // The camera only has to be ready when something is actually using it.
  const isBusy = !atHome && trackerStatus !== 'running' && !mouseMode;

  // Activities are laid out inside this box rather than the whole window, so a
  // reduced working area shrinks every one of them at once instead of needing
  // each to understand the concept.
  const workingArea = viewingGeometry.getWorkingArea();
  const workingInset =
    workingArea.width < window.innerWidth
      ? {
          marginLeft: workingArea.left,
          marginRight: workingArea.left,
          marginBottom: workingArea.top * 2,
        }
      : undefined;

  return (
    <div
      onPointerMove={handlePointerMove}
      className="relative w-screen h-screen overflow-hidden flex flex-col bg-[var(--surface)] text-ink"
    >
      {/* The home screen carries its own heading and controls, so the activity
          chrome would only be duplicate furniture there. */}
      {!atHome && (
      <header className="relative z-30 flex items-center justify-between gap-4 px-5 py-3 border-b border-soft bg-[var(--surface-raised)] shrink-0">
        <div className="flex items-center gap-3 shrink-0">
          <button
            onClick={() => setNavOpen(v => !v)}
            className="lg:hidden p-2 rounded-xl text-ink-soft hover:bg-[var(--surface-sunken)]"
            aria-label="Show activities"
          >
            <Menu className="w-5 h-5" />
          </button>
          {/* Clicking the name goes home, which is where people reach first. */}
          <button
            onClick={goHome}
            className="text-left rounded-lg px-1 -mx-1 hover:bg-[var(--surface-sunken)] transition-colors"
            title="Back to the home screen"
          >
            <h1 className="text-base font-semibold text-ink leading-tight whitespace-nowrap">{APP_NAME}</h1>
            {/* Decorative, and the first thing worth dropping when the activity
                tabs need the room. */}
            <p className="hidden 2xl:block text-xs text-ink-faint truncate max-w-[240px]">
              {activeDefinition?.purpose ?? 'Home'}
            </p>
          </button>
        </div>

        <nav
          className={`${
            navOpen ? 'flex' : 'hidden'
          } lg:flex absolute lg:static top-full left-0 right-0 lg:top-auto flex-col lg:flex-row gap-1 p-2 lg:p-0 bg-[var(--surface-raised)] lg:bg-transparent border-b lg:border-0 border-soft lg:shrink-0`}
        >
          {ACTIVITIES.map(activity => {
            const Icon = activity.icon;
            const isActive = activeTab === activity.id;
            return (
              <button
                key={activity.id}
                onClick={() => openActivity(activity.id)}
                className={`flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium whitespace-nowrap shrink-0 transition-colors ${
                  isActive
                    ? 'bg-sage-100 text-sage-700'
                    : 'text-ink-soft hover:text-ink hover:bg-[var(--surface-sunken)]'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span>{activity.label}</span>
                {activity.group === 'assess' && (
                  <span className="hidden 2xl:inline text-[10px] px-1.5 py-0.5 rounded-full bg-sky-100 text-sky-700">
                    measure
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <div className="flex items-center gap-2 shrink-0">
          <SessionBar onOpenCalibration={() => setIsCalibrationOpen(true)} />

          <button
            onClick={() => setIsRecentreOpen(true)}
            title="Re-centre after moving (C)"
            className="px-3 py-2 rounded-xl text-sm font-medium text-ink-soft hover:text-ink hover:bg-[var(--surface-sunken)] transition-colors flex items-center gap-2 shrink-0"
          >
            <Crosshair className="w-4 h-4" />
            <span className="hidden 2xl:inline">Re-centre</span>
          </button>

          <button
            onClick={() => setIsCalibrationOpen(true)}
            className="px-4 py-2 rounded-xl bg-sage-500 hover:bg-sage-600 text-white text-sm font-medium transition-colors"
          >
            Set up
          </button>

          <button
            onClick={() => setIsSettingsOpen(true)}
            className="p-2 rounded-xl text-ink-soft hover:text-ink hover:bg-[var(--surface-sunken)] transition-colors"
            aria-label="Settings"
          >
            <Settings className="w-5 h-5" />
          </button>
        </div>
      </header>
      )}

      <main className="relative flex-1 overflow-hidden" style={atHome ? undefined : workingInset}>
        {atHome && (
          <HomeScreen
            appName={APP_NAME}
            activities={ACTIVITIES}
            onSelect={openActivity}
            onOpenCalibration={() => setIsCalibrationOpen(true)}
            onOpenSettings={() => setIsSettingsOpen(true)}
          />
        )}

        {activeTab === 'single_line' && (
          <GazePaint settings={settings} onUpdateSettings={handleUpdateSettings} />
        )}
        {activeTab === 'constellation' && <ConstellationTask />}
        {activeTab === 'maze' && <GazeMazeTask />}
        {activeTab === 'target_pop' && <TargetPopTask dwellDurationMs={settings.dwellDurationMs} />}
        {activeTab === 'quick_type' && <GazeTypingTask dwellDurationMs={settings.dwellDurationMs} />}
        {activeTab === 'reading_analysis' && <ReadingAssessment />}

        {isBusy && (
          <div className="absolute inset-0 z-40 bg-[var(--surface)]/95 backdrop-blur-sm flex items-center justify-center px-6">
            <div className="surface rounded-3xl p-8 max-w-md w-full text-center space-y-5">
              <span className="w-14 h-14 rounded-2xl bg-sage-100 text-sage-600 flex items-center justify-center mx-auto">
                <Camera className="w-6 h-6" />
              </span>
              <div>
                <h2 className="text-lg font-semibold text-ink">
                  {trackerStatus === 'loading_model' && 'Getting the eye tracker ready'}
                  {trackerStatus === 'requesting_camera' && 'Waiting for the camera'}
                  {trackerStatus === 'error' && 'The camera didn’t start'}
                  {trackerStatus === 'uninitialized' && 'Starting up'}
                </h2>
                <p className="text-sm text-ink-soft mt-2 leading-relaxed">
                  {trackerStatus === 'loading_model' && 'Downloading the face model. This happens once.'}
                  {trackerStatus === 'requesting_camera' && 'Please allow camera access when your browser asks.'}
                  {trackerStatus === 'error' && (trackerError || 'Something went wrong starting the camera.')}
                  {trackerStatus === 'uninitialized' && 'One moment.'}
                </p>
              </div>
              {trackerStatus === 'error' && (
                <div className="flex gap-3">
                  <button
                    onClick={() => trackerRef.current?.initialize()}
                    className="flex-1 py-3 rounded-xl bg-sage-500 hover:bg-sage-600 text-white font-medium flex items-center justify-center gap-2 transition-colors"
                  >
                    <RefreshCw className="w-4 h-4" />
                    Try again
                  </button>
                  <button
                    onClick={() => {
                      setMouseMode(true);
                      trackerRef.current?.setSimulatedPointer(true);
                    }}
                    className="flex-1 py-3 rounded-xl border border-strong text-ink font-medium flex items-center justify-center gap-2 transition-colors hover:bg-[var(--surface-sunken)]"
                  >
                    <MousePointer className="w-4 h-4" />
                    Use the mouse
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

      </main>

      {settings.showGazeReticle && !atHome && (
        <GazePointer
          color={settings.strokeColor}
          showTrail={settings.showGazeTrail}
          subdued={activeTab === 'reading_analysis'}
        />
      )}

      {settings.showWebcamPiP && videoElement && !atHome && (
        <CameraPreview
          videoElement={videoElement}
          landmarksRef={landmarksRef}
          showMesh={showMesh}
          onToggleMesh={() => setShowMesh(v => !v)}
        />
      )}

      {settings.showPostureGuide && !atHome && !isCalibrationOpen && !isRecentreOpen && (
        <HeadAlignmentGuide onRecentre={() => setIsRecentreOpen(true)} />
      )}

      <CalibrationFlow
        isOpen={isCalibrationOpen}
        tracker={trackerRef.current}
        settings={settings}
        onClose={() => {
          setIsCalibrationOpen(false);
          // A fresh set-up supersedes anything drift correction had accumulated
          // against the previous mapping.
          driftGuard.reset();
        }}
        onFinished={() => undefined}
      />

      <RecentreOverlay
        isOpen={isRecentreOpen}
        tracker={trackerRef.current}
        sensitivityX={settings.sensitivityX}
        sensitivityY={settings.sensitivityY}
        onClose={result => {
          setIsRecentreOpen(false);
          // A manual re-centre recomputes the whole offset, so whatever the
          // guard had accumulated toward the previous one no longer applies.
          driftGuard.reset();
          if (result) {
            showToast(
              result.moved < 8
                ? 'Already well centred — nothing much to correct.'
                : `Re-centred by ${Math.round(result.moved)} px.`
            );
          } else {
            showToast('Couldn’t re-centre from that. Run set-up again if it still feels off.');
          }
        }}
      />

      <SettingsPanel
        isOpen={isSettingsOpen}
        settings={settings}
        theme={theme}
        onThemeChange={setTheme}
        onClose={() => setIsSettingsOpen(false)}
        onUpdateSettings={handleUpdateSettings}
        onResetSettings={handleResetSettings}
        onRecalibrate={() => {
          setIsSettingsOpen(false);
          setIsCalibrationOpen(true);
        }}
        onOpenDiagnostics={() => {
          setIsSettingsOpen(false);
          setIsDiagnosticsOpen(true);
        }}
      />

      <DiagnosticsPanel
        isOpen={isDiagnosticsOpen}
        tracker={trackerRef.current}
        onClose={() => setIsDiagnosticsOpen(false)}
      />

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 surface rounded-full px-5 py-2.5 text-sm text-ink">
          {toast}
        </div>
      )}
    </div>
  );
}
