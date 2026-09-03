import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, ChevronLeft, Download, RefreshCw, Target as TargetIcon, X } from 'lucide-react';
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
import { HeadPositionCard } from './HeadPositionCard';
import { DistanceCheck } from './DistanceCheck';
import { ScreenSizeCard } from './ScreenSizeCard';
import { GazeRangeCheck } from './GazeRangeCheck';
import { gazeBus } from '../services/gazeBus';
import { cancelSpeech, speakPrompt } from '../services/speech';
import {
  RecordedPoint,
  SessionRecord,
  buildSessionRecord,
  downloadSessionRecord,
  estimateRecordSizeKb,
} from '../services/sessionRecord';
import {
  DIRECTION_PROMPT,
  EMPTY_COVERAGE,
  HeadCoverage,
  HeadCoverageRing,
  accumulateCoverage,
  coverageComplete,
  coverageFraction,
  nextDirection,
} from './HeadCoverageRing';

type Stage = 'position' | 'brief' | 'capture' | 'head_pass' | 'validate' | 'result';

/**
 * Which phase a briefing card is introducing.
 *
 * Instructions are given *before* each phase rather than during it. Asking
 * someone to read a sentence while also asking them to hold their gaze on a dot
 * is asking for two incompatible things at once, and the reading loses — a
 * tester only noticed the "move your head" instruction at the very end of the
 * pass it was instructing, because for the whole six seconds he was correctly
 * staring at the target. Anything that must be understood has to be understood
 * before the eyes are committed.
 */
type BriefFor = 'capture' | 'head_pass' | 'validate';

/** The same phases again, worded for the mode where the client confirms each point. */
type BriefingKey = BriefFor | 'capture_confirmed' | 'validate_confirmed';

interface Briefing {
  title: string;
  body: string;
  /** Read aloud when spoken prompts are on. Kept short enough to finish in time. */
  spoken: string;
  action: string;
}

const BRIEFINGS: Record<BriefingKey, Briefing> = {
  capture: {
    title: 'Look at each dot and hold still',
    body: 'Dots will appear one at a time. Look at the middle of each one and keep still — it fills in on its own, so there is nothing to press. If you look away it pauses and waits for you.',
    spoken: 'Look at each dot and hold still until it fills.',
    action: 'Start',
  },
  capture_confirmed: {
    title: 'Look at each dot, then press the space bar',
    body: 'Dots appear one at a time. Look right at the middle of one, hold still until the ring closes, then press the space bar — the tracker records the moment just before you press. Nothing is recorded until you say so, so take as long as you like on each one.',
    spoken: 'Look at the dot, hold still, then press the space bar.',
    action: 'Start',
  },
  validate_confirmed: {
    title: 'Last part — checking the result',
    body: 'A few more dots, the same as before: look, hold still, press space. These ones are not teaching the tracker anything; they are measuring how well it learned, so the accuracy figure at the end means something.',
    spoken: 'A few more dots to check the result. Same as before.',
    action: 'Start the check',
  },
  head_pass: {
    title: 'Now keep your eyes on the dot and move your head',
    body: 'A ring of four arcs will appear around the dot. Keep looking straight at the dot the whole time, and slowly turn your head left, then right, then tip your chin up and down — each arc fills as you reach far enough that way. When the ring is full, this part is done. Moving your head is the point; your eyes stay on the dot.',
    spoken: 'Keep your eyes on the dot, and move your head until the ring around it fills.',
    action: 'I understand',
  },
  validate: {
    title: 'Last part — checking the result',
    body: 'A few more dots, the same as before. These ones are not teaching the tracker anything; they are measuring how well it learned, so the accuracy figure at the end means something.',
    spoken: 'A few more dots to check the result.',
    action: 'Start the check',
  },
};
type Phase = 'settle' | 'collect';
export type CalibrationDepth = 'quick' | 'standard' | 'precision';

interface CalibrationFlowProps {
  isOpen: boolean;
  tracker: FaceMeshTracker | null;
  settings: TrackingSettings;
  onClose: () => void;
  onFinished: () => void;
}

/**
 * Capture is gated on the eye actually settling, not on a stopwatch.
 *
 * The old behaviour filled each ring on a timer whether or not anyone was
 * looking at it, so a point was recorded from whatever the eye happened to be
 * doing — mid-saccade, glancing at the therapist, halfway to the next dot. That
 * is not a subtle loss: a least-squares fit spreads one bad point across the
 * whole surface.
 *
 * The obvious fix, only accepting samples that land near the target, is not
 * available: before calibration there is no mapping, so there is no way to know
 * where someone is looking. But there is no need to know *where* — only that
 * the eye has stopped moving. Fixation is measurable without any mapping at
 * all, and a settled eye during a target's presentation is overwhelmingly
 * likely to be settled on that target.
 *
 * So the ring advances only while the eye is still, and visibly pauses when it
 * is not. The timeouts exist because a client who cannot hold a steady fixation
 * must still be able to finish.
 */
