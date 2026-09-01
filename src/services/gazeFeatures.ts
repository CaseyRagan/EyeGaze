import { GazeFeatures, HeadPose } from '../types';

/**
 * Turns a frame of MediaPipe face landmarks into the small set of numbers the
 * calibration model actually regresses on.
 *
 * Three properties matter more than anything else here, because they are what
 * make a mapping learned in one moment still valid a minute later:
 *
 *  1. **Scale invariance.** Every eye measurement is a ratio of two distances
 *     measured on the same eye, so moving nearer to or further from the camera
 *     does not move the feature. (An earlier version normalised the vertical
 *     component by the eyelid aperture, which meant every blink, squint and
 *     raised eyebrow shifted the vertical gaze estimate. That is fixed here:
 *     both axes are normalised by the eye's corner-to-corner width, which is a
 *     property of the socket rather than the lid.)
 *
 *  2. **Roll invariance.** Offsets are measured in a basis built from the line
 *     between the two eyes, so tilting the head rotates the basis with it
 *     instead of shearing the gaze estimate.
 *
 *  3. **Foreshortening invariance.** When the head turns, the iris offset and
 *     the eye width project onto the image by the same cosine factor, so their
 *     ratio survives moderate head rotation unchanged.
 */

// Landmark indices in MediaPipe's 478-point face mesh.
const EYE_A = { outer: 33, inner: 133, top: 159, bottom: 145, iris: 468, irisRing: [469, 470, 471, 472] };
const EYE_B = { outer: 263, inner: 362, top: 386, bottom: 374, iris: 473, irisRing: [474, 475, 476, 477] };

/** Physical iris diameter is near-constant across adults (Caucasian norm ~11.7 mm). */
const IRIS_DIAMETER_MM = 11.7;
/** Assumed webcam horizontal field of view; only used for the fallback distance estimate. */
const ASSUMED_HFOV_DEG = 60;

interface Vec2 {
  x: number;
  y: number;
}

interface EyeMeasurement {
  gx: number;
  gy: number;
  width: number;
  openness: number;
  irisRadius: number;
  centre: Vec2;
  valid: boolean;
}

function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

function dot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y;
}

function norm(v: Vec2): number {
  return Math.hypot(v.x, v.y);
}

/**
 * Mirrors the horizontal axis so the landmark frame matches what the user sees.
 * After this, "the user looked toward the right of the screen" and "the irises
 * moved toward larger x" agree, which keeps every downstream sign convention
 * readable.
 */
function mirrored(landmark: { x: number; y: number }): Vec2 {
  return { x: 1 - landmark.x, y: landmark.y };
}

function measureEye(landmarks: any[], spec: typeof EYE_A, basisU: Vec2, basisV: Vec2): EyeMeasurement | null {
  const outer = landmarks[spec.outer];
  const inner = landmarks[spec.inner];
  const top = landmarks[spec.top];
  const bottom = landmarks[spec.bottom];
  const iris = landmarks[spec.iris];
  if (!outer || !inner || !top || !bottom || !iris) return null;

  const o = mirrored(outer);
  const i = mirrored(inner);
  const t = mirrored(top);
  const b = mirrored(bottom);
  const ir = mirrored(iris);

  const width = norm(sub(i, o));
  if (width < 1e-5) return null;

  // The two canthi sit near the vertical centre of the palpebral fissure and,
  // unlike the lid margins, they do not move when the eye blinks — which makes
  // their midpoint the right origin for a blink-immune vertical measurement.
  const centre: Vec2 = { x: (o.x + i.x) / 2, y: (o.y + i.y) / 2 };

  const offset = sub(ir, centre);
  const gx = dot(offset, basisU) / width;
  const gy = dot(offset, basisV) / width;

  // Aperture as a fraction of eye width: ~0.3 wide open, ~0.05 closed.
  const openness = norm(sub(b, t)) / width;

  let irisRadius = 0;
  let ringSamples = 0;
  for (const idx of spec.irisRing) {
    const p = landmarks[idx];
    if (!p) continue;
    irisRadius += norm(sub(mirrored(p), ir));
    ringSamples++;
  }
  irisRadius = ringSamples > 0 ? irisRadius / ringSamples : 0;

  return { gx, gy, width, openness, irisRadius, centre, valid: true };
}

/**
 * Decomposes MediaPipe's 4×4 facial transformation matrix (column-major,
 * canonical-face-to-camera) into intrinsic yaw-pitch-roll and a translation.
 * Returns null when the matrix is absent or degenerate.
 */
