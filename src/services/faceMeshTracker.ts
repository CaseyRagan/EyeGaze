import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import { CalibrationSample, GazeState, HeadPose, OcularEvent, Point2D, TrackingSettings } from '../types';
import { calibrationEngine } from './calibration';
import { FeatureDiagnostics, extractGazeFeatures } from './gazeFeatures';
import { gazeBus } from './gazeBus';
import { soundEngine } from './audio';
import { OneEuroFilter2D } from './oneEuroFilter';
import { viewingGeometry } from './viewingGeometry';

export type TrackerStatus =
  | 'uninitialized'
  | 'loading_model'
  | 'requesting_camera'
  | 'running'
  | 'paused'
  | 'error';

export interface TrackerCallbacks {
  onStatusChange?: (status: TrackerStatus, errorMsg?: string) => void;
  onVideoFrame?: (video: HTMLVideoElement, landmarks?: any) => void;
  onBlink?: (eye: 'left' | 'right' | 'both') => void;
}

export const DEFAULT_TRACKING_SETTINGS: TrackingSettings = {
  oneEuroMinCutoff: 0.9,
  oneEuroBeta: 0.05,
  saccadeVelocityThreshold: 32,
  sensitivityX: 1,
  sensitivityY: 1,
  deadzone: 4,
  nudgeOffsetX: 0,
  nudgeOffsetY: 0,
  trackingEngineMode: 'binocular',
  magneticSnapAssist: true,
  magneticSnapRadius: 110,
  snapToGrid: false,
  gridSnapSize: 40,
  dwellDurationMs: 900,
  invertX: false,
  invertY: false,
  holdThroughBlinks: true,
  minConfidence: 0.2,
  penMode: 'auto_stream',
  audioEnabled: true,
  spokenPrompts: true,
  confirmCalibrationPoints: true,
  showWebcamPiP: true,
  showLandmarkMesh: true,
  showGazeTrail: true,
  showGazeReticle: true,
  showPostureGuide: true,
  strokeColor: '#3f7f75',
  strokeGlowColor: '#7cc4b6',
  strokeWidth: 6,
};

const SETTINGS_STORAGE_KEY = 'lantern.trackingSettings';

/**
 * Loads the saved tracking settings, over the defaults.
 *
 * Merging rather than replacing matters as much as the storage itself: settings
 * saved by an older build will not contain keys added since, and a stored
 * object used as-is would leave those undefined — a missing dwell time or
 * filter cutoff is not a harmless gap, it is a broken tracker. Anything the
 * stored object does not mention keeps its default.
 */
export function loadTrackingSettings(): TrackingSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_TRACKING_SETTINGS };
    return { ...DEFAULT_TRACKING_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_TRACKING_SETTINGS };
  }
}

export function saveTrackingSettings(settings: TrackingSettings) {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage unavailable (private browsing); the session still works.
  }
}

/** Landmarks stay unstable for a moment after the lids reopen. */
const POST_BLINK_HOLD_MS = 110;
/**
 * How long the estimate may be held before anything says so.
 *
 * A spontaneous blink closes the lids for roughly 100-150 ms, and people blink
 * about fifteen times a minute without noticing. Announcing every one of those
 * — dimming the pointer, dashing its outline, dropping the trail — turns an
 * involuntary reflex into visible feedback that something has gone wrong, and
 * the natural response is to stop blinking. That is not a cosmetic problem: a
 * client suppressing blinks gets dry eyes within a minute, and dry eyes track
 * worse, so the display creates the instability it is reporting.
 *
 * Blinks are therefore ridden out in silence. Only an interruption long enough
 * to be something other than a blink is worth telling anyone about.
 */
const HELD_GRACE_MS = 450;

/**
 * Eye openness below which the estimate stops being trusted.
 *
 * Deliberately higher than the threshold that counts a blink. A lid on its way
 * down covers the top of the iris well before the eye reads as closed, and the
 * iris centre estimate slides downward with it — so by the time a blink is
 * *declared*, the pointer has already been dragged away from where the client
 * was looking. Holding from the first sign of closure means the held position
 * is the one they actually had, and the marker stays put instead of lurching
 * and returning.
 */
