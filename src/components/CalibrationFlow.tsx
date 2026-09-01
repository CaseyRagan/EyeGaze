import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, ChevronLeft, RefreshCw, Target as TargetIcon, X } from 'lucide-react';
import {
  CalibrationSample,
  GazeState,
  TrackingSettings,
  ValidationPointResult,
  ValidationResult,
} from '../types';
import {
  CalibrationEngine,
  CalibrationPointSpec,
  DEFAULT_CALIBRATION_TARGETS,
  PRECISION_CALIBRATION_TARGETS,
  QUICK_CALIBRATION_TARGETS,
  VALIDATION_TARGETS,
  calibrationEngine,
} from '../services/calibration';
import { FaceMeshTracker } from '../services/faceMeshTracker';
import { soundEngine } from '../services/audio';
import { viewingGeometry } from '../services/viewingGeometry';
import { PostureGuide } from './PostureGuide';
import { gazeBus } from '../services/gazeBus';

type Stage = 'position' | 'capture' | 'head_pass' | 'validate' | 'result';
type Phase = 'settle' | 'collect';
export type CalibrationDepth = 'quick' | 'standard' | 'precision';

interface CalibrationFlowProps {
  isOpen: boolean;
  tracker: FaceMeshTracker | null;
  settings: TrackingSettings;
  onClose: () => void;
  onFinished: () => void;
}

/** Time for the eye to land on a newly shown dot before we believe anything. */
const SETTLE_MS = 650;
/** Time spent collecting samples once the eye has landed. */
const COLLECT_MS = 900;
/** Validation dwells are longer, because precision needs more samples. */
const VALIDATE_COLLECT_MS = 1100;
/** Length of the head-movement pass. Long enough to cover a full sweep twice. */
const HEAD_PASS_SETTLE_MS = 900;
const HEAD_PASS_COLLECT_MS = 6000;

const DEPTH_TARGETS: Record<CalibrationDepth, CalibrationPointSpec[]> = {
  quick: QUICK_CALIBRATION_TARGETS,
  standard: DEFAULT_CALIBRATION_TARGETS,
  precision: PRECISION_CALIBRATION_TARGETS,
};

const DEPTH_COPY: Record<CalibrationDepth, { title: string; detail: string }> = {
  quick: { title: '5 points', detail: 'About 15 seconds. Roughly 2–3° — fine for the games, not for measuring.' },
  standard: { title: '9 points', detail: 'About 25 seconds. The usual choice for a session.' },
  precision: { title: '13 points', detail: 'About 35 seconds. Use this before a reading assessment.' },
};

/**
 * Guided calibration and validation.
 *
 * Two things here matter more than the visual design. First, every point is
 * captured from a full dwell of samples with outliers rejected, rather than
 * from whatever the eye happened to be doing in the single frame a mouse click
 * landed on. Second, the check that follows measures error at points the model
 * was never fitted on, and reports it in degrees of visual angle — so the
 * number means something, and it cannot flatter itself.
 */
