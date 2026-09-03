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
/**
 * Puts both axes in the same unit before any of them are measured.
 *
 * MediaPipe normalises x by the image width and y by the image height, so on a
 * 1280x720 camera one vertical unit is 1.78 horizontal units. Every length in
 * this file — the iris radius, the eye width, the distance between the eyes,
 * the aperture — was computed with `hypot` across those two axes as though they
 * were the same, which they are not.
 *
 * What that cost, measured against a synthetic face of known size at a known
 * distance (`scripts/geometryCheck.ts`):
 *
 * - the iris ruler read **0.72x** the true distance at every distance, because
 *   the ring's vertical radii were inflated and the horizontal ones were not.
 *   Every figure quoted in degrees is scaled by that distance, as is the advice
 *   about where to sit;
 * - vertical gaze came out **1.778x** more sensitive than horizontal — exactly
 *   the aspect ratio — so the vertical head-rotation term, whose constant is
 *   derived from image width, was under-applied by the same factor;
 * - the eye basis over-rotated: a 7 degree head roll read as 12.3, and a 15
 *   degree roll as 25.5, which drags the horizontal estimate by up to 4% of the
 *   screen when someone tilts their head while holding their gaze still.
 *
 * Dividing y by the aspect ratio expresses everything in image widths, which is
 * the unit the field-of-view constants were already written for.
 */
function framed(landmark: { x: number; y: number }, aspect: number): Vec2 {
  return { x: 1 - landmark.x, y: landmark.y / aspect };
}

/** Webcams are overwhelmingly 16:9; used only when the caller cannot say. */
const FALLBACK_IMAGE_ASPECT = 16 / 9;

function measureEye(
  landmarks: any[],
  spec: typeof EYE_A,
  basisU: Vec2,
  basisV: Vec2,
  aspect: number
): EyeMeasurement | null {
  const outer = landmarks[spec.outer];
  const inner = landmarks[spec.inner];
  const top = landmarks[spec.top];
  const bottom = landmarks[spec.bottom];
  const iris = landmarks[spec.iris];
  if (!outer || !inner || !top || !bottom || !iris) return null;

  const o = framed(outer, aspect);
  const i = framed(inner, aspect);
  const t = framed(top, aspect);
  const b = framed(bottom, aspect);
  const ir = framed(iris, aspect);

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
    irisRadius += norm(sub(framed(p, aspect), ir));
    ringSamples++;
  }
  irisRadius = ringSamples > 0 ? irisRadius / ringSamples : 0;

  return { gx, gy, width, openness, irisRadius, centre, valid: true };
}

/**
 * MediaPipe hands back a 4x4 transform as a flat array with no layout flag.
 *
 * The underlying MatrixData proto has a `layout` field, but the JavaScript
 * wrapper reads only rows, columns and the packed data and drops it — so the
 * ordering has to be established from the numbers themselves rather than
 * assumed. Guessing wrong is not a subtle error: it transposes the rotation,
 * which swaps yaw with pitch and inverts their signs, and it reads the
 * translation out of a row of zeros.
 *
 * A rigid transform makes this unambiguous. Written column-major, elements
 * 3, 7 and 11 are the zero row; written row-major, elements 12, 13 and 14 are.
 * Exactly one of those holds for a real transform.
 */
type MatrixLayout = 'column-major' | 'row-major';

function detectMatrixLayout(m: Float32Array | number[]): MatrixLayout | null {
  const nearZero = (v: number) => Math.abs(v) < 1e-4;

  const columnMajor = nearZero(m[3]) && nearZero(m[7]) && nearZero(m[11]);
  const rowMajor = nearZero(m[12]) && nearZero(m[13]) && nearZero(m[14]);

  // A transform sitting at the origin would satisfy both; neither reading of it
  // carries any information, so there is nothing to choose between them.
  if (columnMajor === rowMajor) return null;
  return columnMajor ? 'column-major' : 'row-major';
}

/**
 * Decomposes the facial transformation matrix (canonical-face-to-camera) into
 * intrinsic yaw-pitch-roll and a distance. Returns null when the matrix is
 * absent, degenerate, or of an ordering we cannot establish.
 */