function decomposeTransform(matrix?: Float32Array | number[]): {
  yaw: number;
  pitch: number;
  roll: number;
  distanceCm: number;
} | null {
  if (!matrix || matrix.length < 16) return null;

  const r00 = matrix[0], r10 = matrix[1], r20 = matrix[2];
  const r11 = matrix[5], r12 = matrix[9];
  const r02 = matrix[8], r22 = matrix[10];
  const tz = matrix[14];

  if (![r00, r10, r20, r11, r12, r02, r22, tz].every(Number.isFinite)) return null;

  const clampedPitch = Math.max(-1, Math.min(1, -r12));
  const yaw = Math.atan2(r02, r22);
  const pitch = Math.asin(clampedPitch);
  const roll = Math.atan2(r10, r11);

  // The canonical face model is expressed in centimetres, so the translation's
  // depth component is directly a distance estimate.
  const distanceCm = Math.abs(tz);

  return { yaw, pitch, roll, distanceCm };
}

export interface ExtractionResult {
  features: GazeFeatures;
  headPose: HeadPose;
}

export function extractGazeFeatures(
  landmarks: any[],
  blendshapes: Record<string, number>,
  transformMatrix?: Float32Array | number[]
): ExtractionResult | null {
  if (!landmarks || landmarks.length < 478) return null;

  // --- Build the head-aligned basis from the inter-eye line -----------------
  const aOuter = landmarks[EYE_A.outer];
  const aInner = landmarks[EYE_A.inner];
  const bOuter = landmarks[EYE_B.outer];
  const bInner = landmarks[EYE_B.inner];
  if (!aOuter || !aInner || !bOuter || !bInner) return null;

  const centreA: Vec2 = {
    x: (mirrored(aOuter).x + mirrored(aInner).x) / 2,
    y: (mirrored(aOuter).y + mirrored(aInner).y) / 2,
  };
  const centreB: Vec2 = {
    x: (mirrored(bOuter).x + mirrored(bInner).x) / 2,
    y: (mirrored(bOuter).y + mirrored(bInner).y) / 2,
  };

  // Order the eyes left-to-right in the mirrored frame so the basis always
  // points screen-right regardless of which index lands on which side.
  const [leftEye, rightEye] = centreA.x <= centreB.x ? [centreA, centreB] : [centreB, centreA];
  const interocular = sub(rightEye, leftEye);
  const span = norm(interocular);
  if (span < 1e-5) return null;

  const basisU: Vec2 = { x: interocular.x / span, y: interocular.y / span };
  // Screen convention: y grows downward, so the +90° rotation of u points down.
  const basisV: Vec2 = { x: -basisU.y, y: basisU.x };

  const eyeA = measureEye(landmarks, EYE_A, basisU, basisV);
  const eyeB = measureEye(landmarks, EYE_B, basisU, basisV);
  if (!eyeA && !eyeB) return null;

  // --- Head pose ------------------------------------------------------------
  const decomposed = decomposeTransform(transformMatrix);

  let yaw: number;
  let pitch: number;
  let roll = Math.atan2(basisU.y, basisU.x);

  if (decomposed) {
    yaw = decomposed.yaw;
    pitch = decomposed.pitch;
    roll = decomposed.roll;
  } else {
    // Fallback: infer rotation from facial proportions. Less accurate than the
    // transformation matrix but keeps the app usable if it is unavailable.
    const noseTip = landmarks[1];
    const chin = landmarks[152];
    const forehead = landmarks[10];
    const cheekL = landmarks[234];
    const cheekR = landmarks[454];

    if (noseTip && chin && forehead && cheekL && cheekR) {
      const n = mirrored(noseTip);
      const cl = mirrored(cheekL);
      const cr = mirrored(cheekR);
      const f = mirrored(forehead);
      const c = mirrored(chin);
      const faceWidth = Math.abs(cr.x - cl.x) || 1;
      const faceHeight = Math.abs(c.y - f.y) || 1;
      // Scale the normalised offsets into a plausible radian range so the
      // regression sees features of a comparable magnitude either way.
      yaw = ((n.x - (cl.x + cr.x) / 2) / faceWidth) * 2.2;
      pitch = ((n.y - (f.y + c.y) / 2) / faceHeight) * 2.2;
    } else {
      yaw = 0;
      pitch = 0;
    }
  }

  // Distance: prefer the face model, fall back to the apparent iris size, which
  // works because the iris is very nearly the same physical size in everyone.
  let distanceCm: number | null = decomposed?.distanceCm ?? null;
  const irisRadii = [eyeA?.irisRadius, eyeB?.irisRadius].filter(
    (r): r is number => typeof r === 'number' && r > 1e-4
  );
  const irisDiameterNorm = irisRadii.length > 0 ? (irisRadii.reduce((a, b) => a + b, 0) / irisRadii.length) * 2 : 0;

  if ((distanceCm === null || distanceCm < 15 || distanceCm > 200) && irisDiameterNorm > 1e-4) {
    const focalPx = 0.5 / Math.tan((ASSUMED_HFOV_DEG * Math.PI) / 360);
    distanceCm = (focalPx * IRIS_DIAMETER_MM) / (irisDiameterNorm * 10);
  }
  if (distanceCm !== null && (!Number.isFinite(distanceCm) || distanceCm < 15 || distanceCm > 200)) {
    distanceCm = null;
  }

  const faceCentre: Vec2 = { x: (leftEye.x + rightEye.x) / 2, y: (leftEye.y + rightEye.y) / 2 };

  const headPose: HeadPose = {
    yaw,
    pitch,
    roll,
    translateX: faceCentre.x - 0.5,
    translateY: faceCentre.y - 0.5,
    distanceCm,
    interocularSpan: span,
  };

  // --- Eye openness and blink ----------------------------------------------
  const blinkLeftScore = blendshapes['eyeBlinkLeft'] ?? 0;
  const blinkRightScore = blendshapes['eyeBlinkRight'] ?? 0;

  // Fuse the geometric aperture with the network's blink blendshape. The
  // blendshape reacts faster; the aperture is steadier for partial closures.
  const opennessA = eyeA ? eyeA.openness : 0;
  const opennessB = eyeB ? eyeB.openness : 0;
  const APERTURE_CLOSED = 0.11;
  const APERTURE_OPEN = 0.26;
  const normaliseOpen = (v: number) =>
    Math.max(0, Math.min(1, (v - APERTURE_CLOSED) / (APERTURE_OPEN - APERTURE_CLOSED)));

  const openA = Math.min(normaliseOpen(opennessA), 1 - blinkLeftScore);
  const openB = Math.min(normaliseOpen(opennessB), 1 - blinkRightScore);

  const isBlinkingLeft = openA < 0.35;
  const isBlinkingRight = openB < 0.35;

  // --- Binocular fusion -----------------------------------------------------
  // Weight each eye by how open it is and how square-on it is to the camera.
  // A strongly turned head hides the far eye, whose landmarks then drift.
  const yawVisibilityA = Math.max(0, Math.cos(yaw + 0.35));
  const yawVisibilityB = Math.max(0, Math.cos(yaw - 0.35));

  const weightA = eyeA ? Math.max(0, openA) * (0.4 + 0.6 * yawVisibilityA) : 0;
  const weightB = eyeB ? Math.max(0, openB) * (0.4 + 0.6 * yawVisibilityB) : 0;
  const weightSum = weightA + weightB;

  let gx = 0;
  let gy = 0;
  if (weightSum > 1e-4) {
    gx = ((eyeA?.gx ?? 0) * weightA + (eyeB?.gx ?? 0) * weightB) / weightSum;
    gy = ((eyeA?.gy ?? 0) * weightA + (eyeB?.gy ?? 0) * weightB) / weightSum;
  } else if (eyeA) {
    gx = eyeA.gx;
    gy = eyeA.gy;
  } else if (eyeB) {
    gx = eyeB.gx;
    gy = eyeB.gy;
  }

  // Disagreement between the eyes is a useful honesty signal: when the two
  // estimates diverge, at least one of them is wrong.
  const binocularDisagreement =
    eyeA && eyeB ? Math.hypot(eyeA.gx - eyeB.gx, eyeA.gy - eyeB.gy) : 0.05;

  const openQuality = Math.min(1, weightSum / 1.4);
  const agreementQuality = Math.max(0, 1 - binocularDisagreement / 0.12);
  const poseQuality = Math.max(0, 1 - Math.abs(yaw) / 0.7) * Math.max(0, 1 - Math.abs(pitch) / 0.6);

  const quality = Math.max(0, Math.min(1, openQuality * 0.45 + agreementQuality * 0.3 + poseQuality * 0.25));

  const features: GazeFeatures = {
    gx,
    gy,
    leftGx: eyeA?.gx ?? null,
    leftGy: eyeA?.gy ?? null,
    rightGx: eyeB?.gx ?? null,
    rightGy: eyeB?.gy ?? null,
    eyeOpenLeft: openA,
    eyeOpenRight: openB,
    isBlinkingLeft,
    isBlinkingRight,
    isBlinkingBoth: isBlinkingLeft && isBlinkingRight,
    binocularDisagreement,
    quality,
  };

  return { features, headPose };
}