export const CalibrationFlow: React.FC<CalibrationFlowProps> = ({
  isOpen,
  tracker,
  settings,
  onClose,
  onFinished,
}) => {
  const [stage, setStage] = useState<Stage>('position');
  const [depth, setDepth] = useState<CalibrationDepth>('standard');
  const [targetIndex, setTargetIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>('settle');
  const [progress, setProgress] = useState(0);
  const [capturedCount, setCapturedCount] = useState(0);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [failedPoints, setFailedPoints] = useState<number[]>([]);
  const [wantHeadPass, setWantHeadPass] = useState(true);
  const [prunedPoints, setPrunedPoints] = useState<string[]>([]);
  const [headPassOutcome, setHeadPassOutcome] = useState<'pending' | 'measured' | 'skipped' | 'failed'>('pending');

  const samplesRef = useRef<CalibrationSample[]>([]);
  const gazePointsRef = useRef<Array<{ x: number; y: number }>>([]);
  const framesSeenRef = useRef(0);
  const framesUsedRef = useRef(0);
  const validationResultsRef = useRef<ValidationPointResult[]>([]);
  const phaseStartRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  const targets = stage === 'validate' ? VALIDATION_TARGETS : DEPTH_TARGETS[depth];
  const currentTarget = targets[targetIndex];

  // The newest sample is kept in a ref rather than in state: this screen runs a
  // frame-accurate timing loop, and re-rendering it on every sample would fight
  // with that for no benefit.
  const liveGazeRef = useRef<GazeState | null>(null);
  useEffect(() => gazeBus.subscribe(g => {
    liveGazeRef.current = g;
  }), []);

  // ---------------------------------------------------------------- capture
  const beginPoint = useCallback((index: number) => {
    setTargetIndex(index);
    setPhase('settle');
    setProgress(0);
    samplesRef.current = [];
    gazePointsRef.current = [];
    phaseStartRef.current = performance.now();
    soundEngine.playChime(560, 0.1);
  }, []);

  const startValidationPhase = useCallback(() => {
    validationResultsRef.current = [];
    framesSeenRef.current = 0;
    framesUsedRef.current = 0;
    setStage('validate');
    beginPoint(0);
  }, [beginPoint]);

  const finishCapturePoint = useCallback(
    (spec: CalibrationPointSpec) => {
      const anchor = calibrationEngine.addAnchorFromSamples(
        `grid-${spec.id}`,
        spec.xPercent / 100,
        spec.yPercent / 100,
        samplesRef.current,
        spec.label
      );

      if (anchor) {
        setCapturedCount(c => c + 1);
        soundEngine.playCalibrationTargetHit();
      } else {
        setFailedPoints(prev => (prev.includes(spec.id) ? prev : [...prev, spec.id]));
      }
    },
    []
  );

  const finishValidatePoint = useCallback((spec: CalibrationPointSpec) => {
    const points = gazePointsRef.current;
    const scrW = window.innerWidth;
    const scrH = window.innerHeight;
    const targetX = (spec.xPercent / 100) * scrW;
    const targetY = (spec.yPercent / 100) * scrH;

    if (points.length < 5) {
      validationResultsRef.current.push({
        id: String(spec.id),
        xNorm: spec.xPercent / 100,
        yNorm: spec.yPercent / 100,
        errorPx: NaN,
        errorDeg: NaN,
        offsetX: 0,
        offsetY: 0,
        precisionPx: NaN,
        precisionDeg: NaN,
        sampleCount: points.length,
      });
      return;
    }

    const meanX = points.reduce((s, p) => s + p.x, 0) / points.length;
    const meanY = points.reduce((s, p) => s + p.y, 0) / points.length;

    // Accuracy: how far the average estimate sits from the true target.
    const errorPx = Math.hypot(meanX - targetX, meanY - targetY);

    // Precision: root-mean-square distance between successive samples, which is
    // the figure eye-tracker specifications normally quote.
    let sumSq = 0;
    for (let i = 1; i < points.length; i++) {
      const dx = points[i].x - points[i - 1].x;
      const dy = points[i].y - points[i - 1].y;
      sumSq += dx * dx + dy * dy;
    }
    const precisionPx = Math.sqrt(sumSq / Math.max(1, points.length - 1));

    validationResultsRef.current.push({
      id: String(spec.id),
      xNorm: spec.xPercent / 100,
      yNorm: spec.yPercent / 100,
      errorPx,
      errorDeg: viewingGeometry.pixelsToDegrees(errorPx),
      offsetX: meanX - targetX,
      offsetY: meanY - targetY,
      precisionPx,
      precisionDeg: viewingGeometry.pixelsToDegrees(precisionPx),
      sampleCount: points.length,
    });

    soundEngine.playChime(640, 0.12);
  }, []);

  const completeValidation = useCallback(() => {
    const points = validationResultsRef.current.filter(p => Number.isFinite(p.errorPx));

    const accuracyPx = points.length > 0 ? points.reduce((s, p) => s + p.errorPx, 0) / points.length : NaN;
    const precisionPx = points.length > 0 ? points.reduce((s, p) => s + p.precisionPx, 0) / points.length : NaN;
    const trackingRatio = framesSeenRef.current > 0 ? framesUsedRef.current / framesSeenRef.current : 0;

    const accuracyDeg = viewingGeometry.pixelsToDegrees(accuracyPx);

    const result: ValidationResult = {
      points: validationResultsRef.current,
      accuracyPx,
      accuracyDeg,
      precisionPx,
      precisionDeg: viewingGeometry.pixelsToDegrees(precisionPx),
      trackingRatio,
      distanceCm: viewingGeometry.getEffectiveDistanceCm(),
      distanceWasMeasured: viewingGeometry.isDistanceMeasured(),
      timestamp: Date.now(),
      grade: CalibrationEngine.gradeAccuracy(accuracyDeg),
    };

    calibrationEngine.recordValidation(result);
    setValidation(result);
    setStage('result');
    soundEngine.playLevelComplete();
  }, []);

  // Sample sink: fed by the tracker on every usable frame.
  useEffect(() => {
    if (!isOpen || !tracker) return;
    if (stage !== 'capture' && stage !== 'validate' && stage !== 'head_pass') {
      tracker.collectSamples(null);
      return;
    }

    tracker.collectSamples((sample: CalibrationSample, gaze: GazeState, usable: boolean) => {
      if (phase !== 'collect') return;
      framesSeenRef.current++;
      if (!usable) return;
      framesUsedRef.current++;
      samplesRef.current.push(sample);
      gazePointsRef.current.push({ x: gaze.screenX, y: gaze.screenY });
    });

    return () => tracker.collectSamples(null);
  }, [isOpen, tracker, stage, phase]);

  // Timing loop for the head-movement pass.
  useEffect(() => {
    if (!isOpen || stage !== 'head_pass') return;

    let frame = 0;
    const tick = () => {
      const elapsed = performance.now() - phaseStartRef.current;

      if (elapsed < HEAD_PASS_SETTLE_MS) {
        setProgress(elapsed / HEAD_PASS_SETTLE_MS);
        if (phase !== 'settle') setPhase('settle');
      } else if (elapsed < HEAD_PASS_SETTLE_MS + HEAD_PASS_COLLECT_MS) {
        if (phase !== 'collect') setPhase('collect');
        setProgress((elapsed - HEAD_PASS_SETTLE_MS) / HEAD_PASS_COLLECT_MS);
      } else {
        const gain = calibrationEngine.fitHeadGainFromMotionPass(samplesRef.current);
        setHeadPassOutcome(gain ? 'measured' : 'failed');
        soundEngine.playChime(gain ? 640 : 380, 0.15);
        startValidationPhase();
        return;
      }

      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [isOpen, stage, phase, startValidationPhase]);

  // Timing loop for the settle/collect cycle.
  useEffect(() => {
    if (!isOpen || (stage !== 'capture' && stage !== 'validate') || !currentTarget) return;

    const collectDuration = stage === 'validate' ? VALIDATE_COLLECT_MS : COLLECT_MS;

    const tick = () => {
      const elapsed = performance.now() - phaseStartRef.current;

      if (phase === 'settle') {
        setProgress(Math.min(1, elapsed / SETTLE_MS));
        if (elapsed >= SETTLE_MS) {
          setPhase('collect');
          setProgress(0);
          phaseStartRef.current = performance.now();
        }
      } else {
        setProgress(Math.min(1, elapsed / collectDuration));
        if (elapsed >= collectDuration) {
          if (stage === 'capture') finishCapturePoint(currentTarget);
          else finishValidatePoint(currentTarget);

          const next = targetIndex + 1;
          if (next < targets.length) {
            beginPoint(next);
          } else if (stage === 'capture') {
            // Drop any point the rest of the grid clearly disagrees with,
            // before it gets a chance to distort the head-movement fit and the
            // accuracy check downstream of it.
            setPrunedPoints(calibrationEngine.pruneOutlierAnchors().removed);

            // The posture held during calibration is what the mapping is tied
            // to, so it becomes the reference for later drift warnings.
            const posture = liveGazeRef.current?.headPose;
            if (posture) calibrationEngine.recordPosture(posture);
            validationResultsRef.current = [];
            framesSeenRef.current = 0;
            framesUsedRef.current = 0;
            setStage('validate');
            beginPoint(0);
          } else {
            completeValidation();
          }
          return;
        }
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [
    isOpen,
    stage,
    phase,
    targetIndex,
    currentTarget,
    targets.length,
    beginPoint,
    finishCapturePoint,
    finishValidatePoint,
    completeValidation,
    tracker,
  ]);

  const startCapture = () => {
    calibrationEngine.reset();
    setCapturedCount(0);
    setFailedPoints([]);
    setValidation(null);
    setHeadPassOutcome('pending');
    setPrunedPoints([]);
    validationResultsRef.current = [];
    framesSeenRef.current = 0;
    framesUsedRef.current = 0;
    setStage('capture');
    beginPoint(0);
  };

  const startValidationOnly = () => startValidationPhase();

  useEffect(() => {
    if (!isOpen) {
      setStage('position');
      setTargetIndex(0);
      setPhase('settle');
      setProgress(0);
      setValidation(calibrationEngine.getValidation() ?? null);
    }
  }, [isOpen]);

  // Escape always gets you out; some clients find a modal they cannot leave
  // genuinely distressing.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-[var(--surface)] flex flex-col">
      <header className="flex items-center justify-between px-6 py-4 border-b border-soft shrink-0">
        <div className="flex items-center gap-3">
          <span className="w-8 h-8 rounded-xl bg-sage-100 text-sage-600 flex items-center justify-center">
            <TargetIcon className="w-4 h-4" />
          </span>
          <div>
            <h2 className="text-base font-semibold text-ink">Set up eye tracking</h2>
            <p className="text-xs text-ink-soft">
              {stage === 'position' && 'First — get comfortable'}
              {stage === 'capture' && `Teaching the tracker (${capturedCount}/${targets.length})`}
              {stage === 'head_pass' && 'Allowing for head movement'}
              {stage === 'validate' && `Checking accuracy (${targetIndex + 1}/${targets.length})`}
              {stage === 'result' && 'Done — here is how it went'}
            </p>
          </div>
        </div>
        <button
          onClick={onClose}
          className="p-2 rounded-xl text-ink-faint hover:text-ink hover:bg-[var(--surface-sunken)] transition-colors"
          aria-label="Close set-up"
        >
          <X className="w-5 h-5" />
        </button>
      </header>

      {stage === 'position' && (
        <PositionStage
          depth={depth}
          onDepthChange={setDepth}
          wantHeadPass={wantHeadPass}
          onWantHeadPassChange={setWantHeadPass}
          onStart={startCapture}
        />
      )}

      {(stage === 'capture' || stage === 'validate') && currentTarget && (
        <CaptureStage
          spec={currentTarget}
          phase={phase}
          progress={progress}
          isValidation={stage === 'validate'}
          index={targetIndex}
          total={targets.length}
        />
      )}

      {stage === 'head_pass' && <HeadPassStage phase={phase} progress={progress} />}

      {stage === 'result' && (
        <ResultStage
          prunedCount={prunedPoints.length}
          headPassOutcome={headPassOutcome}
          validation={validation}
          failedPoints={failedPoints}
          onRedo={() => setStage('position')}
          onRecheck={startValidationOnly}
          onAccept={() => {
            onFinished();
            onClose();
          }}
        />
      )}
    </div>
  );
};

// --------------------------------------------------------------------------

const PositionStage: React.FC<{
  depth: CalibrationDepth;
  onDepthChange: (d: CalibrationDepth) => void;
  wantHeadPass: boolean;
  onWantHeadPassChange: (v: boolean) => void;
  onStart: () => void;
}> = ({ depth, onDepthChange, wantHeadPass, onWantHeadPassChange, onStart }) => (
  <div className="flex-1 overflow-auto">
    <div className="max-w-4xl mx-auto px-6 py-8 grid md:grid-cols-2 gap-8">
      <div className="space-y-5">
        <div>
          <h3 className="text-2xl font-semibold text-ink">Get comfortable first</h3>
          <p className="text-sm text-ink-soft mt-2 leading-relaxed">
            Accuracy depends far more on sitting still than on anything in the software. Take a
            moment over this and everything afterwards works better.
          </p>
        </div>

        <ol className="space-y-3">
          {[
            'Sit so the screen fills a comfortable part of your view, roughly an arm’s length away.',
            'Set the screen angle now and leave it there. On a laptop, tilting the lid afterwards moves the camera and undoes the calibration.',
            'Light your face from the front. A window or lamp behind you leaves the eyes in shadow.',
            'If you have a chin or forehead rest, use it. It removes the single largest source of drift.',
          ].map((tip, i) => (
            <li key={i} className="flex gap-3 text-sm text-ink-soft leading-relaxed">
              <span className="shrink-0 w-6 h-6 rounded-full bg-sage-100 text-sage-700 text-xs font-semibold flex items-center justify-center">
                {i + 1}
              </span>
              <span>{tip}</span>
            </li>
          ))}
        </ol>

        <div>
          <p className="text-sm font-medium text-ink mb-2">How thorough should this be?</p>
          <div className="grid gap-2">
            {(Object.keys(DEPTH_COPY) as CalibrationDepth[]).map(key => (
              <button
                key={key}
                onClick={() => onDepthChange(key)}
                className={`text-left px-4 py-3 rounded-xl border transition-colors ${
                  depth === key
                    ? 'border-sage-400 bg-sage-50'
                    : 'border-soft bg-[var(--surface-raised)] hover:border-strong'
                }`}
              >
                <span className="text-sm font-medium text-ink">{DEPTH_COPY[key].title}</span>
                <span className="block text-xs text-ink-soft mt-0.5">{DEPTH_COPY[key].detail}</span>
              </button>
            ))}
          </div>
        </div>

        <label className="flex items-start gap-3 cursor-pointer rounded-xl border border-soft px-4 py-3">
          <input
            type="checkbox"
            checked={wantHeadPass}
            onChange={e => onWantHeadPassChange(e.target.checked)}
            className="mt-1 accent-[var(--color-sage-500)]"
          />
          <span className="text-sm">
            <span className="text-ink font-medium block">Allow for head movement (6 seconds)</span>
            <span className="text-ink-soft leading-relaxed">
              One extra step where you keep looking at a dot while moving your head a little. It
              measures how your eyes respond to head movement, which keeps tracking accurate when you
              shift in the seat later. Well worth it without a head rest.
            </span>
          </span>
        </label>

        <button
          onClick={onStart}
          className="w-full py-3.5 rounded-xl bg-sage-500 hover:bg-sage-600 text-white font-medium flex items-center justify-center gap-2 transition-colors"
        >
          <span>I’m ready</span>
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>

      <div className="space-y-4">
        <PostureGuide />
        <div className="surface rounded-2xl p-5">
          <h4 className="text-sm font-semibold text-ink mb-2">What happens next</h4>
          <p className="text-sm text-ink-soft leading-relaxed">
            A dot will appear in different places. Look at the middle of each one and hold still —
            it fills in on its own, so there is nothing to click. Afterwards a few more dots appear
            to check the result, and you get an accuracy figure you can trust.
          </p>
        </div>
      </div>
    </div>
  </div>
);

// --------------------------------------------------------------------------

const CaptureStage: React.FC<{
  spec: CalibrationPointSpec;
  phase: Phase;
  progress: number;
  isValidation: boolean;
  index: number;
  total: number;
}> = ({ spec, phase, progress, isValidation, index, total }) => {
  const collecting = phase === 'collect';
  const ringRadius = 30;
  const circumference = 2 * Math.PI * ringRadius;

  return (
    <div className="flex-1 relative">
      <p className="absolute top-8 left-1/2 -translate-x-1/2 text-sm text-ink-soft text-center max-w-sm">
        {isValidation ? 'Nearly there — look at each dot and hold still.' : 'Look at the middle of the dot and hold still.'}
      </p>

      {/*
        Positioned against the viewport, not this container.

        Anchors are stored as a fraction of the viewport, and the mapping is
        applied against window.innerHeight. Laying the dots out inside a flex
        child that sits below the header meant the client was looking at one
        place while the model was told they were looking at another — a
        vertical offset of the header's height at the top of the screen,
        tapering to nothing at the bottom, baked into every calibration.
      */}
      <div
        className="fixed -translate-x-1/2 -translate-y-1/2"
        style={{ left: `${spec.xPercent}%`, top: `${spec.yPercent}%` }}
      >
        <svg width={80} height={80} className="overflow-visible">
          <circle cx={40} cy={40} r={ringRadius} fill="none" stroke="var(--border-strong)" strokeWidth={3} />
          <circle
            cx={40}
            cy={40}
            r={ringRadius}
            fill="none"
            stroke={collecting ? 'var(--color-sage-500)' : 'var(--color-clay-300)'}
            strokeWidth={3}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - progress)}
            transform="rotate(-90 40 40)"
          />
          {/* The inner dot shrinks as the eye settles, which pulls fixation to
              a smaller and smaller area and tightens the capture. */}
          <circle
            cx={40}
            cy={40}
            r={collecting ? 4 : 4 + (1 - progress) * 7}
            fill={collecting ? 'var(--color-sage-500)' : 'var(--color-ink-soft)'}
          />
        </svg>
      </div>

      <div className="absolute bottom-8 left-1/2 -translate-x-1/2 flex items-center gap-2">
        {Array.from({ length: total }).map((_, i) => (
          <span
            key={i}
            className={`h-1.5 rounded-full transition-all ${
              i < index ? 'w-6 bg-sage-400' : i === index ? 'w-6 bg-sage-500' : 'w-1.5 bg-[var(--border-strong)]'
            }`}
          />
        ))}
      </div>
    </div>
  );
};

// --------------------------------------------------------------------------

/**
 * The head-movement pass.
 *
 * The ordinary grid sees each screen position at exactly one head pose, so the
 * effect of moving the head is indistinguishable from the effect of looking
 * somewhere else. Holding the target still while the head moves separates them,
 * and six seconds of it is enough to measure how far this particular person's
 * eyes counter-rotate — which is what lets the tracker stay accurate when they
 * shift in the chair later.
 */
const HeadPassStage: React.FC<{ phase: Phase; progress: number }> = ({ phase, progress }) => {
  const collecting = phase === 'collect';
  const radius = 34;
  const circumference = 2 * Math.PI * radius;

  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-8 px-6">
      <div className="text-center max-w-md space-y-2">
        <h3 className="text-xl font-semibold text-ink">Keep looking at the dot</h3>
        <p className="text-sm text-ink-soft leading-relaxed">
          {collecting
            ? 'Now slowly turn your head a little to each side, then nod gently up and down. Keep your eyes on the dot the whole time.'
            : 'Settle your gaze on the dot. In a moment you will be asked to move your head.'}
        </p>
      </div>

      <svg width={90} height={90} className="overflow-visible">
        <circle cx={45} cy={45} r={radius} fill="none" stroke="var(--border-strong)" strokeWidth={3} />
        <circle
          cx={45}
          cy={45}
          r={radius}
          fill="none"
          stroke={collecting ? 'var(--color-sage-500)' : 'var(--color-clay-300)'}
          strokeWidth={3}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - progress)}
          transform="rotate(-90 45 45)"
        />
        <circle cx={45} cy={45} r={5} fill="var(--color-sage-500)" />
      </svg>

      {collecting && (
        <p className="text-sm text-ink-faint">
          {progress < 0.5 ? 'Turn side to side…' : 'Now nod gently…'}
        </p>
      )}
    </div>
  );
};