/** Minimum time on a dot before collection can begin, however quickly it settles. */
const MIN_SETTLE_MS = 350;
/** Give up waiting for a fixation and collect anyway after this long. */
const SETTLE_TIMEOUT_MS = 3000;
/** Settled samples wanted per calibration point. */
const TARGET_SETTLED_SAMPLES = 20;
/** Validation needs more, because precision is measured from their scatter. */
const TARGET_SETTLED_SAMPLES_VALIDATE = 28;
/** Stop collecting regardless once the window has been open this long. */
const COLLECT_TIMEOUT_MS = 3200;
/** Below this many settled samples, fall back to using everything collected. */
const MIN_SETTLED_SAMPLES = 8;
/** Two samples further apart than this did not arrive back to back. */
const CONSECUTIVE_SAMPLE_MS = 60;
/**
 * Confirmed capture: the client says when they are on the dot.
 *
 * Waiting for the eye to settle is a good proxy for "looking at the target",
 * but it is only a proxy, and it fails in exactly the way that matters: someone
 * holding a steady gaze on the therapist, on their own reflection, or on a dot
 * they have already left is perfectly settled. The dot then fills, and a point
 * that describes somewhere else entirely goes into the fit — where least
 * squares spreads it across the whole screen. Testers reported precisely this:
 * "the targets filled on their own regardless of where I was looking."
 *
 * A key press removes the proxy. Only the person looking knows whether they are
 * on the target, so they are the ones who say so.
 *
 * The samples are taken from *before* the press, not after it. Deciding to
 * press, and pressing, both take time in which the eye can begin to leave — and
 * the tail of the window is where anticipation of the next dot shows up. So the
 * window closes a little before the key goes down and reaches back from there,
 * covering the moment the client was actually reporting on rather than the
 * moment they reported it.
 */
const CONFIRM_LOOKBACK_MS = 900;
/** Discarded from the end of that window: the press itself and the run-up to it. */
const CONFIRM_EXCLUDE_MS = 130;
/** Fewest settled samples inside the window for a confirmation to be accepted. */
const CONFIRM_MIN_SAMPLES = 8;
/** Presses this soon after a dot appears are the previous screen's key repeating. */
const CONFIRM_ARM_MS = 300;
/**
 * How long to wait for the eye to visibly leave the last dot before banking
 * samples anyway.
 *
 * When a new dot appears the eye is still on the old one, and it is still
 * *settled* — so without this, a dot is "ready to confirm" the instant it
 * appears, from samples describing the previous target. An eager client
 * pressing straight away would record the last dot's position against this
 * dot's coordinates, which is worse than any noise the mode was built to
 * remove. So nothing is banked until a saccade says the eye has moved.
 *
 * The timeout is the escape hatch for a gaze that never crosses the saccade
 * threshold — poor tracking, or two dots close enough together that the
 * movement between them is small. Waiting forever would leave the client
 * pressing a key that does nothing.
 */
const ARRIVAL_GRACE_MS = 2000;

/**
 * The head-movement pass ends when the movement is done, not when a clock runs out.
 *
 * It used to run for a fixed six seconds. That measured whatever the client
 * happened to do in six seconds, which for anyone taking the instruction
 * cautiously was not enough movement to fit anything — and the pass reported
 * success regardless, because a fit that finds nothing falls back to the
 * textbook constants rather than failing loudly. Testers said as much: the
 * instruction was clear, but "still slightly unclear how much side to side and
 * nodding I should do."
 *
 * Now the requirement is shown as a ring of four arcs and the pass ends when
 * they are full, so the amount is visible and finishing is unambiguous.
 */
const HEAD_PASS_SETTLE_MS = 900;
/** Floor, so the ring cannot be filled and gone before it has been understood. */
const HEAD_PASS_MIN_MS = 2500;
/** Ceiling, so a client who cannot complete the ring is never trapped by it. */
const HEAD_PASS_MAX_MS = 20000;

function briefingKey(phase: BriefFor, confirmMode: boolean): BriefingKey {
  if (!confirmMode) return phase;
  if (phase === 'capture') return 'capture_confirmed';
  if (phase === 'validate') return 'validate_confirmed';
  return phase;
}

/**
 * Where a target actually lands, as a fraction of the viewport.
 *
 * Specs are percentages of the *working area*, which may be smaller than the
 * window. Anchors are still stored in viewport fractions, so the mapping the
 * model learns remains in viewport coordinates and everything downstream is
 * unaffected — the calibrated region is simply smaller than the glass.
 */