function decomposeTransform(matrix?: Float32Array | number[]): {
  yaw: number;
  pitch: number;
  roll: number;
  distanceCm: number;
} | null {
  if (!matrix || matrix.length < 16) return null;

  const layout = detectMatrixLayout(matrix);
  if (!layout) return null;

  // r(row, col), whichever way the data is packed.
  const r =
    layout === 'column-major'
      ? (row: number, col: number) => matrix[col * 4 + row]
      : (row: number, col: number) => matrix[row * 4 + col];

  const tz = layout === 'column-major' ? matrix[14] : matrix[11];

  const r10 = r(1, 0);
  const r11 = r(1, 1);
  const r12 = r(1, 2);
  const r02 = r(0, 2);
  const r22 = r(2, 2);

  if (![r10, r11, r12, r02, r22, tz].every(Number.isFinite)) return null;

  /*
    Mirrored, to match every other quantity in this file.

    The landmarks are flipped horizontally so the picture matches what the client
    sees and "looked to the right" means the irises moved right. This matrix is
    not flipped — it arrives in the camera's own frame. A yaw taken straight from
    it therefore points the opposite way to the gaze feature it gets combined
    with, and to the sideways head travel measured from the same landmarks.

    Nothing catches that by inspection, and downstream it does not look like a
    sign error. It looks like head compensation simply making accuracy worse, and
    like the pass that measures how much to apply returning a negative number
    that gets rejected for being out of range — which is what two recorded
    sessions showed, with matrix yaw correlating at -0.98 against sideways head
    travel from the landmarks. Two measurements of one movement, pointing
    opposite ways.

    A horizontal mirror negates rotation about the vertical axis (yaw) and about
    the view axis (roll), and leaves rotation about the horizontal axis (pitch)
    alone — which is exactly the pattern in those recordings: yaw at -0.98
    against its landmark partner, pitch at +0.99.
  */
  const yaw = -Math.atan2(r02, r22);
  const pitch = Math.asin(Math.max(-1, Math.min(1, -r12)));
  const roll = -Math.atan2(r10, r11);

  // The canonical face model is expressed in centimetres, so the depth
  // component of the translation is directly a distance estimate — subject to
  // MediaPipe's assumed camera intrinsics, which is why it is cross-checked
  // against the iris measurement below rather than trusted outright.
  return { yaw, pitch, roll, distanceCm: Math.abs(tz) };
}

/**
 * Raw intermediate values, surfaced so a poor result can be diagnosed rather
 * than guessed at.
 *
 * Every accuracy problem so far has been a plausible-looking number produced by
 * a broken intermediate — a transposed matrix, a distance three times too
 * small. None of them were visible from the outside, which is why these are
 * exposed even though nothing in the tracking reads them.
 */
export interface FeatureDiagnostics {
  /** Which ordering the transformation matrix turned out to be in. */
  matrixLayout: MatrixLayout | 'undetectable' | 'absent';
  /** Distance from the face model's translation, in cm, before cross-checking. */
  modelDistanceCm: number | null;
  /** Distance from the apparent iris size, in cm, before cross-checking. */
  irisDistanceCm: number | null;
  /** Apparent iris diameter in normalised image units. */
  irisDiameterNorm: number;
  /** Landmarks reported for this frame. */
  landmarkCount: number;
  /** True when head pose came from facial proportions rather than the matrix. */
  usedFallbackHeadPose: boolean;
}

export interface ExtractionResult {
  features: GazeFeatures;
  headPose: HeadPose;
  diagnostics: FeatureDiagnostics;
}