// --------------------------------------------------------------------------

const GRADE_COPY: Record<ValidationResult['grade'], { label: string; tone: string; advice: string }> = {
  excellent: {
    label: 'Excellent',
    tone: 'text-sage-700 bg-sage-50 border-sage-200',
    advice: 'This is as good as a webcam realistically gets. Everything in the app will feel accurate.',
  },
  good: {
    label: 'Good',
    tone: 'text-sage-700 bg-sage-50 border-sage-200',
    advice: 'Comfortably usable for games, communication and reading assessment.',
  },
  fair: {
    label: 'Workable',
    tone: 'text-honey-700 bg-honey-100 border-honey-300',
    advice:
      'Fine for large targets and games. For reading assessment, try again with better lighting or a steadier head position.',
  },
  poor: {
    label: 'Needs another go',
    tone: 'text-clay-500 bg-clay-100 border-clay-300',
    advice:
      'Something is working against the tracker. The usual causes are light behind the head, glasses reflecting the screen, sitting off to one side of the camera, or moving between the set-up and the check.',
  },
};

const ResultStage: React.FC<{
  validation: ValidationResult | null;
  failedPoints: number[];
  prunedCount: number;
  headPassOutcome: 'pending' | 'measured' | 'skipped' | 'failed';
  onRedo: () => void;
  onRecheck: () => void;
  onAccept: () => void;
}> = ({ validation, failedPoints, prunedCount, headPassOutcome, onRedo, onRecheck, onAccept }) => {
  if (!validation || !Number.isFinite(validation.accuracyDeg)) {
    return (
      <div className="flex-1 flex items-center justify-center px-6">
        <div className="max-w-md text-center space-y-4">
          <h3 className="text-xl font-semibold text-ink">The check didn’t collect enough data</h3>
          <p className="text-sm text-ink-soft leading-relaxed">
            The tracker lost the eyes for most of the check. That usually means the face was out of
            frame, or the light was too low for the camera.
          </p>
          <button onClick={onRedo} className="px-5 py-3 rounded-xl bg-sage-500 text-white font-medium">
            Start again
          </button>
        </div>
      </div>
    );
  }

  const grade = GRADE_COPY[validation.grade];
  const quality = calibrationEngine.getModel().quality;

  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-3xl mx-auto px-6 py-8 space-y-6">
        <div className={`rounded-2xl border px-6 py-5 ${grade.tone}`}>
          <div className="flex items-baseline gap-3 flex-wrap">
            <span className="text-3xl font-semibold">{validation.accuracyDeg.toFixed(1)}°</span>
            <span className="text-base font-medium">{grade.label}</span>
            <span className="text-sm opacity-80">
              about {Math.round(validation.accuracyPx)} px on this screen
            </span>
          </div>
          <p className="text-sm mt-2 leading-relaxed opacity-90">{grade.advice}</p>
        </div>

        <div className="grid sm:grid-cols-3 gap-4">
          <Metric
            label="Accuracy"
            value={`${validation.accuracyDeg.toFixed(1)}°`}
            note="How far the estimate sits from where you actually looked"
          />
          <Metric
            label="Steadiness"
            value={`${validation.precisionDeg.toFixed(2)}°`}
            note="How much the estimate wobbles while you hold still"
          />
          <Metric
            label="Eyes found"
            value={`${Math.round(validation.trackingRatio * 100)}%`}
            note="Share of the check where the eyes were tracked"
          />
        </div>

        <div className="surface rounded-2xl p-5">
          <h4 className="text-sm font-semibold text-ink mb-3">Where the error sits</h4>
          <div className="relative w-full rounded-xl surface-quiet" style={{ aspectRatio: '16 / 10' }}>
            {validation.points.map(p =>
              Number.isFinite(p.errorDeg) ? (
                <div
                  key={p.id}
                  className="absolute -translate-x-1/2 -translate-y-1/2 flex flex-col items-center"
                  style={{ left: `${p.xNorm * 100}%`, top: `${p.yNorm * 100}%` }}
                >
                  <span
                    className={`w-3 h-3 rounded-full ${
                      p.errorDeg <= 1 ? 'bg-sage-500' : p.errorDeg <= 2 ? 'bg-honey-500' : 'bg-clay-400'
                    }`}
                  />
                  <span className="text-[11px] text-ink-soft mt-1">{p.errorDeg.toFixed(1)}°</span>
                </div>
              ) : null
            )}
          </div>
          <p className="text-xs text-ink-faint mt-3 leading-relaxed">
            Measured at five points the tracker was not taught, so this is a fair test rather than a
            self-assessment.
            {/* Leave-one-out error is only informative once there are more
                points than the model has parameters; with five it mostly
                measures extrapolation and looks alarming for no reason. */}
            {quality && quality.anchorCount >= 9 && quality.crossValidatedErrorDeg > 0 && (
              <> Leaving each set-up point out in turn, the rest predicted it to within{' '}
              {quality.crossValidatedErrorDeg.toFixed(1)}°.</>
            )}
          </p>
        </div>

        {headPassOutcome !== 'pending' && (
          <div className="surface rounded-2xl px-5 py-4">
            <h4 className="text-sm font-semibold text-ink mb-1">Head movement</h4>
            <p className="text-sm text-ink-soft leading-relaxed">
              {headPassOutcome === 'measured' &&
                'Measured. Tracking should hold up when you shift in the seat, though re-centring after a big move is still worth doing.'}
              {headPassOutcome === 'skipped' &&
                'Not measured. Tracking will drift if you move much from where you are sitting now — a chin or forehead rest, or running this step, both help.'}
              {headPassOutcome === 'failed' &&
                'There was not enough head movement to measure anything, so a standard allowance is being used. You can run set-up again and move your head a little more during that step.'}
            </p>
          </div>
        )}

        {validation.distanceCm !== null && (validation.distanceCm < 32 || validation.distanceCm > 95) && (
          <div className="rounded-2xl border border-honey-300 bg-honey-100 px-4 py-3">
            <p className="text-sm text-honey-700 leading-relaxed">
              The viewing distance came out at {validation.distanceCm.toFixed(0)} cm, which is unlikely
              to be right. Degrees are computed directly from it, so the figures above are probably
              scaled wrong — the tracking may well be better than they suggest. Correct the distance in
              settings and run the check again.
            </p>
          </div>
        )}

        <p className="text-xs text-ink-faint leading-relaxed">
          Degrees are worked out from your screen size and a viewing distance of{' '}
          {validation.distanceCm ? `${validation.distanceCm.toFixed(0)} cm` : 'unknown'}
          {validation.distanceWasMeasured ? ', measured from the camera' : ', taken from your settings'}. If the
          screen size in settings is wrong, the degree figures will be wrong with it.
          {failedPoints.length > 0 && ` ${failedPoints.length} set-up point(s) could not be captured and were skipped.`}
          {prunedCount > 0 &&
            ` ${prunedCount} set-up point(s) disagreed with the rest of the grid and were dropped — usually a blink or a glance away at the wrong moment.`}
        </p>

        <div className="flex flex-wrap gap-3">
          <button
            onClick={onAccept}
            className="px-5 py-3 rounded-xl bg-sage-500 hover:bg-sage-600 text-white font-medium flex items-center gap-2 transition-colors"
          >
            <Check className="w-4 h-4" />
            Use this
          </button>
          <button
            onClick={onRecheck}
            className="px-5 py-3 rounded-xl border border-strong text-ink font-medium flex items-center gap-2 hover:bg-[var(--surface-sunken)] transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
            Check again
          </button>
          <button
            onClick={onRedo}
            className="px-5 py-3 rounded-xl border border-strong text-ink font-medium flex items-center gap-2 hover:bg-[var(--surface-sunken)] transition-colors"
          >
            <ChevronLeft className="w-4 h-4" />
            Start over
          </button>
        </div>
      </div>
    </div>
  );
};

const Metric: React.FC<{ label: string; value: string; note: string }> = ({ label, value, note }) => (
  <div className="surface rounded-2xl p-4">
    <p className="text-xs text-ink-faint">{label}</p>
    <p className="text-2xl font-semibold text-ink mt-1">{value}</p>
    <p className="text-xs text-ink-soft mt-1.5 leading-relaxed">{note}</p>
  </div>
);