const GAZE_TRUST_OPENNESS = 0.5;
/** A fixation is only declared once the eye has been slow for this long. */
const FIXATION_ONSET_MS = 60;

export class FaceMeshTracker {
  private faceLandmarker: FaceLandmarker | null = null;
  private videoElement: HTMLVideoElement | null = null;
  private stream: MediaStream | null = null;
  private animationFrameId: number | null = null;
  private status: TrackerStatus = 'uninitialized';
  private callbacks: TrackerCallbacks = {};
  private lastVideoTime = -1;
  private disposed = false;

  // A light filter on the eye measurement itself, before the mapping can
  // amplify landmark noise, plus the user-tunable filter on screen position.
  private featureFilter = new OneEuroFilter2D(2.5, 0.02);
  private screenFilter = new OneEuroFilter2D(0.9, 0.05);

  private lastScreen: Point2D = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  private lastGoodScreen: Point2D = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  /** When the current run of held frames began, or null when tracking normally. */
  private heldSince: number | null = null;
  private lastFeature: Point2D = { x: 0, y: 0 };
  private lastHeadPose: HeadPose | null = null;

  private blinkCount = 0;
  private lastBlinkBoth = false;
  private lastBlinkLeft = false;
  private lastBlinkRight = false;
  private lastBlinkEndTime = 0;
  private lastBlinkTime = 0;

  private event: OcularEvent = 'lost';
  private slowSinceMs: number | null = null;
  private fixationStart = 0;
  private fixationCentre: Point2D | null = null;
  private fixationPoints: Point2D[] = [];
  private velocityDegPerSec = 0;
  private lastSampleTime = 0;
  /** Previous emitted position, used only for the velocity estimate. */
  private prevVelocityPoint: Point2D | null = null;

  private lastSnappedTarget: Point2D | null = null;
  private simulatedPointer = false;
  private pointerLoopId: number | null = null;
  private pointerPosition: Point2D | null = null;

  private lastDiagnostics: FeatureDiagnostics | null = null;
  private frameTimes: number[] = [];

  /** Live sample sink used by the calibration screens. */
  private sampleCollector: ((sample: CalibrationSample, gaze: GazeState, usable: boolean) => void) | null = null;

  private settings: TrackingSettings = { ...DEFAULT_TRACKING_SETTINGS };

  constructor(callbacks: TrackerCallbacks = {}) {
    this.callbacks = callbacks;
  }

  public setCallbacks(callbacks: TrackerCallbacks) {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  public updateSettings(newSettings: Partial<TrackingSettings>) {
    this.settings = { ...this.settings, ...newSettings };
    this.screenFilter.setParameters(this.settings.oneEuroMinCutoff, this.settings.oneEuroBeta);
  }

  public getSettings(): TrackingSettings {
    return this.settings;
  }

  public getStatus(): TrackerStatus {
    return this.status;
  }

  /**
   * Registers a sink that receives every usable frame as a calibration sample.
   * Calibration screens use this to collect a full dwell of data rather than a
   * single instant.
   */
  public collectSamples(sink: ((sample: CalibrationSample, gaze: GazeState, usable: boolean) => void) | null) {
    this.sampleCollector = sink;
  }

  public async initialize(): Promise<void> {
    this.disposed = false;
    try {
      this.setStatus('loading_model');

      const filesetResolver = await FilesetResolver.forVisionTasks(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
      );

      const baseOptions = {
        modelAssetPath:
          'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
      };

      // Prefer the GPU delegate, but fall back to CPU rather than failing
      // outright — plenty of clinic machines have no usable WebGL context.
      try {
        this.faceLandmarker = await FaceLandmarker.createFromOptions(filesetResolver, {
          baseOptions: { ...baseOptions, delegate: 'GPU' },
          runningMode: 'VIDEO',
          numFaces: 1,
          outputFaceBlendshapes: true,
          outputFacialTransformationMatrixes: true,
        });
      } catch (gpuErr) {
        console.warn('GPU delegate unavailable, falling back to CPU', gpuErr);
        this.faceLandmarker = await FaceLandmarker.createFromOptions(filesetResolver, {
          baseOptions: { ...baseOptions, delegate: 'CPU' },
          runningMode: 'VIDEO',
          numFaces: 1,
          outputFaceBlendshapes: true,
          outputFacialTransformationMatrixes: true,
        });
      }

      this.setStatus('requesting_camera');
      await this.startCamera();
      if (this.disposed) return;
      this.setStatus('running');
      this.startTrackingLoop();
    } catch (err: any) {
      console.error('Tracker initialisation failed:', err);
      this.setStatus('error', this.describeCameraError(err));
    }
  }

  private describeCameraError(err: any): string {
    const name = err?.name || '';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return 'The browser blocked camera access. Allow the camera for this site, then try again.';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return 'No camera was found. Connect a webcam, or continue with the mouse instead.';
    }
    if (name === 'NotReadableError') {
      return 'The camera is in use by another application. Close it and try again.';
    }
    return err?.message || 'The camera could not be started.';
  }

