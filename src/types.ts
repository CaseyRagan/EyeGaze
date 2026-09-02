export interface Point2D {
  x: number;
  y: number;
  time?: number;
  pressure?: number;
}

export interface HeadPose {
  /** Radians. Positive = turned toward the screen's right. */
  yaw: number;
  /** Radians. Positive = chin raised. */
  pitch: number;
  /** Radians. Positive = head tilted toward the screen's right. */
  roll: number;
  /** Face centre offset from the image centre, in normalised image units. */
  translateX: number;
  translateY: number;
  /** Estimated eye-to-camera distance in cm, or null when not measurable. */
  distanceCm: number | null;
  /** 0-1. How closely the two independent distance estimates agreed. */
  distanceAgreement: number;
  /** Distance between the eye centres in normalised image units. */
  interocularSpan: number;
}

/** The scale-, roll- and foreshortening-invariant eye measurements we regress on. */
export interface GazeFeatures {
  gx: number;
  gy: number;
  leftGx: number | null;
  leftGy: number | null;
  rightGx: number | null;
  rightGy: number | null;
  /** 0 = closed, 1 = comfortably open. */
  eyeOpenLeft: number;
  eyeOpenRight: number;
  isBlinkingLeft: boolean;
  isBlinkingRight: boolean;
  isBlinkingBoth: boolean;
  /** How far the two eyes' independent estimates disagree. */
  binocularDisagreement: number;
  /** 0–1 estimate of how trustworthy this frame is. */
  quality: number;
}

export type OcularEvent = 'fixation' | 'saccade' | 'blink' | 'lost';

export interface GazeState {
  screenX: number;
  screenY: number;
  normX: number;
  normY: number;
  /** The underlying eye measurement for this frame. */
  gx: number;
  gy: number;
  snappedX?: number;
  snappedY?: number;
  isSnapped?: boolean;
  isBlinkingLeft: boolean;
  isBlinkingRight: boolean;
  isBlinkingBoth: boolean;
  blinkCount: number;
  /** Classified by velocity (I-VT), not by a fixed pixel box. */
  event: OcularEvent;
  isFixating: boolean;
  /** Gaze velocity in degrees of visual angle per second. */
  velocityDegPerSec: number;
  /** Where the current fixation began, and how long it has lasted. */
  fixationCentre?: Point2D;
  fixationDurationMs: number;
  /** 0–1. Reflects eye openness, binocular agreement and head pose. */
  confidence: number;
  /** True while the estimate is being held through a blink rather than measured. */
  isHeld: boolean;
  /** How long the current run of held frames has lasted, in ms. */
  heldForMs: number;
  /**
   * True only once a hold has outlasted an ordinary blink. Anything shown to
   * the user should key off this rather than isHeld, so a reflex the client
   * cannot control is not reported back to them as a fault.
   */
  isVisiblyInterrupted: boolean;
  headPose: HeadPose;
  timestamp: number;
}

export interface CalibrationSample {
  gx: number;
  gy: number;
  headYaw: number;
  headPitch: number;
  headTranslateX: number;
  headTranslateY: number;
  quality: number;
}

export interface CalibrationTarget {
  id: number;
  label: string;
  xPercent: number;
  yPercent: number;
  samples: CalibrationSample[];
  status: 'pending' | 'sampling' | 'completed';
}

/** One anchor: a screen location plus the averaged eye measurement that produced it. */
export interface CalibrationAnchor {
  id: string;
  /** Stored as a fraction of the viewport so a window resize does not invalidate it. */
  xNorm: number;
  yNorm: number;
  gx: number;
  gy: number;
  headYaw: number;
  headPitch: number;
  headTranslateX: number;
  headTranslateY: number;
  /** Spread of the samples that produced this anchor, in feature units. */
  dispersion: number;
  sampleCount: number;
  label?: string;
  timestamp: number;
}

export interface RegressionModel {
  /** Which feature set this model was fitted with; see featureDegreeForAnchorCount. */
  degree: number;
  /** The head pose the model was fitted at; head compensation is relative to it. */
  reference: { yaw: number; pitch: number; translateX: number; translateY: number };
  /** Fitted multipliers on the nominal head-compensation constants. */
  headGain: { rotation: number; translation: number };
  /** Weights for the standardised design matrix, one set per output axis. */
  weightsX: number[];
  weightsY: number[];
  featureMean: number[];
  featureStd: number[];
  /** Residuals at each anchor, used for the local correction term. */
  residuals: Array<{ gx: number; gy: number; dx: number; dy: number }>;
  /** Kernel width for the local correction, in feature units. */
  kernelSigma: number;
}

export interface CalibrationQuality {
  /** Mean absolute error at the calibration points themselves (leave-one-out). */
  crossValidatedErrorPx: number;
  crossValidatedErrorDeg: number;
  anchorCount: number;
  /** Whether the anchors actually span the screen, or cluster in one region. */
  coverage: number;
}