export function extractGazeFeatures(
  landmarks: any[],
  blendshapes: Record<string, number>,
  transformMatrix?: Float32Array | number[],
  /** Image width divided by image height, so both axes can be measured alike. */
  imageAspect?: number
): ExtractionResult | null {
  if (!landmarks || landmarks.length < 478) return null;

  const aspect =
    typeof imageAspect === 'number' && Number.isFinite(imageAspect) && imageAspect > 0
      ? imageAspect
      : FALLBACK_IMAGE_ASPECT;

  // --- Build the head-aligned basis from the inter-eye line -----------------
  const aOuter = landmarks[EYE_A.outer];
  const aInner = landmarks[EYE_A.inner];
  const bOuter = landmarks[EYE_B.outer];
  const bInner = landmarks[EYE_B.inner];
  if (!aOuter || !aInner || !bOuter || !bInner) return null;

  const centreA: Vec2 = {
    x: (framed(aOuter, aspect).x + framed(aInner, aspect).x) / 2,
    y: (framed(aOuter, aspect).y + framed(aInner, aspect).y) / 2,
  };
  const centreB: Vec2 = {
    x: (framed(bOuter, aspect).x + framed(bInner, aspect).x) / 2,
    y: (framed(bOuter, aspect).y + framed(bInner, aspect).y) / 2,
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

  const eyeA = measureEye(landmarks, EYE_A, basisU, basisV, aspect);
  const eyeB = measureEye(landmarks, EYE_B, basisU, basisV, aspect);
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
      const n = framed(noseTip, aspect);
      const cl = framed(cheekL, aspect);
      const cr = framed(cheekR, aspect);
      const f = framed(forehead, aspect);
      const c = framed(chin, aspect);
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

  // --- Distance -------------------------------------------------------------
  // Two independent estimates, neither of which is trustworthy alone.
  //
  // The face model's translation rests on camera intrinsics MediaPipe assumes
  // rather than measures. The iris measurement rests on the iris being very
  // nearly the same physical size in every adult — which is true — but divides
  // by an assumed field of view, which varies a lot between webcams.
  //
  // So they are cross-checked. Agreement is good evidence both are close;
  // disagreement means the camera is not what one of them assumed, and the
  // result is reported as unreliable rather than averaged into a confident
  // wrong answer. Every accuracy figure in degrees scales with this number, so
  // quietly picking one is how a tool ends up reporting nine degrees of error
  // for a two degree problem.
  const irisRadii = [eyeA?.irisRadius, eyeB?.irisRadius].filter(
    (r): r is number => typeof r === 'number' && r > 1e-4
  );
  const irisDiameterNorm =
    irisRadii.length > 0 ? (irisRadii.reduce((a, b) => a + b, 0) / irisRadii.length) * 2 : 0;

  const plausible = (v: number | null | undefined): number | null =>
    typeof v === 'number' && Number.isFinite(v) && v >= 15 && v <= 200 ? v : null;

  const modelDistance = plausible(decomposed?.distanceCm);

  let irisDistance: number | null = null;
  if (irisDiameterNorm > 1e-4) {
    const focalPx = 0.5 / Math.tan((ASSUMED_HFOV_DEG * Math.PI) / 360);
    irisDistance = plausible((focalPx * IRIS_DIAMETER_MM) / (irisDiameterNorm * 10));
  }

  let distanceCm: number | null;
  let distanceAgreement: number;

  if (modelDistance !== null && irisDistance !== null) {
    const ratio = modelDistance / irisDistance;
    // 1 is perfect agreement; this falls to 0 by the time they differ by 2x.
    distanceAgreement = Math.max(0, 1 - Math.abs(Math.log(ratio)) / Math.log(2));
    distanceCm = distanceAgreement > 0.5 ? (modelDistance + irisDistance) / 2 : irisDistance;
  } else if (irisDistance !== null) {
    distanceCm = irisDistance;
    distanceAgreement = 0.4;
  } else if (modelDistance !== null) {
    distanceCm = modelDistance;
    distanceAgreement = 0.4;
  } else {
    distanceCm = null;
    distanceAgreement = 0;
  }

  const faceCentre: Vec2 = { x: (leftEye.x + rightEye.x) / 2, y: (leftEye.y + rightEye.y) / 2 };

  const diagnostics: FeatureDiagnostics = {
    matrixLayout: !transformMatrix || transformMatrix.length < 16
      ? 'absent'
      : detectMatrixLayout(transformMatrix) ?? 'undetectable',
    modelDistanceCm: modelDistance,
    irisDistanceCm: irisDistance,
    irisDiameterNorm,
    landmarkCount: landmarks.length,
    usedFallbackHeadPose: decomposed === null,
  };

  const headPose: HeadPose = {
    yaw,
    pitch,
    roll,
    translateX: faceCentre.x - 0.5,
    // Half of one image *width*, because that is the unit y is now in.
    translateY: faceCentre.y - 0.5 / aspect,
    distanceCm,
    distanceAgreement,
    interocularSpan: span,
  };

  // --- Eye openness and blink ----------------------------------------------
  const blinkLeftScore = blendshapes['eyeBlinkLeft'] ?? 0;
  const blinkRightScore = blendshapes['eyeBlinkRight'] ?? 0;

  // Fuse the geometric aperture with the network's blink blendshape. The
  // blendshape reacts faster; the aperture is steadier for partial closures.
  const opennessA = eyeA ? eyeA.openness : 0;
  const opennessB = eyeB ? eyeB.openness : 0;
  // Aperture height as a fraction of eye width. These were tuned by eye against
  // a 1280x720 camera *before* the two image axes were measured in the same
  // unit, so they carried that camera's 16:9 stretch baked into them — which
  // also meant they silently meant something different on a 4:3 webcam. Divided
  // through by that stretch, they now describe the eye rather than the sensor,
  // and behave identically on the camera they were tuned on.
  const APERTURE_CLOSED = 0.11 / (16 / 9);
  const APERTURE_OPEN = 0.26 / (16 / 9);
  const normaliseOpen = (v: number) =>
    Math.max(0, Math.min(1, (v - APERTURE_CLOSED) / (APERTURE_OPEN - APERTURE_CLOSED)));

  const openA = Math.min(normaliseOpen(opennessA), 1 - blinkLeftScore);
  const openB = Math.min(normaliseOpen(opennessB), 1 - blinkRightScore);

  const isBlinkingLeft = openA < 0.35;
  const isBlinkingRight = openB < 0.35;

  // --- A second, independent vertical cue -----------------------------------
  /*
   * The geometric feature above measures where the iris centre sits relative to
   * the eye corners. Horizontally that works well. Vertically it very nearly
   * does not, and the reason is the eyelid.
   *
   * Measured on a real session: across the full width of the screen gx moves
   * 0.206 per unit of screen; across the full height gy moves 0.041 — five
   * times less. Split in half it is worse. Over the *bottom* half gy moves
   * 0.064 per unit; over the top half it moves 0.017, against a per-point noise
   * of 0.001 to 0.006. In other words, across the entire upper half of the
   * screen the vertical signal is barely above its own noise, and the mapping
   * has nothing to fit but a slope through fog.
   *
   * That is not a bug in the arithmetic. When the eye rolls up the upper lid
   * rises with it and covers the top of the iris, so the iris landmarks are
   * fitted to a partial arc and their centre is pulled back down — cancelling
   * most of the movement it was supposed to report. Looking down, the lid
   * follows too but the iris still clears it, which is why the bottom half
   * survives and the top half does not.
   *
   * So take a second opinion from a different instrument. The landmarker also
   * emits eyeLookUp / eyeLookDown, which are predicted from the whole eye
   * region rather than from a circle fitted to the visible iris, and therefore
   * fail in a different way — the useful property here is not that they are
   * better, but that they are wrong about different things.
   *
   * This is offered to the regression as its own column rather than blended in
   * with a weight chosen here. A fixed blend would be a guess applied to
   * everyone; a column is a question asked of each person's own calibration,
   * and if the answer is that this cue tells us nothing, ridge shrinks it to
   * nothing and the mapping is no worse than it was.
   *
   * Signed downward to match gy, which grows toward the bottom of the screen.
   */
  const lookDown =
    ((blendshapes['eyeLookDownLeft'] ?? 0) + (blendshapes['eyeLookDownRight'] ?? 0)) / 2;
  const lookUp = ((blendshapes['eyeLookUpLeft'] ?? 0) + (blendshapes['eyeLookUpRight'] ?? 0)) / 2;
  const hasLidCue =
    'eyeLookDownLeft' in blendshapes ||
    'eyeLookUpLeft' in blendshapes ||
    'eyeLookDownRight' in blendshapes ||
    'eyeLookUpRight' in blendshapes;
  const lidGy = hasLidCue ? lookDown - lookUp : null;

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
    lidGy,
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

  return { features, headPose, diagnostics };
}
