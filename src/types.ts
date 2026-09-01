export interface Point2D {
  x: number;
  y: number;
  time?: number;
  pressure?: number;
}

export interface EyeLandmarks {
  irisLeft: { x: number; y: number; z: number };
  irisRight: { x: number; y: number; z: number };
  leftEyeCorners: { inner: Point2D; outer: Point2D };
  rightEyeCorners: { inner: Point2D; outer: Point2D };
  leftEyeUpperLower: { upper: Point2D; lower: Point2D };
  rightEyeUpperLower: { upper: Point2D; lower: Point2D };
}

export interface HeadPose {
  pitch: number; // up/down
  yaw: number;   // left/right
  roll: number;  // tilt
}

export interface GazeState {
  screenX: number;
  screenY: number;
  normX: number; // 0 to 1
  normY: number; // 0 to 1
  rawX: number;
  rawY: number;
  snappedX?: number;
  snappedY?: number;
  isSnapped?: boolean;
  isBlinkingLeft: boolean;
  isBlinkingRight: boolean;
  isBlinkingBoth: boolean;
  blinkCount: number;
  isFixating: boolean;
  confidence: number;
  headPose: HeadPose;
  timestamp: number;
}

export interface CalibrationSample {
  rawX: number;
  rawY: number;
  headYaw: number;
  headPitch: number;
}

export interface CalibrationTarget {
  id: number;
  label: string;
  xPercent: number; // 0 to 100%
  yPercent: number; // 0 to 100%
  samples: CalibrationSample[];
  status: 'pending' | 'sampling' | 'completed';
}

export interface QuadraticCoefficients {
  a: number[]; // [a0, a1, a2, a3, a4, a5] for X = a0 + a1*x + a2*y + a3*x^2 + a4*y^2 + a5*x*y
  b: number[]; // [b0, b1, b2, b3, b4, b5] for Y = b0 + b1*x + b2*y + b3*x^2 + b4*y^2 + b5*x*y
}

export interface CalibrationModel {
  isCalibrated: boolean;
  isCenterCalibrated?: boolean;
  lastCalibratedAt?: number;
  centerOffsetX?: number;
  centerOffsetY?: number;
  centerHeadYaw?: number;
  centerHeadPitch?: number;
  quadraticCoeffs?: QuadraticCoefficients;
  affineMatrix?: {
    a: number; b: number; c: number;
    d: number; e: number; f: number;
  };
  offsetX: number;
  offsetY: number;
  scaleX: number;
  scaleY: number;
  gridOffsets?: { [key: number]: { dx: number; dy: number } };
}

export type PenActivationMode = 'auto_stream' | 'blink_toggle' | 'dwell_trigger' | 'hold_space' | 'always_on';
export type TrackingEngineMode = 'hybrid_gaze' | 'iris_only' | 'head_laser';
export type DrawingToolMode = 'freehand' | 'straight_laser' | 'ortho_ruler' | 'shapes' | 'polyline';
export type ShapeKind = 'rectangle' | 'circle' | 'triangle' | 'arrow';

export interface TrackingSettings {
  smoothingFactor: number;       // legacy fallback / speed scale
  oneEuroMinCutoff: number;      // 1€ filter min cutoff in Hz (0.2 to 2.5)
  oneEuroBeta: number;           // 1€ filter velocity coefficient (0.005 to 0.2)
  saccadeThreshold: number;      // threshold to bypass smoothing on fast eye jump
  sensitivityX: number;          // 0.5 to 3.0
  sensitivityY: number;          // 0.5 to 3.0
  deadzone: number;              // micro-jitter threshold (0 to 30px)
  nudgeOffsetX?: number;         // real-time pixel offset nudge (-200 to +200)
  nudgeOffsetY?: number;         // real-time pixel offset nudge (-200 to +200)
  trackingEngineMode?: TrackingEngineMode; // Hybrid Gaze vs Pure Iris vs Head-Laser Pointer
  magneticSnapAssist?: boolean;  // magnetic target gravity well assist
  magneticSnapRadius?: number;   // magnetic radius in px (default 120)
  snapToGrid: boolean;           // snap coordinate to grid when fixating
  gridSnapSize: number;          // grid size in px (e.g. 20, 40, 60)
  dwellDurationMs: number;       // time to trigger dwell click/action
  invertX: boolean;
  invertY: boolean;
  useHeadCompensation: boolean;
  useQuadraticMapping: boolean;  // 2nd-degree polynomial mapping toggle
  penMode: PenActivationMode;
  audioEnabled: boolean;
  showWebcamPiP: boolean;
  showLandmarkMesh: boolean;
  showGazeTrail: boolean;
  showGazeReticle: boolean;
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
  | 'single_line'      // Primary requested feature: Draw a single continuous eye-tracked line
  | 'constellation'    // Connect stars in sequence using single gaze stroke
  | 'maze'             // Guide gaze through a labyrinth without touching bounds
  | 'target_pop'       // Focus & dwell to burst celestial orbs
  | 'quick_type'       // Gaze dwell on intuitive radial / grid letterboard
  | 'reading_analysis';// Track reading fixations, regressions, WPM, and head movement

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
  dwellProgress: number; // 0 to 1
  isPopped: boolean;
  pulsePhase: number;
}