export interface ValidationPointResult {
  id: string;
  xNorm: number;
  yNorm: number;
  /** Mean offset between the estimate and the true target, in px. */
  errorPx: number;
  errorDeg: number;
  offsetX: number;
  offsetY: number;
  /** Sample-to-sample scatter, in px and degrees. */
  precisionPx: number;
  precisionDeg: number;
  sampleCount: number;
}

export interface ValidationResult {
  points: ValidationPointResult[];
  accuracyPx: number;
  accuracyDeg: number;
  precisionPx: number;
  precisionDeg: number;
  /** Fraction of frames during validation that produced a usable estimate. */
  trackingRatio: number;
  distanceCm: number | null;
  distanceWasMeasured: boolean;
  timestamp: number;
  grade: 'excellent' | 'good' | 'fair' | 'poor';
}

/** The head pose recorded at calibration time, used to detect later drift. */
export interface CalibrationPosture {
  yaw: number;
  pitch: number;
  roll: number;
  translateX: number;
  translateY: number;
  interocularSpan: number;
  distanceCm: number | null;
}

export interface CalibrationModel {
  isCalibrated: boolean;
  /** Person-specific multipliers on the head-compensation constants. */
  headGain?: { rotation: number; translation: number };
  lastCalibratedAt?: number;
  regression?: RegressionModel;
  quality?: CalibrationQuality;
  posture?: CalibrationPosture;
  validation?: ValidationResult;
  /** Manual bias correction applied after the model, in normalised units. */
  nudgeXNorm: number;
  nudgeYNorm: number;
}

export interface PostureDrift {
  /** How far the head has moved sideways/vertically since calibration, in cm. */
  lateralCm: number;
  /** Change in distance from the screen since calibration, in cm. */
  depthCm: number;
  /** Change in head rotation since calibration, in degrees. */
  rotationDeg: number;
  /** 0–1, where 1 is exactly the calibrated posture. */
  stability: number;
  severity: 'good' | 'drifting' | 'recalibrate';
}

export type ActivationMode = 'dwell' | 'blink' | 'switch' | 'always_on';
export type TrackingEngineMode = 'binocular' | 'left_eye' | 'right_eye' | 'head_pointer';
export type DrawingToolMode = 'freehand' | 'straight_laser' | 'ortho_ruler' | 'shapes' | 'polyline';
export type ShapeKind = 'rectangle' | 'circle' | 'triangle' | 'arrow';
export type PenActivationMode = 'auto_stream' | 'blink_toggle' | 'dwell_trigger' | 'hold_space' | 'always_on';

export interface TrackingSettings {
  /** 1€ filter parameters: lower cutoff = steadier, higher beta = quicker. */
  oneEuroMinCutoff: number;
  oneEuroBeta: number;
  /** Velocity threshold separating fixations from saccades, in deg/s. */
  saccadeVelocityThreshold: number;
  /** Extra gain applied around the screen centre after mapping. */
  sensitivityX: number;
  sensitivityY: number;
  deadzone: number;
  nudgeOffsetX?: number;
  nudgeOffsetY?: number;
  trackingEngineMode?: TrackingEngineMode;
  magneticSnapAssist?: boolean;
  magneticSnapRadius?: number;
  snapToGrid: boolean;
  gridSnapSize: number;
  dwellDurationMs: number;
  invertX: boolean;
  invertY: boolean;
  /** Hold the last estimate through blinks instead of letting it jump. */
  holdThroughBlinks: boolean;
  /** Drop frames whose confidence falls below this threshold. */
  minConfidence: number;
  penMode: PenActivationMode;
  audioEnabled: boolean;
  showWebcamPiP: boolean;
  showLandmarkMesh: boolean;
  showGazeTrail: boolean;
  showGazeReticle: boolean;
  showPostureGuide: boolean;
  strokeColor: string;
  strokeGlowColor: string;
  strokeWidth: number;
}

export interface DrawingStroke {
  id: string;
  points: Point2D[];
  color: string;
  glowColor: string;
  width: number;
  createdAt: number;
  totalLength: number;
}

export type ActivityMode =
  | 'single_line'
  | 'constellation'
  | 'maze'
  | 'target_pop'
  | 'quick_type'
  | 'reading_analysis';

export interface ConstellationStar {
  id: number;
  x: number;
  y: number;
  name: string;
  radius: number;
  connected: boolean;
  isNext: boolean;
}

export interface ConstellationLevel {
  id: string;
  title: string;
  subtitle: string;
  stars: { id: number; x: number; y: number; name: string }[];
  connections: [number, number][];
}

export interface MazeWall {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface TargetOrb {
  id: string;
  x: number;
  y: number;
  radius: number;
  color: string;
  value: number;
  dwellProgress: number;
  isPopped: boolean;
  pulsePhase: number;
}