  private setStatus(status: TrackerStatus, errorMsg?: string) {
    this.status = status;
    this.callbacks.onStatusChange?.(status, errorMsg);
  }

  private async startCamera(): Promise<void> {
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
    }

    if (!this.videoElement) {
      const video = document.createElement('video');
      video.playsInline = true;
      video.autoplay = true;
      video.muted = true;
      video.setAttribute('style', 'position: fixed; top: -9999px; left: -9999px; opacity: 0; pointer-events: none;');
      document.body.appendChild(video);
      this.videoElement = video;
    }

    // Resolution is the cheapest accuracy win available. At 640×480 an eye is
    // roughly 60 px across, so one pixel of iris-centre noise is a large
    // fraction of a degree; at 1280×720 the same noise is worth about half as
    // much. Frame rate is capped at 30 because the extra frames cost detection
    // time we would rather spend on resolution.
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 1280, min: 640 },
        height: { ideal: 720, min: 480 },
        facingMode: 'user',
        frameRate: { ideal: 30, max: 30 },
      },
      audio: false,
    });

    this.stream = stream;
    this.videoElement.srcObject = stream;

    await new Promise<void>((resolve, reject) => {
      const video = this.videoElement!;
      const timeout = setTimeout(() => reject(new Error('The camera did not start in time.')), 12000);
      video.onloadedmetadata = () => {
        clearTimeout(timeout);
        video.play().then(() => resolve()).catch(reject);
      };
    });
  }

  public getVideoElement(): HTMLVideoElement | null {
    return this.videoElement;
  }

  /**
   * A snapshot of everything the tracker knows about its own inputs.
   *
   * Deliberately not part of GazeState: this is read a few times a second by a
   * panel, not sixty times a second by the render loop.
   */
  public getDiagnostics(): {
    features: FeatureDiagnostics | null;
    fps: number;
    resolution: { width: number; height: number } | null;
    headPose: HeadPose | null;
  } {
    return {
      features: this.lastDiagnostics,
      fps: this.frameTimes.length,
      resolution: this.getCaptureResolution(),
      headPose: this.lastHeadPose,
    };
  }

  /**
   * Releases the camera without tearing down the loaded model.
   *
   * The camera light going out is the point: someone sitting in front of an
   * idle therapy tool should not have a live camera pointed at them, and no
   * amount of "we do not send it anywhere" makes that feel different. The face
   * model costs a few seconds and a CDN fetch to load, so it stays in memory
   * and resuming takes about a second with no permission prompt.
   */
  public pause() {
    if (this.status === 'paused' || this.status === 'uninitialized') return;

    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
    }
    if (this.videoElement) this.videoElement.srcObject = null;

    this.lastVideoTime = -1;
    this.lastDiagnostics = null;
    this.frameTimes = [];
    gazeBus.clear();
    this.setStatus('paused');
  }

  /** Reopens the camera and restarts tracking. Safe to call when already running. */
  public async resume(): Promise<void> {
    if (this.status === 'running') return;
    if (!this.faceLandmarker) {
      await this.initialize();
      return;
    }

    try {
      this.disposed = false;
      this.setStatus('requesting_camera');
      await this.startCamera();
      if (this.disposed) return;

      // The filters and the fixation state describe a moment that has passed.
      this.featureFilter.reset();
      this.screenFilter.reset();
      this.prevVelocityPoint = null;
      this.lastSampleTime = 0;
      this.heldSince = null;

      this.setStatus('running');
      this.startTrackingLoop();
    } catch (err: any) {
      console.error('Resuming the camera failed:', err);
      this.setStatus('error', this.describeCameraError(err));
    }
  }

  /** Actual capture resolution, once the browser has picked one. */
  public getCaptureResolution(): { width: number; height: number } | null {
    const track = this.stream?.getVideoTracks()[0];
    if (!track) return null;
    const settings = track.getSettings();
    if (!settings.width || !settings.height) return null;
    return { width: settings.width, height: settings.height };
  }

  private startTrackingLoop() {
    const processFrame = () => {
      if (this.disposed) return;

      if (this.status !== 'running' || !this.faceLandmarker || !this.videoElement) {
        this.animationFrameId = requestAnimationFrame(processFrame);
        return;
      }

      const video = this.videoElement;
      if (video.readyState >= 2 && video.currentTime !== this.lastVideoTime) {
        this.lastVideoTime = video.currentTime;

        try {
          const results = this.faceLandmarker.detectForVideo(video, performance.now());
          const landmarks = results?.faceLandmarks?.[0];

          if (landmarks && landmarks.length > 0) {
            const blendshapes: Record<string, number> = {};
            for (const cat of results.faceBlendshapes?.[0]?.categories || []) {
              blendshapes[cat.categoryName] = cat.score;
            }
            const matrix = results.facialTransformationMatrixes?.[0]?.data;
            this.processFrame(landmarks, blendshapes, matrix);
            this.callbacks.onVideoFrame?.(video, landmarks);
          } else {
            this.emitLost();
            this.callbacks.onVideoFrame?.(video, null);
          }
        } catch (err) {
          // A dropped frame is normal under load; a persistent failure will
          // show up as a lost-tracking state rather than a crash.
          this.emitLost();
        }
      }

      this.animationFrameId = requestAnimationFrame(processFrame);
    };

    this.animationFrameId = requestAnimationFrame(processFrame);
  }

  private emitLost() {
    if (this.simulatedPointer) return;
    this.event = 'lost';
    const gaze = this.buildGazeState({
      screen: this.lastGoodScreen,
      feature: this.lastFeature,
      headPose: this.lastHeadPose,
      confidence: 0,
      isHeld: true,
      heldForMs: HELD_GRACE_MS + 1,
      blinkingLeft: false,
      blinkingRight: false,
      event: 'lost',
      now: Date.now(),
    });
    gazeBus.publish(gaze);
  }

  private processFrame(landmarks: any[], blendshapes: Record<string, number>, matrix?: Float32Array | number[]) {
    const now = Date.now();
    // The extractor cannot know the shape of the image it is measuring, and its
    // landmarks are normalised per axis, so the aspect ratio has to travel with
    // them or every length it computes is stretched vertically.
    const video = this.videoElement;
    const aspect =
      video && video.videoWidth > 0 && video.videoHeight > 0
        ? video.videoWidth / video.videoHeight
        : undefined;
    const extracted = extractGazeFeatures(landmarks, blendshapes, matrix, aspect);
    if (!extracted) {
      this.emitLost();
      return;
    }

    const { features, headPose, diagnostics } = extracted;
    this.lastHeadPose = headPose;
    this.lastDiagnostics = diagnostics;

    // Rolling frame rate over the last second, for the diagnostics readout.
    this.frameTimes.push(now);
    while (this.frameTimes.length > 0 && now - this.frameTimes[0] > 1000) this.frameTimes.shift();
    viewingGeometry.setMeasuredDistanceCm(headPose.distanceCm, headPose.distanceAgreement);

    // --- Blink bookkeeping ---------------------------------------------------
    const blinkingBoth = features.isBlinkingBoth;
    if (blinkingBoth && !this.lastBlinkBoth) {
      if (now - this.lastBlinkTime > 250) {
        this.blinkCount++;
        this.lastBlinkTime = now;
        this.callbacks.onBlink?.('both');
        // No sound. This used to play a descending click on every blink, which
        // at fifteen blinks a minute is an alarm going off every four seconds
        // telling the client that an involuntary reflex was a problem. The
        // visual side of exactly this was fixed a while ago — the pointer stops
        // dimming, the trail stops dropping — and the audio was missed, which is
        // why the tool still *felt* like it lost tracking on every blink even
        // though it had long since stopped doing so. The count is kept: blink
        // rate is a real clinical measure, and counting is not announcing.
      }
    } else if (!blinkingBoth && this.lastBlinkBoth) {
      this.lastBlinkEndTime = now;
    }

    if (features.isBlinkingLeft && !this.lastBlinkLeft && !blinkingBoth) this.callbacks.onBlink?.('left');
    if (features.isBlinkingRight && !this.lastBlinkRight && !blinkingBoth) this.callbacks.onBlink?.('right');

    this.lastBlinkBoth = blinkingBoth;
    this.lastBlinkLeft = features.isBlinkingLeft;
    this.lastBlinkRight = features.isBlinkingRight;

    // Both eyes closing far enough to distrust the estimate, which happens
    // earlier than either reads as a blink.
    const lidsClosing =
      Math.max(features.eyeOpenLeft, features.eyeOpenRight) < GAZE_TRUST_OPENNESS;

    const inBlinkShadow =
      blinkingBoth || lidsClosing || now - this.lastBlinkEndTime < POST_BLINK_HOLD_MS;

    // --- Choose the eye measurement to map -----------------------------------
    const mode = this.settings.trackingEngineMode || 'binocular';
    let gx = features.gx;
    let gy = features.gy;

    if (mode === 'left_eye' && features.leftGx !== null && features.leftGy !== null) {
      gx = features.leftGx;
      gy = features.leftGy;
    } else if (mode === 'right_eye' && features.rightGx !== null && features.rightGy !== null) {
      gx = features.rightGx;
      gy = features.rightGy;
    } else if (mode === 'head_pointer') {
      // Head pointing, for users whose eye movement is unreliable or who are
      // being assessed on head control rather than gaze.
      gx = headPose.yaw * 0.25;
      gy = -headPose.pitch * 0.25;
    }

    if (this.settings.invertX) gx = -gx;
    if (this.settings.invertY) gy = -gy;

    const filteredFeature = this.featureFilter.filter(gx, gy, now);
    this.lastFeature = filteredFeature;

    const confidence = mode === 'head_pointer' ? 0.9 : features.quality;

    // --- Offer the frame to any active calibration screen --------------------
    // Samples are offered before blink gating so the collector can see, and
    // reject, exactly the same frames the mapping would reject.
    const usableForCalibration = !inBlinkShadow && confidence >= this.settings.minConfidence;

    // --- Map to the screen ---------------------------------------------------
    const scrW = window.innerWidth;
    const scrH = window.innerHeight;

    const mapped = calibrationEngine.mapToScreen(
      filteredFeature.x,
      filteredFeature.y,
      features.lidGy,
      headPose,
      scrW,
      scrH,
      this.settings.sensitivityX,
      this.settings.sensitivityY
    );

    let screen: Point2D;
    let isHeld = false;

    if (!mapped) {
      // Uncalibrated: a plain linear guess, deliberately gentle, so the user can
      // see that tracking is alive without mistaking it for a working mapping.
      screen = {
        x: scrW * (0.5 + filteredFeature.x * 3.2 * this.settings.sensitivityX),
        y: scrH * (0.5 + filteredFeature.y * 3.6 * this.settings.sensitivityY),
      };
    } else {
      screen = mapped;
    }

    if (inBlinkShadow && this.settings.holdThroughBlinks) {
      // Hold the last confident estimate rather than following the lids down.
      screen = this.lastGoodScreen;
      isHeld = true;
    } else if (confidence < this.settings.minConfidence) {
      screen = this.lastGoodScreen;
      isHeld = true;
    }

    screen = {
      x: Math.max(0, Math.min(scrW, screen.x)),
      y: Math.max(0, Math.min(scrH, screen.y)),
    };

    // Deadzone: hold still through sub-threshold tremor so a resting gaze does
    // not visibly shimmer.
    const travel = Math.hypot(screen.x - this.lastScreen.x, screen.y - this.lastScreen.y);
    const targetX = travel < this.settings.deadzone ? this.lastScreen.x : screen.x;
    const targetY = travel < this.settings.deadzone ? this.lastScreen.y : screen.y;

    // The filter keeps running while the estimate is held, fed the held
    // position. Bypassing it left its notion of time stale, so the first real
    // sample after a blink arrived with a large gap, took a near-unity
    // smoothing weight, and snapped — which is the visible jolt on reopening
    // the eyes. Kept warm, it eases back instead.
    const holdTarget = isHeld ? this.lastGoodScreen : { x: targetX, y: targetY };
    const filtered = this.screenFilter.filter(holdTarget.x, holdTarget.y, now);

    this.lastScreen = filtered;
    if (!isHeld) this.lastGoodScreen = filtered;

    if (isHeld) {
      if (this.heldSince === null) this.heldSince = now;
    } else {
      this.heldSince = null;
    }
    const heldForMs = this.heldSince === null ? 0 : now - this.heldSince;

    // --- Velocity-based event classification (I-VT) --------------------------
    const dtSec = this.lastSampleTime > 0 ? Math.max(0.008, (now - this.lastSampleTime) / 1000) : 0.033;
    this.lastSampleTime = now;

    const previous = this.prevVelocityPoint ?? filtered;
    const travelDeg = viewingGeometry.pixelsToDegrees(
      Math.hypot(filtered.x - previous.x, filtered.y - previous.y)
    );
    this.prevVelocityPoint = { x: filtered.x, y: filtered.y };
    const instantVelocity = travelDeg / dtSec;
    // Light smoothing so a single noisy frame cannot flip the classification.
    this.velocityDegPerSec = this.velocityDegPerSec * 0.6 + instantVelocity * 0.4;

    let event: OcularEvent;
    if (inBlinkShadow) {
      event = 'blink';
      // The fixation clock is deliberately *not* reset here. Clearing it meant
      // every blink was followed by a fresh run-up to the fixation threshold,
      // so a steady gaze was reclassified as a saccade for a moment each time
      // the client blinked — fifteen times a minute, on a held estimate that had
      // not moved. Everything keyed off fixation flinched with it: the pointer
      // shrank, the fixation centre was thrown away, and a held target read as
      // momentarily lost. The eyes were never lost; only the label was.
    } else if (this.velocityDegPerSec > this.settings.saccadeVelocityThreshold) {
      event = 'saccade';
      this.slowSinceMs = null;
    } else {
      if (this.slowSinceMs === null) this.slowSinceMs = now;
      event = now - this.slowSinceMs >= FIXATION_ONSET_MS ? 'fixation' : 'saccade';
    }

    if (event === 'fixation') {
      // Resuming after a blink continues the fixation it interrupted rather
      // than starting a new one, so a blink does not split one dwell into two.
      if (this.event !== 'fixation' && this.event !== 'blink') {
        this.fixationStart = this.slowSinceMs ?? now;
        this.fixationPoints = [];
      }
      this.fixationPoints.push({ x: filtered.x, y: filtered.y, time: now });
      if (this.fixationPoints.length > 120) this.fixationPoints.shift();
      const cx = this.fixationPoints.reduce((s, p) => s + p.x, 0) / this.fixationPoints.length;
      const cy = this.fixationPoints.reduce((s, p) => s + p.y, 0) / this.fixationPoints.length;
      this.fixationCentre = { x: cx, y: cy };
    } else if (event === 'saccade') {
      this.fixationCentre = null;
      this.fixationPoints = [{ x: filtered.x, y: filtered.y, time: now }];
    }

    this.event = event;

    // --- Optional grid snap ---------------------------------------------------
    let finalX = filtered.x;
    let finalY = filtered.y;
    let isSnapped = false;

    if (this.settings.snapToGrid && event === 'fixation') {
      const gridSize = this.settings.gridSnapSize || 40;
      finalX = Math.round(filtered.x / gridSize) * gridSize;
      finalY = Math.round(filtered.y / gridSize) * gridSize;
      isSnapped = true;

      if (!this.lastSnappedTarget || this.lastSnappedTarget.x !== finalX || this.lastSnappedTarget.y !== finalY) {
        this.lastSnappedTarget = { x: finalX, y: finalY };
        soundEngine.playGridSnapTick();
      }
    } else {
      this.lastSnappedTarget = null;
    }

    const gaze = this.buildGazeState({
      screen: { x: finalX, y: finalY },
      feature: filteredFeature,
      headPose,
      confidence,
      isHeld,
      heldForMs,
      blinkingLeft: features.isBlinkingLeft,
      blinkingRight: features.isBlinkingRight,
      event,
      now,
      isSnapped,
    });

    // The sink sees every frame, usable or not, so calibration screens can
    // report an honest "eyes found" percentage rather than one computed only
    // from the frames that already succeeded.
    if (this.sampleCollector) {
      this.sampleCollector(
        {
          gx: filteredFeature.x,
          gy: filteredFeature.y,
          lidGy: features.lidGy,
          headYaw: headPose.yaw,
          headPitch: headPose.pitch,
          headTranslateX: headPose.translateX,
          headTranslateY: headPose.translateY,
          quality: confidence,
        },
        gaze,
        usableForCalibration
      );
    }

    gazeBus.publish(gaze);
  }

  private buildGazeState(args: {
    screen: Point2D;
    feature: Point2D;
    headPose: HeadPose | null;
    confidence: number;
    isHeld: boolean;
    heldForMs?: number;
    blinkingLeft: boolean;
    blinkingRight: boolean;
    event: OcularEvent;
    now: number;
    isSnapped?: boolean;
  }): GazeState {
    const scrW = window.innerWidth;
    const scrH = window.innerHeight;

    return {
      screenX: args.screen.x,
      screenY: args.screen.y,
      normX: Math.max(0, Math.min(1, args.screen.x / scrW)),
      normY: Math.max(0, Math.min(1, args.screen.y / scrH)),
      gx: args.feature.x,
      gy: args.feature.y,
      snappedX: args.isSnapped ? args.screen.x : undefined,
      snappedY: args.isSnapped ? args.screen.y : undefined,
      isSnapped: args.isSnapped,
      isBlinkingLeft: args.blinkingLeft,
      isBlinkingRight: args.blinkingRight,
      isBlinkingBoth: args.blinkingLeft && args.blinkingRight,
      blinkCount: this.blinkCount,
      event: args.event,
      isFixating: args.event === 'fixation',
      velocityDegPerSec: this.velocityDegPerSec,
      fixationCentre: this.fixationCentre ?? undefined,
      fixationDurationMs: args.event === 'fixation' ? args.now - this.fixationStart : 0,
      confidence: args.confidence,
      isHeld: args.isHeld,
      heldForMs: args.heldForMs ?? 0,
      /**
       * Whether the hold has lasted long enough to be worth showing. A blink is
       * ridden out silently; losing the face for half a second is not.
       */
      isVisiblyInterrupted: (args.heldForMs ?? 0) > HELD_GRACE_MS,
      headPose:
        args.headPose ?? {
          yaw: 0,
          pitch: 0,
          roll: 0,
          translateX: 0,
          translateY: 0,
          distanceCm: null,
          distanceAgreement: 0,
          interocularSpan: 0,
        },
      timestamp: args.now,
    };
  }

  /**
   * Mouse fallback, so the whole app remains usable without a camera.
   *
   * A real tracker emits samples continuously whether or not the eye is moving,
   * and anything downstream that reasons about time — fixation detection, dwell
   * timing, the reading analysis — depends on that. Pointer events only fire
   * while the mouse is moving, so this records the position and lets a steady
   * loop publish it, rather than publishing one sample per event and leaving
   * every pause in the recording as a gap.
   */
  public simulateGazeFromPointer(clientX: number, clientY: number) {
    this.simulatedPointer = true;
    this.pointerPosition = { x: clientX, y: clientY };
    if (this.pointerLoopId === null) this.startPointerLoop();
  }

  private startPointerLoop() {
    const SAMPLE_INTERVAL_MS = 1000 / 30;
    let lastEmit = 0;

    const loop = () => {
      if (this.disposed || !this.simulatedPointer) {
        this.pointerLoopId = null;
        return;
      }
      const now = performance.now();
      if (this.pointerPosition && now - lastEmit >= SAMPLE_INTERVAL_MS) {
        lastEmit = now;
        this.emitPointerSample(this.pointerPosition.x, this.pointerPosition.y);
      }
      this.pointerLoopId = requestAnimationFrame(loop);
    };

    this.pointerLoopId = requestAnimationFrame(loop);
  }

  private emitPointerSample(clientX: number, clientY: number) {
    const now = Date.now();
    const dtSec = this.lastSampleTime > 0 ? Math.max(0.008, (now - this.lastSampleTime) / 1000) : 0.033;
    this.lastSampleTime = now;

    const travelDeg = viewingGeometry.pixelsToDegrees(
      Math.hypot(clientX - this.lastScreen.x, clientY - this.lastScreen.y)
    );
    this.velocityDegPerSec = this.velocityDegPerSec * 0.6 + (travelDeg / dtSec) * 0.4;
    this.prevVelocityPoint = { x: clientX, y: clientY };

    const event: OcularEvent =
      this.velocityDegPerSec > this.settings.saccadeVelocityThreshold ? 'saccade' : 'fixation';

    if (event === 'fixation') {
      if (this.event !== 'fixation') {
        this.fixationStart = now;
        this.fixationPoints = [];
      }
      this.fixationPoints.push({ x: clientX, y: clientY, time: now });
      if (this.fixationPoints.length > 120) this.fixationPoints.shift();
      this.fixationCentre = {
        x: this.fixationPoints.reduce((s, p) => s + p.x, 0) / this.fixationPoints.length,
        y: this.fixationPoints.reduce((s, p) => s + p.y, 0) / this.fixationPoints.length,
      };
    } else {
      this.fixationCentre = null;
      this.fixationPoints = [{ x: clientX, y: clientY, time: now }];
    }
    this.event = event;

    this.lastScreen = { x: clientX, y: clientY };
    this.lastGoodScreen = this.lastScreen;

    const headPose: HeadPose = {
      yaw: 0,
      pitch: 0,
      roll: 0,
      translateX: 0,
      translateY: 0,
      distanceCm: viewingGeometry.getSettings().assumedDistanceCm,
      distanceAgreement: 1,
      interocularSpan: 0.1,
    };

    const gaze = this.buildGazeState({
      screen: this.lastScreen,
      feature: { x: (clientX / window.innerWidth - 0.5) * 0.2, y: (clientY / window.innerHeight - 0.5) * 0.2 },
      headPose,
      confidence: 1,
      isHeld: false,
      blinkingLeft: false,
      blinkingRight: false,
      event,
      now,
    });

    if (this.sampleCollector) {
      this.sampleCollector(
        {
          gx: gaze.gx,
          gy: gaze.gy,
          lidGy: null,
          headYaw: 0,
          headPitch: 0,
          headTranslateX: 0,
          headTranslateY: 0,
          quality: 1,
        },
        gaze,
        true
      );
    }

    gazeBus.publish(gaze);
  }

  public setSimulatedPointer(enabled: boolean) {
    this.simulatedPointer = enabled;
    if (!enabled && this.pointerLoopId !== null) {
      cancelAnimationFrame(this.pointerLoopId);
      this.pointerLoopId = null;
    }
  }

  public dispose() {
    this.disposed = true;
    if (this.pointerLoopId !== null) {
      cancelAnimationFrame(this.pointerLoopId);
      this.pointerLoopId = null;
    }
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
    }
    if (this.videoElement?.parentNode) {
      this.videoElement.parentNode.removeChild(this.videoElement);
    }
    this.videoElement = null;
    if (this.faceLandmarker) {
      this.faceLandmarker.close();
      this.faceLandmarker = null;
    }
    this.featureFilter.reset();
    this.screenFilter.reset();
    gazeBus.clear();
  }
}