function targetViewportNorm(spec: CalibrationPointSpec): { xNorm: number; yNorm: number } {
  const area = viewingGeometry.getWorkingArea();
  return {
    xNorm: (area.left + (spec.xPercent / 100) * area.width) / window.innerWidth,
    yNorm: (area.top + (spec.yPercent / 100) * area.height) / window.innerHeight,
  };
}

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
  const [briefFor, setBriefFor] = useState<BriefFor>('capture');
  const [headPassOutcome, setHeadPassOutcome] = useState<'pending' | 'measured' | 'skipped' | 'failed'>('pending');
  /**
   * Whether the client confirms each point themselves.
   *
   * Held here rather than read straight from settings so it can be turned off
   * for one session — for a client who cannot reliably press a key — without
   * changing the clinic's default.
   */
  const [confirmMode, setConfirmMode] = useState(settings.confirmCalibrationPoints);
  /** Set once enough settled samples are in the confirmation window. */
  const [readyToConfirm, setReadyToConfirm] = useState(false);
  /** Whether the eye has been seen to leave the previous dot; see ARRIVAL_GRACE_MS. */
  const arrivedRef = useRef(false);
  const [headCoverage, setHeadCoverage] = useState<HeadCoverage>(EMPTY_COVERAGE);
  const [headMarker, setHeadMarker] = useState({ x: 0, y: 0 });
  /** The pose the pass started from; every excursion is measured against it. */
  const headReferenceRef = useRef<{ yaw: number; pitch: number } | null>(null);
  const headCoverageRef = useRef<HeadCoverage>(EMPTY_COVERAGE);
  /** How full the ring got, so the result can say which half of the step fell short. */
  const [headPassCoverage, setHeadPassCoverage] = useState(0);
  /** Shown when a press arrives before the eye has held still long enough. */
  const [confirmNudge, setConfirmNudge] = useState(false);

  /**
   * The session recording, accumulated as it happens.
   *
   * Written alongside the working refs rather than reconstructed at the end,
   * because most of what makes a run diagnosable — which samples arrived, when,
   * and whether each was judged settled at the time — is discarded by the
   * summarising the working refs do. Nothing here is sent anywhere; it becomes a
   * file only if the user asks for one.
   */
  const recordedCaptureRef = useRef<RecordedPoint[]>([]);
  const recordedValidationRef = useRef<RecordedPoint[]>([]);
  const recordedHeadPassRef = useRef<SessionRecord['headPass']>(null);
  /** Settled flags and arrival times, parallel to samplesRef. */
  const sampleSettledRef = useRef<boolean[]>([]);
  const sampleTimesRef = useRef<number[]>([]);

  const samplesRef = useRef<CalibrationSample[]>([]);
  /**
   * Samples taken while the eye was actually settled.
   *
   * The settle delay before each capture is a guess at how long it takes to
   * find a new dot and land on it. When the guess is short — an older client, a
   * dot in an awkward corner, a moment's inattention — the capture window opens
   * while the eye is still travelling, and those in-flight samples drag the
   * point's median away from where the client eventually looked. Preferring
   * settled samples removes the guesswork; keeping the full set as a fallback
   * means a client whose gaze never quite settles still calibrates.
   */
  const settledSamplesRef = useRef<CalibrationSample[]>([]);
  /**
   * Mapped positions for the settled samples, with the time each arrived.
   *
   * Steadiness is the scatter between *consecutive* samples, so a pair that
   * straddles a gap — a blink, a dropped frame — measures the gaze's real
   * travel across that gap rather than any wobble, and inflates the figure
   * wildly. Keeping the timestamps lets those pairs be excluded.
   */
  const settledPointsRef = useRef<Array<{ x: number; y: number; t: number }>>([]);
  const gazePointsRef = useRef<Array<{ x: number; y: number; t: number }>>([]);
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

  useEffect(() => setConfirmMode(settings.confirmCalibrationPoints), [settings.confirmCalibrationPoints]);

  /**
   * Settled samples whose timestamps fall inside a window, with the mapped
   * points that go with them.
   *
   * The two arrays are appended in lockstep by the sample sink, so an index
   * into one is the same moment in the other.
   */
  const settledWithin = useCallback((from: number, to: number) => {
    const points = settledPointsRef.current;
    const samples = settledSamplesRef.current;
    const outSamples: CalibrationSample[] = [];
    const outPoints: Array<{ x: number; y: number; t: number }> = [];
    for (let i = 0; i < points.length && i < samples.length; i++) {
      if (points[i].t >= from && points[i].t <= to) {
        outSamples.push(samples[i]);
        outPoints.push(points[i]);
      }
    }
    return { samples: outSamples, points: outPoints };
  }, []);

  // ---------------------------------------------------------------- capture
  /** Shows the card for a phase, then runs that phase when the user is ready. */
  const brief = useCallback((phase: BriefFor) => {
    setBriefFor(phase);
    setStage('brief');
  }, []);

  const beginPoint = useCallback((index: number) => {
    setTargetIndex(index);
    // Confirmed capture has nothing to wait for: the buffer starts filling
    // immediately so there is already a window to reach back into by the time
    // the client is ready to press.
    setPhase(confirmMode ? 'collect' : 'settle');
    setProgress(0);
    setReadyToConfirm(false);
    setConfirmNudge(false);
    arrivedRef.current = false;
    samplesRef.current = [];
    settledSamplesRef.current = [];
    settledPointsRef.current = [];
    gazePointsRef.current = [];
    sampleSettledRef.current = [];
    sampleTimesRef.current = [];
    phaseStartRef.current = performance.now();
    soundEngine.playChime(560, 0.1);
  }, [confirmMode]);

  const startValidationPhase = useCallback(() => {
    validationResultsRef.current = [];
    recordedValidationRef.current = [];
    framesSeenRef.current = 0;
    framesUsedRef.current = 0;
    setStage('validate');
    beginPoint(0);
  }, [beginPoint]);

  /** Freezes everything observed at one dot, for the session recording. */
  const recordPoint = useCallback(
    (spec: CalibrationPointSpec, usedSampleCount: number, confirmedAt?: number): RecordedPoint => {
      const { xNorm, yNorm } = targetViewportNorm(spec);
      return {
        id: String(spec.id),
        label: spec.label,
        xNorm,
        yNorm,
        samples: [...samplesRef.current],
        settled: [...sampleSettledRef.current],
        timestamps: [...sampleTimesRef.current],
        usedSampleCount,
        confirmedAt,
      };
    },
    []
  );

  const finishCapturePoint = useCallback(
    (spec: CalibrationPointSpec, confirmed?: CalibrationSample[], confirmedAt?: number) => {
      const settled = settledSamplesRef.current;
      const chosen =
        confirmed ?? (settled.length >= MIN_SETTLED_SAMPLES ? settled : samplesRef.current);

      recordedCaptureRef.current.push(recordPoint(spec, chosen.length, confirmedAt));

      const { xNorm, yNorm } = targetViewportNorm(spec);
      const anchor = calibrationEngine.addAnchorFromSamples(
        `grid-${spec.id}`,
        xNorm,
        yNorm,
        chosen,
        spec.label
      );

      if (anchor) {
        setCapturedCount(c => c + 1);
        soundEngine.playCalibrationTargetHit();
      } else {
        setFailedPoints(prev => (prev.includes(spec.id) ? prev : [...prev, spec.id]));
      }
    },
    [recordPoint]
  );

  const finishValidatePoint = useCallback((
    spec: CalibrationPointSpec,
    confirmed?: Array<{ x: number; y: number; t: number }>,
    confirmedAt?: number
  ) => {
    recordedValidationRef.current.push(
      recordPoint(spec, (confirmed ?? settledPointsRef.current).length, confirmedAt)
    );

    // Measure accuracy from settled samples only. Including the approach to the
    // dot would report the journey rather than the destination.
    const points =
      confirmed ??
      (settledPointsRef.current.length >= MIN_SETTLED_SAMPLES
        ? settledPointsRef.current
        : gazePointsRef.current);
    const scrW = window.innerWidth;
    const scrH = window.innerHeight;
    const { xNorm, yNorm } = targetViewportNorm(spec);
    const targetX = xNorm * scrW;
    const targetY = yNorm * scrH;

    if (points.length < 5) {
      validationResultsRef.current.push({
        id: String(spec.id),
        xNorm,
        yNorm,
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
    // the figure eye-tracker specifications normally quote. Pairs separated by
    // more than one frame interval are skipped — across a blink the two samples
    // are not consecutive in any meaningful sense, and counting the gap as
    // wobble was turning an ordinary blink into several degrees of reported
    // instability.
    let sumSq = 0;
    let pairs = 0;
    for (let i = 1; i < points.length; i++) {
      if (points[i].t - points[i - 1].t > CONSECUTIVE_SAMPLE_MS) continue;
      const dx = points[i].x - points[i - 1].x;
      const dy = points[i].y - points[i - 1].y;
      sumSq += dx * dx + dy * dy;
      pairs++;
    }
    const precisionPx = pairs > 0 ? Math.sqrt(sumSq / pairs) : NaN;

    validationResultsRef.current.push({
      id: String(spec.id),
      xNorm,
      yNorm,
      errorPx,
      errorDeg: viewingGeometry.pixelsToDegrees(errorPx),
      offsetX: meanX - targetX,
      offsetY: meanY - targetY,
      precisionPx,
      precisionDeg: viewingGeometry.pixelsToDegrees(precisionPx),
      sampleCount: points.length,
    });

    soundEngine.playChime(640, 0.12);
  }, [recordPoint]);

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

      // Blinks are excluded from the denominator entirely. "Eyes found" is
      // meant to say how reliably the tracker held on to open eyes; counting
      // an involuntary reflex against that both misdescribes the measurement
      // and, shown to a client, discourages them from blinking.
      if (gaze.event === 'blink') return;

      framesSeenRef.current++;
      if (!usable) return;
      framesUsedRef.current++;

      // Nothing counts until the eye has actually travelled to this dot. The
      // grace period only applies to a gaze that never registers the move.
      if (confirmMode && !arrivedRef.current) {
        if (gaze.event === 'saccade' || performance.now() - phaseStartRef.current > ARRIVAL_GRACE_MS) {
          arrivedRef.current = true;
        }
        return;
      }

      samplesRef.current.push(sample);
      sampleSettledRef.current.push(gaze.isFixating);
      sampleTimesRef.current.push(gaze.timestamp);
      if (gaze.isFixating) {
        settledSamplesRef.current.push(sample);
        settledPointsRef.current.push({ x: gaze.screenX, y: gaze.screenY, t: gaze.timestamp });
      }
      gazePointsRef.current.push({ x: gaze.screenX, y: gaze.screenY, t: gaze.timestamp });
    });

    return () => tracker.collectSamples(null);
  }, [isOpen, tracker, stage, phase, confirmMode]);

  // Timing loop for the head-movement pass.
  useEffect(() => {
    if (!isOpen || stage !== 'head_pass') return;

    let frame = 0;
    const tick = () => {
      const elapsed = performance.now() - phaseStartRef.current;
      const pose = liveGazeRef.current?.headPose;

      if (elapsed < HEAD_PASS_SETTLE_MS) {
        setProgress(elapsed / HEAD_PASS_SETTLE_MS);
        if (phase !== 'settle') setPhase('settle');
        // The settling second is also what defines "centre": excursions are
        // measured from wherever the client is actually sitting, not from a
        // nominal pose they may never have been in.
        if (pose) headReferenceRef.current = { yaw: pose.yaw, pitch: pose.pitch };
        frame = requestAnimationFrame(tick);
        return;
      }

      if (phase !== 'collect') setPhase('collect');

      const reference = headReferenceRef.current;
      if (pose && reference) {
        const next = accumulateCoverage(
          headCoverageRef.current,
          pose.yaw,
          pose.pitch,
          reference.yaw,
          reference.pitch
        );
        headCoverageRef.current = next.coverage;
        setHeadCoverage(next.coverage);
        setHeadMarker({ x: next.markerX, y: next.markerY });
        setProgress(coverageFraction(next.coverage));
      }

      const moving = elapsed - HEAD_PASS_SETTLE_MS;
      const done =
        (coverageComplete(headCoverageRef.current) && moving >= HEAD_PASS_MIN_MS) ||
        moving >= HEAD_PASS_MAX_MS;

      if (done) {
        const gain = calibrationEngine.fitHeadGainFromMotionPass(samplesRef.current);
        // A gain of exactly one on both axes is what the fit falls back to when
        // it cannot trust what it measured. Reporting that as "measured"
        // because a non-null object came back is how this step used to claim
        // success while having learned nothing.
        const measured = gain !== null && (gain.rotation !== 1 || gain.translation !== 1);
        recordedHeadPassRef.current = {
          samples: [...samplesRef.current],
          coverage: { ...headCoverageRef.current },
          outcome: measured ? 'measured' : 'failed',
        };
        setHeadPassCoverage(coverageFraction(headCoverageRef.current));
        setHeadPassOutcome(measured ? 'measured' : 'failed');
        soundEngine.playChime(measured ? 640 : 380, 0.15);
        brief('validate');
        return;
      }

      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [isOpen, stage, phase, brief]);

  /**
   * Records the current point and moves on.
   *
   * Hoisted out of the timing loop because there are now two things that can
   * end a point — the sample count filling in hands-free mode, and the client's
   * key press in confirmed mode — and both have to finish it the same way.
   */
  const advance = useCallback((confirmedAt?: number) => {
    if (!currentTarget) return;

    const windowEnd = confirmedAt === undefined ? 0 : confirmedAt - CONFIRM_EXCLUDE_MS;
    const captured =
      confirmedAt === undefined
        ? undefined
        : settledWithin(windowEnd - CONFIRM_LOOKBACK_MS, windowEnd);

    if (stage === 'capture') finishCapturePoint(currentTarget, captured?.samples, confirmedAt);
    else finishValidatePoint(currentTarget, captured?.points, confirmedAt);

    const next = targetIndex + 1;
    if (next < targets.length) {
      beginPoint(next);
      return;
    }

    if (stage === 'capture') {
      // Drop any point the rest of the grid clearly disagrees with, before it
      // can distort the head-movement fit and the accuracy check after it.
      setPrunedPoints(calibrationEngine.pruneOutlierAnchors().removed);

      // The posture held during calibration is what the mapping is tied to,
      // so it becomes the reference for later drift warnings.
      const posture = liveGazeRef.current?.headPose;
      if (posture) calibrationEngine.recordPosture(posture);

      if (wantHeadPass) {
        brief('head_pass');
      } else {
        setHeadPassOutcome('skipped');
        brief('validate');
      }
    } else {
      completeValidation();
    }
  }, [
    stage,
    currentTarget,
    targetIndex,
    targets.length,
    wantHeadPass,
    settledWithin,
    finishCapturePoint,
    finishValidatePoint,
    completeValidation,
    beginPoint,
    brief,
  ]);

  /**
   * The client's confirmation that they are on the dot.
   *
   * A press with too little settled data behind it is refused rather than
   * recorded: it means the eye had not held still through the window being
   * asked for, and taking it anyway would put back exactly the unverified point
   * this mode exists to prevent. The refusal is visible, so nobody is left
   * pressing at a dot that will not take.
   */
  const confirmPoint = useCallback(() => {
    const now = Date.now();
    if (performance.now() - phaseStartRef.current < CONFIRM_ARM_MS) return;

    const end = now - CONFIRM_EXCLUDE_MS;
    const { samples } = settledWithin(end - CONFIRM_LOOKBACK_MS, end);
    if (samples.length < CONFIRM_MIN_SAMPLES) {
      setConfirmNudge(true);
      soundEngine.playChime(300, 0.1);
      return;
    }
    advance(now);
  }, [advance, settledWithin]);

  useEffect(() => {
    if (!isOpen || !confirmMode) return;
    if (stage !== 'capture' && stage !== 'validate') return;

    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (e.code !== 'Space' && e.code !== 'Enter' && e.code !== 'NumpadEnter') return;
      e.preventDefault();
      confirmPoint();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, confirmMode, stage, confirmPoint]);

  // Timing loop for the settle/collect cycle.
  useEffect(() => {
    if (!isOpen || (stage !== 'capture' && stage !== 'validate') || !currentTarget) return;

    const wanted = stage === 'validate' ? TARGET_SETTLED_SAMPLES_VALIDATE : TARGET_SETTLED_SAMPLES;

    const tick = () => {
      const elapsed = performance.now() - phaseStartRef.current;
      const settledNow = liveGazeRef.current?.isFixating ?? false;

      if (confirmMode) {
        // Nothing advances on its own here. The ring reports how much settled
        // data is behind the client's next press, so a dot that is ready to be
        // confirmed looks different from one that is not — and holding still
        // visibly earns something instead of feeling like waiting.
        const end = Date.now() - CONFIRM_EXCLUDE_MS;
        const banked = settledWithin(end - CONFIRM_LOOKBACK_MS, end).samples.length;
        setProgress(Math.min(1, banked / CONFIRM_MIN_SAMPLES));
        setReadyToConfirm(banked >= CONFIRM_MIN_SAMPLES);
        if (banked >= CONFIRM_MIN_SAMPLES) setConfirmNudge(false);
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      if (phase === 'settle') {
        // Waiting for the eye to arrive and stop. The ring shows this as a
        // gentle hold rather than progress, so the client is not being told
        // something is happening when nothing is.
        setProgress(Math.min(0.999, elapsed / SETTLE_TIMEOUT_MS));

        const readyToCollect = elapsed >= MIN_SETTLE_MS && settledNow;
        if (readyToCollect || elapsed >= SETTLE_TIMEOUT_MS) {
          setPhase('collect');
          setProgress(0);
          phaseStartRef.current = performance.now();
        }
      } else {
        // Progress tracks samples banked, not seconds elapsed, so looking away
        // stops the ring instead of quietly filling it with rubbish.
        const banked = settledSamplesRef.current.length;
        setProgress(Math.min(1, banked / wanted));

        if (banked >= wanted || elapsed >= COLLECT_TIMEOUT_MS) {
          advance();
          return;
        }
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [isOpen, stage, phase, currentTarget, confirmMode, settledWithin, advance]);

  /**
   * Writes the run to a file.
   *
   * Assembled on demand rather than kept in state: it is several hundred
   * kilobytes of samples, and re-rendering the result screen around it would be
   * paying that cost continuously for something most sessions never ask for.
   */
  const saveRecording = useCallback(() => {
    const record = buildSessionRecord({
      depth,
      confirmMode,
      capture: recordedCaptureRef.current,
      headPass: recordedHeadPassRef.current,
      validation: recordedValidationRef.current,
      prunedPoints,
      result: validation,
      cameraDiagnostics: {
        resolution: tracker?.getDiagnostics().resolution ?? null,
        fps: tracker?.getDiagnostics().fps ?? 0,
        matrixLayout: tracker?.getDiagnostics().features?.matrixLayout ?? null,
        usedFallbackHeadPose: tracker?.getDiagnostics().features?.usedFallbackHeadPose ?? null,
      },
      trackingSettings: settings,
    });
    downloadSessionRecord(record);
    return estimateRecordSizeKb(record);
  }, [depth, confirmMode, prunedPoints, validation, tracker, settings]);

  const beginBriefedPhase = useCallback(() => {
    if (briefFor === 'capture') {
      // A fresh grid is a fresh recording; a retry must not inherit the points
      // of the run it is replacing.
      recordedCaptureRef.current = [];
      recordedValidationRef.current = [];
      recordedHeadPassRef.current = null;
      setStage('capture');
      beginPoint(0);
    } else if (briefFor === 'head_pass') {
      samplesRef.current = [];
      headCoverageRef.current = EMPTY_COVERAGE;
      headReferenceRef.current = null;
      setHeadCoverage(EMPTY_COVERAGE);
      setHeadMarker({ x: 0, y: 0 });
      phaseStartRef.current = performance.now();
      setPhase('settle');
      setProgress(0);
      setStage('head_pass');
    } else {
      startValidationPhase();
    }
  }, [briefFor, beginPoint, startValidationPhase]);

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
    brief('capture');
  };

  const startValidationOnly = () => brief('validate');

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
              {stage === 'brief' && 'Before you start'}
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
          confirmMode={confirmMode}
          readyToConfirm={readyToConfirm}
          nudge={confirmNudge}
        />
      )}

      {stage === 'brief' && (
        <BriefStage
          briefing={BRIEFINGS[briefingKey(briefFor, confirmMode)]}
          onStart={beginBriefedPhase}
          confirmMode={briefFor === 'capture' ? confirmMode : undefined}
          onConfirmModeChange={setConfirmMode}
        />
      )}

      {stage === 'head_pass' && (
        <HeadPassStage phase={phase} coverage={headCoverage} marker={headMarker} />
      )}

      {stage === 'result' && (
        <ResultStage
          prunedCount={prunedPoints.length}
          headPassOutcome={headPassOutcome}
          headPassCoverage={headPassCoverage}
          validation={validation}
          failedPoints={failedPoints}
          onRedo={() => setStage('position')}
          onSaveRecording={saveRecording}
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
            'On a Mac, turn off Centre Stage, Portrait and Studio Light in Control Centre. Centre Stage re-frames the picture as you move, which pulls the calibration apart underneath you.',
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
        <HeadPositionCard />

        {/*
          Screen size sits here for the same reason distance does, and for one
          more: it was the setting people kept remembering only after they had
          finished calibrating. It is now usually recognised outright, so the
          card mostly just confirms — but when the panel is unknown this is the
          moment to say so, while it still costs nothing.
        */}
        <ScreenSizeCard />

        {/*
          Distance belongs in set-up, not buried in settings: the accuracy figure
          this flow produces is in degrees, and degrees are computed from it. An
          estimate out by a factor of two reports twice the error the client
          actually has, and sends a clinician chasing a problem that is not there.
        */}
        <div className="surface rounded-2xl p-5 space-y-3">
          <div>
            <h4 className="text-sm font-semibold text-ink">Is that distance right?</h4>
            <p className="text-xs text-ink-soft mt-1 leading-relaxed">
              Only worth correcting once. Everything measured in degrees is scaled from it.
            </p>
          </div>
          <DistanceCheck />
        </div>

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
  confirmMode: boolean;
  readyToConfirm: boolean;
  nudge: boolean;
}> = ({ spec, phase, progress, isValidation, index, total, confirmMode, readyToConfirm, nudge }) => {
  const collecting = phase === 'collect';
  const ringRadius = 30;
  const circumference = 2 * Math.PI * ringRadius;
  const position = targetViewportNorm(spec);

  return (
    <div className="flex-1 relative">
      {/* Few enough words to register peripherally. Anything that genuinely
          needed reading was said on the briefing card, before the eyes were
          committed to the dot. */}
      {/*
        The instruction moves to whichever end of the screen the dot is not at.

        Nudging the grid inwards clears today's collision at today's window size,
        which is not the same as fixing it: the text is centred and the top row
        is centred, so on a shorter window they meet again. Putting the line
        opposite the target keeps them apart at any size, and has the better
        property of never asking the client to read something sitting a couple of
        degrees from the point they are being told to fixate.
      */}
      <p
        className={`absolute left-1/2 -translate-x-1/2 text-lg font-medium text-ink-soft text-center transition-all duration-200 ${
          position.yNorm < 0.45 ? 'bottom-16' : 'top-8'
        }`}
      >
        {confirmMode
          ? nudge
            ? 'Hold still a moment longer, then press space'
            : readyToConfirm
              ? 'Press space'
              : 'Look at the dot and hold still'
          : collecting
            ? 'Hold it…'
            : 'Look at the dot'}
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
        style={{ left: `${position.xNorm * 100}%`, top: `${position.yNorm * 100}%` }}
      >
        <svg width={80} height={80} className="overflow-visible">
          <circle cx={40} cy={40} r={ringRadius} fill="none" stroke="var(--border-strong)" strokeWidth={3} />
          {/*
            The ring only fills while the eye is actually settled, so it visibly
            stalls if the client looks away. That honesty matters: a ring that
            fills regardless teaches everyone to trust a point that was never
            really captured.
          */}
          {(collecting || confirmMode) && (
            <circle
              cx={40}
              cy={40}
              r={ringRadius}
              fill="none"
              stroke={confirmMode && readyToConfirm ? 'var(--color-sage-400)' : 'var(--color-sage-500)'}
              strokeWidth={3}
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={circumference * (1 - progress)}
              transform="rotate(-90 40 40)"
              style={{ transition: 'stroke-dashoffset 90ms linear' }}
            />
          )}
          {/*
            In confirmed mode a full ring means "ready", not "done" — so it
            gets a second, wider halo rather than simply completing. A closed
            ring that then sits there would read as a capture that has already
            happened, and the client would stop looking a moment before the
            samples they are about to confirm are taken.
          */}
          {confirmMode && readyToConfirm && (
            <circle
              cx={40}
              cy={40}
              r={ringRadius + 7}
              fill="none"
              stroke="var(--color-sage-400)"
              strokeWidth={2}
              opacity={0.55}
              className="animate-pulse"
            />
          )}
          {/* While waiting, the dot breathes rather than filling a ring —
              something to rest the eye on, without implying progress. */}
          <circle
            cx={40}
            cy={40}
            r={collecting && !confirmMode ? 4 : 7}
            fill={
              confirmMode
                ? readyToConfirm
                  ? 'var(--color-sage-500)'
                  : 'var(--color-clay-400)'
                : collecting
                  ? 'var(--color-sage-500)'
                  : 'var(--color-clay-400)'
            }
            className={confirmMode ? undefined : collecting ? undefined : 'animate-pulse'}
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
 * The card shown before each phase.
 *
 * Deliberately a hard stop rather than a caption. Everything the client needs
 * to understand is here, at a readable size, with nothing else on screen
 * competing for their eyes — and the phase does not begin until they say they
 * are ready. Once it does begin, the on-screen text drops to a few words that
 * can be taken in peripherally, because by then their gaze is committed to a
 * dot and any real reading has to have happened already.
 *
 * The instruction is also spoken. For a task that occupies the eyes, the ears
 * are the only channel left, and a client who cannot read the screen comfortably
 * — which is a fair share of the people this is built for — gets the same
 * instruction as everyone else.
 */
const BriefStage: React.FC<{
  briefing: Briefing;
  onStart: () => void;
  /** Present only on the capture briefing, where the choice is offered. */
  confirmMode?: boolean;
  onConfirmModeChange: (value: boolean) => void;
}> = ({ briefing, onStart, confirmMode, onConfirmModeChange }) => {
  useEffect(() => {
    speakPrompt(briefing.spoken);
    return () => cancelSpeech();
  }, [briefing]);

  // Enter and space start the phase, so a clinician can drive this without
  // reaching across the client for the mouse.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space' || e.code === 'Enter') {
        e.preventDefault();
        onStart();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onStart]);

  return (
    <div className="flex-1 flex items-center justify-center px-6">
      <div className="max-w-lg text-center space-y-5">
        <h3 className="text-2xl font-semibold text-ink leading-snug">{briefing.title}</h3>
        <p className="text-base text-ink-soft leading-relaxed">{briefing.body}</p>
        <button
          onClick={onStart}
          className="px-7 py-3.5 rounded-xl bg-sage-500 hover:bg-sage-600 text-white font-medium text-base transition-colors"
        >
          {briefing.action}
        </button>
        <p className="text-xs text-ink-faint">or press space</p>

        {/*
          Offered here rather than buried in settings, because the person who
          needs it is in front of the screen right now. Confirming each point is
          more accurate and is the default, but it assumes a client who can
          press a key at the right moment — which rules out a fair share of the
          people this is built for. Hands-free is the same flow with the eye's
          own stillness standing in for the press.
        */}
        {confirmMode !== undefined && (
          <label className="inline-flex items-center gap-2.5 text-sm text-ink-soft cursor-pointer pt-2">
            <input
              type="checkbox"
              checked={!confirmMode}
              onChange={e => onConfirmModeChange(!e.target.checked)}
              className="w-4 h-4 accent-[var(--color-sage-500)]"
            />
            Hands-free — fill each dot automatically instead of pressing space
          </label>
        )}
      </div>
    </div>
  );
};

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
const HeadPassStage: React.FC<{
  phase: Phase;
  coverage: HeadCoverage;
  marker: { x: number; y: number };
}> = ({ phase, coverage, marker }) => {
  const collecting = phase === 'collect';
  const next = nextDirection(coverage);

  // Spoken at the moment it becomes relevant, because this is the one phase
  // where the client has to keep doing something while their eyes are fixed.
  useEffect(() => {
    if (collecting) speakPrompt('Keep your eyes on the dot, and move your head to fill the ring.');
  }, [collecting]);

  // One direction at a time, spoken as it becomes the one that is missing. The
  // ring shows the whole task; the voice only ever names the next step, so a
  // client who cannot read the screen is never asked for two things at once.
  useEffect(() => {
    if (collecting && next) speakPrompt(DIRECTION_PROMPT[next]);
  }, [collecting, next]);

  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-8 px-6">
      <div className="text-center max-w-md space-y-2">
        <h3 className="text-2xl font-semibold text-ink">Keep looking at the dot</h3>
        <p className="text-lg text-ink-soft leading-relaxed">
          {collecting ? 'Move your head until the ring is full' : 'Settle on the dot…'}
        </p>
      </div>

      <HeadCoverageRing
        coverage={coverage}
        markerX={marker.x}
        markerY={marker.y}
        active={collecting}
      />

      {collecting && (
        <p className="text-lg font-medium text-sage-600 h-7">
          {next ? DIRECTION_PROMPT[next] : 'That is it — hold still'}
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
      'Something physical is usually behind this rather than anything in the software. In rough order of how often it is the cause: sitting too close, so the screen edges are further off centre than a webcam can follow; Centre Stage or Portrait mode re-framing the picture on a Mac; light behind the head; glasses reflecting the screen; or moving between the set-up and the check.',
  },
};

const ResultStage: React.FC<{
  validation: ValidationResult | null;
  failedPoints: number[];
  prunedCount: number;
  headPassOutcome: 'pending' | 'measured' | 'skipped' | 'failed';
  /** How full the head-movement ring got, 0-1; distinguishes the two failure causes. */
  headPassCoverage: number;
  onRedo: () => void;
  onRecheck: () => void;
  onAccept: () => void;
  /** Saves the run to a file, returning its size in kilobytes. */
  onSaveRecording: () => number;
}> = ({
  validation,
  failedPoints,
  prunedCount,
  headPassOutcome,
  headPassCoverage,
  onRedo,
  onRecheck,
  onAccept,
  onSaveRecording,
}) => {
  const [savedKb, setSavedKb] = useState<number | null>(null);
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
            {/* The leave-one-out figure used to be quoted here too. It was
                withdrawn: measured against synthetic data whose true error is
                known, it overstates by about three and a half times, because
                removing a set-up point leaves a hole in the local correction
                that never exists in use. It is still the right tool for
                comparing two models on the same points — where the bias
                cancels — so it still drives point pruning and model choice, and
                it is still reported in diagnostics. It just is not an accuracy
                figure to put in front of a client. See docs/accuracy.md. */}
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
                (headPassCoverage < 0.9
                  ? 'The ring was not filled, so there was not enough head movement to measure anything and a standard allowance is being used. Running set-up again and reaching further in each direction should fix it.'
                  : 'The ring was filled, but the movement did not produce a usable measurement — usually the eyes drifted off the dot while the head moved, or the face was hard to track at the extremes. A standard allowance is being used instead.')}
            </p>
          </div>
        )}

        {/* The most likely physical cause of a poor result, checked and stated
            here rather than left in the generic advice above. */}
        {validation.grade !== 'excellent' && validation.grade !== 'good' && <GazeRangeCheck />}

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

        {/*
          Offered on every run, not just poor ones. A good session is the more
          useful recording of the two — it is the thing a change has to avoid
          breaking, and without one there is nothing to compare a bad session
          against.
        */}
        <div className="surface rounded-2xl px-5 py-4 space-y-2">
          <h4 className="text-sm font-semibold text-ink">Save this session</h4>
          <p className="text-sm text-ink-soft leading-relaxed">
            Writes every measurement this run was built from to a file — the samples behind each
            dot, the head positions they were taken at, and the model fitted from them. It stays on
            this machine unless you send it. It is what makes a disappointing result diagnosable
            rather than a mystery.
          </p>
          <button
            onClick={() => setSavedKb(onSaveRecording())}
            className="px-4 py-2.5 rounded-xl border border-strong text-ink text-sm font-medium flex items-center gap-2 hover:bg-[var(--surface-sunken)] transition-colors"
          >
            <Download className="w-4 h-4" />
            Save the session file
          </button>
          {savedKb !== null && (
            <p className="text-xs text-sage-600">Saved, about {savedKb} KB.</p>
          )}
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
