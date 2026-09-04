/**
 * Synthetic check of the calibration mapping.
 *
 * Run with: bun run check:calibration   (or npx tsx scripts/calibrationCheck.ts)
 *
 * The browser flow can only ever tell you that calibration completed. This
 * exercises the mapping itself against a known ground truth, which is the only
 * way to catch the failure that mattered most in the previous version: an
 * interpolator that quietly refused to reach the edges of the screen.
 */

// Minimal browser stubs so the engine can be imported outside a browser.
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
(globalThis as any).window = {
  innerWidth: 1440,
  innerHeight: 900,
  screen: { width: 1920, height: 1080 },
  localStorage: (globalThis as any).localStorage,
};

const { standardiseColumns } = await import('../src/services/linalg');
const {
  CalibrationEngine,
  setEyelidCueEnabled,
  isEyelidCueEnabled,
  inCaptureOrder,
  QUICK_CALIBRATION_TARGETS,
  DEFAULT_CALIBRATION_TARGETS,
  PRECISION_CALIBRATION_TARGETS,
} = await import('../src/services/calibration');
const { viewingGeometry } = await import('../src/services/viewingGeometry');

const WIDTH = 1440;
const HEIGHT = 900;

/**
 * A plausible ground-truth relationship between eye measurement and screen
 * position: broadly linear, with the mild pincushion curvature a real eye
 * produces because the eyeball rotates while the screen stays flat.
 */
interface Posture {
  yaw: number;
  pitch: number;
  translateX: number;
  translateY: number;
}

const STILL: Posture = { yaw: 0, pitch: 0, translateX: 0, translateY: 0 };

/**
 * Scales the nonlinear part of the truth. Set to 0 for a scenario where the
 * eye really does move linearly with the target, which is what the model
 * selection has to recognise.
 */
let curvature = 1;

function trueFeatureFor(xNorm: number, yNorm: number, posture: Posture = STILL) {
  const u = xNorm - 0.5;
  const v = yNorm - 0.5;

  // Head geometry: to keep fixating the same point on screen, turning the head
  // toward the target requires the eye to rotate back by the same amount, and
  // sliding the head sideways requires a rotation proportional to the shift.
  // Both are the real physical relationship the head features exist to learn.
  // Chosen ~30% away from the constants the app assumes, so passing this means
  // the fixed compensation plus the learned residual terms cope with an eye
  // that does not match the textbook figures — not that the test agrees with
  // itself.
  const headGx = -0.52 * posture.yaw - 0.6 * posture.translateX;
  const headGy = 0.52 * posture.pitch - 0.6 * posture.translateY;

  return {
    gx: 0.16 * u + curvature * (0.03 * u * v - 0.02 * u * u * Math.sign(u)) + headGx,
    gy: 0.14 * v + curvature * (-0.025 * v * v * Math.sign(v) + 0.015 * u * v) + headGy,
  };
}

/** Seeded so this is a regression test rather than a coin toss. */
let seed = 0x2f6e2b1;
function random() {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0x100000000;
}

function gaussian(sigma: number) {
  const u = Math.max(1e-9, random());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random()) * sigma;
}

function makeSamples(
  xNorm: number,
  yNorm: number,
  noise: number,
  count = 30,
  posture: Posture = STILL,
  eyeModel: EyeModel = 'ideal'
) {
  return Array.from({ length: count }, () => {
    // Small involuntary posture variation within a single dwell.
    const jittered: Posture = {
      yaw: posture.yaw + gaussian(0.01),
      pitch: posture.pitch + gaussian(0.01),
      translateX: posture.translateX + gaussian(0.004),
      translateY: posture.translateY + gaussian(0.004),
    };
    const eyes = perEyeFeatures(xNorm, yNorm, jittered, noise, eyeModel);
    return {
      gx: eyes.gx,
      gy: eyes.gy,
      lidGy: eyes.lidGy,
      headYaw: jittered.yaw,
      headPitch: jittered.pitch,
      headTranslateX: jittered.translateX,
      headTranslateY: jittered.translateY,
      quality: 0.9,
    };
  });
}

const GRIDS: Record<string, Array<[number, number]>> = {
  '5-point': [[0.15, 0.18], [0.85, 0.18], [0.5, 0.5], [0.15, 0.82], [0.85, 0.82]],
  '9-point': [
    [0.12, 0.15], [0.5, 0.15], [0.88, 0.15],
    [0.12, 0.5], [0.5, 0.5], [0.88, 0.5],
    [0.12, 0.85], [0.5, 0.85], [0.88, 0.85],
  ],
  '13-point': [
    [0.12, 0.15], [0.5, 0.15], [0.88, 0.15],
    [0.12, 0.5], [0.5, 0.5], [0.88, 0.5],
    [0.12, 0.85], [0.5, 0.85], [0.88, 0.85],
    [0.3, 0.32], [0.7, 0.32], [0.3, 0.68], [0.7, 0.68],
  ],
};

// Points deliberately away from the calibration grid, including two near the
// edges — the region the old inverse-distance mapping could never reach.
const TEST_POINTS: Array<[number, number]> = [
  [0.28, 0.28], [0.72, 0.28], [0.5, 0.5], [0.28, 0.72], [0.72, 0.72],
  [0.06, 0.5], [0.94, 0.5], [0.5, 0.08], [0.5, 0.92],
];

/**
 * The same truth, split across two eyes that are not identical.
 *
 * Real faces are not symmetric: one eye usually sits slightly further from the
 * camera or at a slightly different angle, so the two eyes report subtly
 * different gains for the same gaze. Each also carries its own independent
 * landmark noise. Modelled here as a gain difference plus an offset — exactly
 * what a 50/50 average cannot represent and a difference term can.
 */
const EYE_GAIN = { left: 1.12, right: 0.9 };
const EYE_OFFSET = { left: 0.004, right: -0.003 };

/**
 * How much noisier one eye is than the other. Asymmetry like this is ordinary:
 * a spectacle frame edge, glare on one lens, a droopy lid, or simply sitting
 * slightly off-axis so one eye is further from the camera.
 */
const rightEyeNoiseMultiplier = 1;

/**
 * How much of the vertical eye movement the iris landmarks actually report.
 *
 * The synthetic eye used to be isotropic — a degree of upward gaze moved gy
 * exactly as far as a degree of sideways gaze moved gx — and every scenario
 * passed. A real session then measured the horizontal channel at 0.206 feature
 * units per screen width and the vertical at 0.041 per screen height, with the
 * top half of the screen down at 0.017 against a noise floor of 0.001 to 0.006.
 * The tests could not have caught that, because the fault was in a part of the
 * eye they did not model: the upper lid, which rises with the gaze and hides
 * the top of the iris, so the circle fitted to the visible arc has its centre
 * dragged back down.
 *
 * Modelled as a gain that falls off as the eye rolls up. `lidded` reproduces
 * the measured 5x horizontal-to-vertical ratio and the roughly 4x difference
 * between the bottom half of the screen and the top; `ideal` keeps the old
 * behaviour so the existing scenarios still mean what they meant.
 */
type EyeModel = 'ideal' | 'lidded';

function verticalVisibility(gyTruth: number): number {
  // gyTruth is negative looking up. Fitted, not invented: these three numbers
  // were chosen by grid search so the synthetic eye reproduces both ratios
  // measured on a real session — horizontal:vertical sensitivity 5.03x against
  // a measured 5.04x, and bottom-half:top-half vertical sensitivity 3.72x
  // against a measured 3.72x.
  const BASE = 0.39;
  const FLOOR = 0.02;
  const KNEE = 0.065;
  return BASE * (FLOOR + (1 - FLOOR) / (1 + Math.exp(-gyTruth / KNEE)));
}

/**
 * The second vertical cue, as the landmarker's eyeLookUp/eyeLookDown pair would
 * report it: coarser and noisier than the iris, but it does not go blind at the
 * top of the screen, because it is predicted from the whole eye region rather
 * than from a circle fitted to whatever part of the iris is still showing.
 */
function lidCueFor(gyTruth: number, noise: number): number {
  return gyTruth * 0.9 + gaussian(noise * 2.5);
}

function perEyeFeatures(
  xNorm: number,
  yNorm: number,
  posture: Posture,
  noise: number,
  eyeModel: EyeModel = 'ideal'
) {
  const truth = trueFeatureFor(xNorm, yNorm, posture);
  const visibility = eyeModel === 'lidded' ? verticalVisibility(truth.gy) : 1;
  const seenGy = truth.gy * visibility;

  const rightNoise = noise * rightEyeNoiseMultiplier;
  const leftGx = truth.gx * EYE_GAIN.left + EYE_OFFSET.left + gaussian(noise);
  const leftGy = seenGy * EYE_GAIN.left + gaussian(noise);
  const rightGx = truth.gx * EYE_GAIN.right + EYE_OFFSET.right + gaussian(rightNoise);
  const rightGy = seenGy * EYE_GAIN.right + gaussian(rightNoise);

  return {
    gx: (leftGx + rightGx) / 2,
    gy: (leftGy + rightGy) / 2,
    lidGy: eyeModel === 'lidded' ? lidCueFor(truth.gy, noise) : null,
  };
}

/** Reset before each scenario so scenarios do not perturb one another. */
function reseed() {
  seed = 0x2f6e2b1;
}

const NOISE_LEVELS = [
  { label: 'clean', sigma: 0 },
  { label: 'realistic noise', sigma: 0.0016 },
  { label: 'heavy noise', sigma: 0.004 },
];

/**
 * Accuracy expectations per grid. A five-point grid determines a bilinear map
 * exactly, leaving nothing over to describe the curvature of a real eye, so it
 * is held to a much looser standard than the denser grids — which is also why
 * the set-up screen describes it as good enough for games rather than for
 * assessment.
 */
const LIMITS: Record<string, Record<string, number>> = {
  '5-point': { clean: 3.0, 'realistic noise': 3.0, 'heavy noise': 3.4 },
  '9-point': { clean: 1.1, 'realistic noise': 1.2, 'heavy noise': 1.6 },
  '13-point': { clean: 0.6, 'realistic noise': 0.7, 'heavy noise': 1.0 },
};

viewingGeometry.updateSettings({ screenDiagonalInches: 15.6, assumedDistanceCm: 55, useMeasuredDistance: false });

let failures = 0;

for (const [gridName, grid] of Object.entries(GRIDS)) {
  for (const noise of NOISE_LEVELS) {
    reseed();
    const engine = new CalibrationEngine();
    engine.reset();

    grid.forEach(([x, y], i) => {
      engine.addAnchorFromSamples(`p${i}`, x, y, makeSamples(x, y, noise.sigma));
    });

    if (!engine.isCalibrated()) {
      console.log(`FAIL  ${gridName} / ${noise.label}: engine did not calibrate`);
      failures++;
      continue;
    }

    const headPose = {
      yaw: 0, pitch: 0, roll: 0,
      translateX: 0, translateY: 0,
      distanceCm: 55, distanceAgreement: 1, interocularSpan: 0.1,
    };

    let sumErrorPx = 0;
    let worstPx = 0;
    let worstLabel = '';
    let spanX = { min: Infinity, max: -Infinity };

    for (const [x, y] of TEST_POINTS) {
      const eyes = perEyeFeatures(x, y, STILL, 0);
      const mapped = engine.mapToScreen(eyes.gx, eyes.gy, eyes.lidGy, headPose, WIDTH, HEIGHT);
      if (!mapped) {
        console.log(`FAIL  ${gridName} / ${noise.label}: no mapping returned`);
        failures++;
        break;
      }
      const errorPx = Math.hypot(mapped.x - x * WIDTH, mapped.y - y * HEIGHT);
      sumErrorPx += errorPx;
      if (errorPx > worstPx) {
        worstPx = errorPx;
        worstLabel = `(${x}, ${y})`;
      }
      spanX.min = Math.min(spanX.min, mapped.x);
      spanX.max = Math.max(spanX.max, mapped.x);
    }

    const meanPx = sumErrorPx / TEST_POINTS.length;
    const meanDeg = viewingGeometry.pixelsToDegrees(meanPx);
    const worstDeg = viewingGeometry.pixelsToDegrees(worstPx);

    // The horizontal spread of the predictions across test points that span
    // 6%–94% of the screen. An averaging interpolator collapses this toward the
    // centre; a regression keeps it wide.
    const reachFraction = (spanX.max - spanX.min) / WIDTH;

    // Thresholds are generous enough not to be flaky, tight enough to catch a
    // mapping that has stopped working.
    const meanLimit = LIMITS[gridName][noise.label];
    const reachLimit = gridName === '5-point' ? 0.55 : 0.72;
    const ok = meanDeg <= meanLimit && reachFraction >= reachLimit;
    if (!ok) failures++;

    console.log(
      `${ok ? 'ok  ' : 'FAIL'}  ${gridName.padEnd(9)} ${noise.label.padEnd(16)} ` +
        `mean ${meanDeg.toFixed(2)}° (${meanPx.toFixed(0)} px)  ` +
        `worst ${worstDeg.toFixed(2)}° at ${worstLabel}  ` +
        `reach ${(reachFraction * 100).toFixed(0)}%  ` +
        `terms ${engine.getModel().quality?.featureDegree ?? '?'}`
    );
  }
}

/**
 * Head compensation.
 *
 * Two scenarios, because they answer different questions. Calibrating with a
 * perfectly still head leaves the model no evidence about how head movement
 * affects gaze, so it cannot compensate for it and error grows when the client
 * shifts — this is the case a chin rest is for. Calibrating while the head
 * varies gives the head features something to fit, and the model then holds up.
 */
{
  const MOVED: Posture = { yaw: 0.09, pitch: 0.05, translateX: 0.025, translateY: 0.012 };

  const evaluate = (engine: InstanceType<typeof CalibrationEngine>, posture: Posture) => {
    let sum = 0;
    for (const [x, y] of TEST_POINTS) {
      const eyes = perEyeFeatures(x, y, posture, 0);
      const mapped = engine.mapToScreen(
        eyes.gx,
        eyes.gy,
        eyes.lidGy,
        { yaw: posture.yaw, pitch: posture.pitch, roll: 0, translateX: posture.translateX, translateY: posture.translateY, distanceCm: 55, distanceAgreement: 1, interocularSpan: 0.1 },
        WIDTH,
        HEIGHT
      )!;
      sum += Math.hypot(mapped.x - x * WIDTH, mapped.y - y * HEIGHT);
    }
    return viewingGeometry.pixelsToDegrees(sum / TEST_POINTS.length);
  };

  // (a) Calibrated with a still head.
  reseed();
  const still = new CalibrationEngine();
  still.reset();
  GRIDS['13-point'].forEach(([x, y], i) => {
    still.addAnchorFromSamples(`p${i}`, x, y, makeSamples(x, y, 0.0016, 30, STILL));
  });
  const stillAtRest = evaluate(still, STILL);
  const stillAfterMove = evaluate(still, MOVED);

  // (b) The same still-head grid, followed by a head-movement pass: the client
  //     keeps looking at one point while turning and shifting a little.
  reseed();
  const withPass = new CalibrationEngine();
  withPass.reset();
  GRIDS['13-point'].forEach(([x, y], i) => {
    withPass.addAnchorFromSamples(`p${i}`, x, y, makeSamples(x, y, 0.0016, 30, STILL));
  });

  const motionSamples = Array.from({ length: 120 }, (_, i) => {
    const phase = (i / 120) * Math.PI * 4;
    const posture: Posture = {
      yaw: 0.08 * Math.sin(phase),
      pitch: 0.05 * Math.sin(phase * 0.7 + 1),
      translateX: 0.022 * Math.cos(phase * 0.9),
      translateY: 0.012 * Math.cos(phase * 1.3 + 2),
    };
    const jittered: Posture = {
      yaw: posture.yaw + gaussian(0.004),
      pitch: posture.pitch + gaussian(0.004),
      translateX: posture.translateX + gaussian(0.002),
      translateY: posture.translateY + gaussian(0.002),
    };
    const eyes = perEyeFeatures(0.5, 0.5, jittered, 0.0016);
    return {
      gx: eyes.gx,
      gy: eyes.gy,
      headYaw: jittered.yaw,
      headPitch: jittered.pitch,
      headTranslateX: jittered.translateX,
      headTranslateY: jittered.translateY,
      lidGy: null,
      quality: 0.9,
    };
  });

  const fittedGain = withPass.fitHeadGainFromMotionPass(motionSamples);
  console.log(
    `      head-movement pass measured gain: turn ${fittedGain?.rotationX.toFixed(2)}, ` +
      `nod ${fittedGain?.rotationY.toFixed(2)}, ` +
      `translation ${fittedGain?.translation.toFixed(2)} (truth implies 1.30 each)`
  );

  const variedAtRest = evaluate(withPass, STILL);
  const variedAfterMove = evaluate(withPass, MOVED);

  const stillOk = stillAtRest <= 0.7;
  // The pass must not disturb accuracy at the calibrated posture...
  const variedOk = variedAtRest <= 0.7;
  // ...and must measurably improve matters once the head has moved.
  const compensationOk = variedAfterMove < stillAfterMove * 0.6;

  if (!stillOk || !variedOk || !compensationOk) failures++;

  console.log(
    `${stillOk ? 'ok  ' : 'FAIL'}  still-head calibration, head at rest      ${stillAtRest.toFixed(2)}°`
  );
  console.log(
    `      still-head calibration, head then moved   ${stillAfterMove.toFixed(2)}°  (expected to degrade)`
  );
  console.log(
    `${variedOk ? 'ok  ' : 'FAIL'}  with head-movement pass, head at rest     ${variedAtRest.toFixed(2)}°`
  );
  console.log(
    `${compensationOk ? 'ok  ' : 'FAIL'}  with head-movement pass, head moved       ${variedAfterMove.toFixed(2)}°  (compensation working)`
  );
}

/**
 * Outlier rejection.
 *
 * One point captured while the client was looking somewhere else — a blink, a
 * glance at the therapist, a capture that began before the saccade landed. A
 * least-squares fit spreads that error over the whole surface, so the damage is
 * not confined to the corner it happened in.
 */
{
  reseed();
  const engine = new CalibrationEngine();
  engine.reset();

  const grid = GRIDS['9-point'];
  grid.forEach(([x, y], i) => {
    // Point 3 is captured while the client was actually looking at the far
    // opposite corner of the screen.
    const [ax, ay] = i === 3 ? [0.85, 0.85] : [x, y];
    engine.addAnchorFromSamples(`p${i}`, x, y, makeSamples(ax, ay, 0.0016));
  });

  const headPose = {
    yaw: 0, pitch: 0, roll: 0,
    translateX: 0, translateY: 0,
    distanceCm: 55, distanceAgreement: 1, interocularSpan: 0.1,
  };

  const measure = () => {
    let sum = 0;
    for (const [x, y] of TEST_POINTS) {
      const eyes = perEyeFeatures(x, y, STILL, 0);
      const mapped = engine.mapToScreen(eyes.gx, eyes.gy, eyes.lidGy, headPose, WIDTH, HEIGHT)!;
      sum += Math.hypot(mapped.x - x * WIDTH, mapped.y - y * HEIGHT);
    }
    return viewingGeometry.pixelsToDegrees(sum / TEST_POINTS.length);
  };

  const beforePrune = measure();
  const result = engine.pruneOutlierAnchors();
  const afterPrune = measure();

  const foundIt = result.removed.includes('p3');
  const improved = afterPrune < beforePrune * 0.6;
  if (!foundIt || !improved) failures++;

  console.log(
    `${foundIt ? 'ok  ' : 'FAIL'}  outlier point identified                  removed [${result.removed.join(', ')}], expected p3`
  );
  console.log(
    `${improved ? 'ok  ' : 'FAIL'}  outlier removal improved accuracy         ${beforePrune.toFixed(2)}° -> ${afterPrune.toFixed(2)}°`
  );
}

// A clean grid must survive pruning untouched — a rejection rule that eats good
// points is worse than none.
{
  reseed();
  const engine = new CalibrationEngine();
  engine.reset();
  GRIDS['9-point'].forEach(([x, y], i) => {
    engine.addAnchorFromSamples(`p${i}`, x, y, makeSamples(x, y, 0.0016));
  });
  const result = engine.pruneOutlierAnchors();
  const untouched = result.removed.length === 0;
  if (!untouched) failures++;
  console.log(
    `${untouched ? 'ok  ' : 'FAIL'}  clean grid left alone by pruning          removed ${result.removed.length} point(s)`
  );
}

/**
 * Leaning in or out after calibrating.
 *
 * A screen point X cm off centre needs an eye rotation of atan(X / D), so the
 * whole mapping scales with viewing distance. Calibrate at 50 cm, lean in to
 * 40 cm, and every estimate flies outward unless the mapping shrinks to match.
 * This is an ordinary thing for someone to do during a session — leaning in to
 * see something is close to a reflex — so it has to be handled rather than only
 * warned about.
 */
{
  reseed();
  const engine = new CalibrationEngine();
  engine.reset();

  const CAL_SPAN = 0.1;
  GRIDS['13-point'].forEach(([x, y], i) => {
    engine.addAnchorFromSamples(`p${i}`, x, y, makeSamples(x, y, 0.0016, 30, STILL));
  });
  engine.recordPosture({
    yaw: 0, pitch: 0, roll: 0,
    translateX: 0, translateY: 0,
    distanceCm: 50, distanceAgreement: 1, interocularSpan: CAL_SPAN,
  });

  // Leaning in from 50 cm to 40 cm makes the eyes look 50/40 further apart.
  const leanRatio = 50 / 40;

  const measure = (spanNow: number, distanceNow: number) => {
    let sum = 0;
    for (const [x, y] of TEST_POINTS) {
      // At the new distance the same screen point sits at a different angle, so
      // the eye measurement for it is the one that used to point somewhere
      // proportionally further out.
      const scaled = {
        x: 0.5 + (x - 0.5) * (50 / distanceNow),
        y: 0.5 + (y - 0.5) * (50 / distanceNow),
      };
      const eyes = perEyeFeatures(scaled.x, scaled.y, STILL, 0);
      const mapped = engine.mapToScreen(
        eyes.gx,
        eyes.gy,
        eyes.lidGy,
        {
          yaw: 0, pitch: 0, roll: 0,
          translateX: 0, translateY: 0,
          distanceCm: distanceNow, distanceAgreement: 1, interocularSpan: spanNow,
        },
        WIDTH,
        HEIGHT
      )!;
      sum += Math.hypot(mapped.x - x * WIDTH, mapped.y - y * HEIGHT);
    }
    return viewingGeometry.pixelsToDegrees(sum / TEST_POINTS.length);
  };

  const atCalibratedDistance = measure(CAL_SPAN, 50);
  const afterLeaningIn = measure(CAL_SPAN * leanRatio, 40);

  const stillGoodWhereCalibrated = atCalibratedDistance <= 0.7;
  const leanHandled = afterLeaningIn <= 1.2;
  if (!stillGoodWhereCalibrated || !leanHandled) failures++;

  console.log(
    `${stillGoodWhereCalibrated ? 'ok  ' : 'FAIL'}  at the calibrated distance               ${atCalibratedDistance.toFixed(2)}°`
  );
  console.log(
    `${leanHandled ? 'ok  ' : 'FAIL'}  after leaning in 50cm -> 40cm            ${afterLeaningIn.toFixed(2)}°`
  );
}

/**
 * Model selection.
 *
 * The number of calibration points says what can be fitted; it does not say
 * what is worth fitting. These two scenarios are the same grid and the same
 * noise, differing only in whether the underlying eye-to-screen mapping is
 * actually curved. Choosing by anchor count gets one of them wrong by
 * construction — it would fit the six-parameter surface to both, spending three
 * parameters on noise in the linear case. Choosing by cross-validation has to
 * get both right.
 */
{
  const measureAt = (engine: InstanceType<typeof CalibrationEngine>) => {
    let sum = 0;
    for (const [x, y] of TEST_POINTS) {
      const eyes = perEyeFeatures(x, y, STILL, 0);
      const mapped = engine.mapToScreen(eyes.gx, eyes.gy, eyes.lidGy, {
        yaw: 0, pitch: 0, roll: 0,
        translateX: 0, translateY: 0,
        distanceCm: 55, distanceAgreement: 1, interocularSpan: 0.1,
      }, WIDTH, HEIGHT)!;
      sum += Math.hypot(mapped.x - x * WIDTH, mapped.y - y * HEIGHT);
    }
    return viewingGeometry.pixelsToDegrees(sum / TEST_POINTS.length);
  };

  const fitGrid = (grid: Array<[number, number]>, noise: number) => {
    reseed();
    const engine = new CalibrationEngine();
    engine.reset();
    grid.forEach(([x, y], i) => engine.addAnchorFromSamples(`p${i}`, x, y, makeSamples(x, y, noise)));
    return engine;
  };

  // For one grid: what each candidate feature set would really have scored on
  // held-out points, next to what leave-one-out predicted and what was chosen.
  const scoreCandidates = (label: string, grid: Array<[number, number]>, noise: number) => {
    const engine = fitGrid(grid, noise);
    const chosen = engine.getModel().quality?.featureDegree ?? 0;
    const scores = engine.getFeatureDegreeScores().map(({ degree, looErrorPx }) => {
      engine.overrideFeatureDegree(degree);
      if (engine.getModel().regression?.degree !== degree) console.log('   !! override did not take', degree, engine.getModel().regression?.degree);
      const trueError = measureAt(engine);
      return { degree, looErrorPx, trueError };
    });
    engine.overrideFeatureDegree(null);

    const best = Math.min(...scores.map(sc => sc.trueError));
    const chosenScore = scores.find(sc => sc.degree === chosen);
    // The selector does not have to find the single best model — it has to
    // avoid the bad ones. Within 15% of the best available is the bar.
    const ok = chosenScore !== undefined && chosenScore.trueError <= best * 1.15 + 0.05;
    if (!ok) failures++;

    console.log(
      `${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(40)} chose ${chosen}, ` +
        scores
          .map(sc => `${sc.degree}: ${sc.trueError.toFixed(2)}° (loo ${sc.looErrorPx.toFixed(0)}px)`)
          .join('  ')
    );
  };

  curvature = 0;
  scoreCandidates('linear eye, noisy grid', GRIDS['9-point'], 0.006);
  curvature = 1;
  scoreCandidates('curved eye, clean grid', GRIDS['13-point'], 0.002);
  scoreCandidates('curved eye, noisy grid', GRIDS['13-point'], 0.006);
}

/**
 * The head-movement ring asks for a specific amount of movement. This checks
 * that the amount it asks for is actually enough for the fit behind it.
 *
 * These two numbers live in different files and are easy to drift apart: shrink
 * the ring's targets to make the step feel easier, and the step silently stops
 * measuring anything while still looking complete to the client. The scenario
 * plays back exactly the movement a client makes when they fill the ring and no
 * more — a sweep out to the target in each direction — and requires a real gain
 * to come back rather than the nominal fallback.
 */
{
  const { HEAD_TARGET_YAW, HEAD_TARGET_PITCH, EMPTY_COVERAGE, accumulateCoverage, coverageComplete } =
    await import('../src/components/HeadCoverageRing');

  reseed();
  const engine = new CalibrationEngine();
  engine.reset();
  GRIDS['9-point'].forEach(([x, y], i) => engine.addAnchorFromSamples(`p${i}`, x, y, makeSamples(x, y, 0.002)));

  // A client filling the ring: turn one way to the target, back through centre
  // to the other side, then the same vertically. Sampled at 30 Hz.
  const ringSamples = Array.from({ length: 240 }, (_, i) => {
    const t = i / 240;
    const horizontal = t < 0.5;
    const phase = (horizontal ? t * 2 : (t - 0.5) * 2) * Math.PI * 2;
    const posture: Posture = {
      yaw: horizontal ? HEAD_TARGET_YAW * Math.sin(phase) : 0,
      pitch: horizontal ? 0 : HEAD_TARGET_PITCH * Math.sin(phase),
      // Turning the head shifts it slightly; nobody rotates about their own eyes.
      translateX: horizontal ? 0.03 * Math.sin(phase) : 0,
      translateY: horizontal ? 0 : 0.012 * Math.sin(phase),
    };
    const jittered: Posture = {
      yaw: posture.yaw + gaussian(0.004),
      pitch: posture.pitch + gaussian(0.004),
      translateX: posture.translateX + gaussian(0.002),
      translateY: posture.translateY + gaussian(0.002),
    };
    const eyes = perEyeFeatures(0.5, 0.5, jittered, 0.0016);
    return {
      gx: eyes.gx,
      gy: eyes.gy,
      headYaw: jittered.yaw,
      headPitch: jittered.pitch,
      headTranslateX: jittered.translateX,
      headTranslateY: jittered.translateY,
      lidGy: null,
      quality: 0.9,
    };
  });

  // The ring reads the same poses the fit does, so "the client filled the ring"
  // and "the fit had enough to work with" are the same event by construction.
  let coverage = EMPTY_COVERAGE;
  for (const sample of ringSamples) {
    coverage = accumulateCoverage(coverage, sample.headYaw, sample.headPitch, 0, 0).coverage;
  }
  const ringFilled = coverageComplete(coverage);
  if (!ringFilled) failures++;
  console.log(
    `${ringFilled ? 'ok  ' : 'FAIL'}  that movement fills the ring             ` +
      `L ${coverage.left.toFixed(2)}  R ${coverage.right.toFixed(2)}  ` +
      `U ${coverage.up.toFixed(2)}  D ${coverage.down.toFixed(2)}`
  );

  const gain = engine.fitHeadGainFromMotionPass(ringSamples);

  // Turning and nodding move the head about the neck, so yaw and sideways
  // travel arrive in lockstep and only their combined effect is identifiable.
  // The right answer is therefore a single gain carried by the rotation term —
  // here 1.42, which is the combined truth — and translation left at the
  // nominal constant rather than at a number invented from collinear data.
  const combined = gain !== null && gain.rotationX > 1.1 && gain.rotationX < 1.8 && gain.translation === 1;
  if (!combined) failures++;
  console.log(
    `${combined ? 'ok  ' : 'FAIL'}  a turn measures the combined effect      ` +
      (gain ? `rotation ${gain.rotationX.toFixed(2)}, translation ${gain.translation.toFixed(2)}` : 'no fit')
  );

  /**
   * And the separable case, which is what a second movement buys.
   *
   * Sliding the head while keeping it square on to the screen produces travel
   * without rotation. Played back alongside the turn, the two regressors no
   * longer march together, and both constants come back — which is the argument
   * for asking the client for two movements rather than one.
   */
  reseed();
  const engineTwo = new CalibrationEngine();
  engineTwo.reset();
  GRIDS['9-point'].forEach(([x, y], i) => engineTwo.addAnchorFromSamples(`p${i}`, x, y, makeSamples(x, y, 0.002)));

  const slideSamples = Array.from({ length: 120 }, (_, i) => {
    const t = i / 120;
    const horizontal = t < 0.5;
    const phase = (horizontal ? t * 2 : (t - 0.5) * 2) * Math.PI * 2;
    // Square on throughout: travel with no rotation at all.
    const posture: Posture = {
      yaw: 0,
      pitch: 0,
      translateX: horizontal ? 0.035 * Math.sin(phase) : 0,
      translateY: horizontal ? 0 : 0.02 * Math.sin(phase),
    };
    const jittered: Posture = {
      yaw: posture.yaw + gaussian(0.004),
      pitch: posture.pitch + gaussian(0.004),
      translateX: posture.translateX + gaussian(0.002),
      translateY: posture.translateY + gaussian(0.002),
    };
    const eyes = perEyeFeatures(0.5, 0.5, jittered, 0.0016);
    return {
      gx: eyes.gx,
      gy: eyes.gy,
      headYaw: jittered.yaw,
      headPitch: jittered.pitch,
      headTranslateX: jittered.translateX,
      headTranslateY: jittered.translateY,
      lidGy: null,
      quality: 0.9,
    };
  });

  const bothGain = engineTwo.fitHeadGainFromMotionPass([...ringSamples, ...slideSamples]);
  // Truth is 0.6 against a nominal 0.462, so translation should land near 1.3.
  const separated =
    bothGain !== null &&
    bothGain.translation !== 1 &&
    bothGain.translation > 1.0 &&
    bothGain.translation < 1.7;
  if (!separated) failures++;
  console.log(
    `${separated ? 'ok  ' : 'FAIL'}  adding a slide separates the two         ` +
      (bothGain
        ? `rotation ${bothGain.rotationX.toFixed(2)}, translation ${bothGain.translation.toFixed(2)}`
        : 'no fit')
  );
}

/**
 * An eye whose iris goes half-blind looking up.
 *
 * This is the scenario the whole suite was missing. Every grid above uses the
 * `ideal` eye, whose vertical channel is exactly as informative as its
 * horizontal one, and against that eye a mapping with no vertical cue at all
 * still scores well. A real session does not behave like that: measured, the
 * vertical channel carried a fifth of the horizontal one's range, and across
 * the top half of the screen almost nothing. The reported accuracy stayed
 * respectable throughout, because it was averaged over a band near the middle
 * where the signal still exists.
 *
 * So this scenario asks two questions the others cannot. Does the reported
 * figure notice when the top of the screen has become unreachable — measured
 * as vertical reach, not as a mean error over a comfortable middle. And does
 * the second cue recover the range the iris lost.
 */
{
  console.log('\n--- An eye the lid hides at the top of the screen ---');

  // The cue is off in the app; two recorded sessions measured it doing harm.
  // These scenarios still exercise the mechanism, because what is switched off
  // has to stay proven if it is ever to be switched back on.
  const offByDefault = !isEyelidCueEnabled();
  if (!offByDefault) failures++;
  console.log(
    `${offByDefault ? 'ok  ' : 'FAIL'}  the cue is off by default                ` +
      `real sessions measured 8.56° vs 4.22° and 3.41° vs 2.86° against it`
  );
  setEyelidCueEnabled(true);

  const GRID = GRIDS['9-point'];
  const reach = (eyeModel: EyeModel, useCue: boolean) => {
    reseed();
    const engine = new CalibrationEngine();
    engine.reset();
    GRID.forEach(([x, y], i) => {
      const samples = makeSamples(x, y, 0.0016, 30, STILL, eyeModel).map(sm => ({
        ...sm,
        lidGy: useCue ? sm.lidGy : null,
      }));
      engine.addAnchorFromSamples(`p${i}`, x, y, samples);
    });

    const headPose = {
      yaw: 0, pitch: 0, roll: 0,
      translateX: 0, translateY: 0,
      distanceCm: 55, distanceAgreement: 1, interocularSpan: 0.1,
    };

    let reachedY = 0;
    let wantedY = 0;
    let sumErrPx = 0;
    for (const [x, y] of TEST_POINTS) {
      const eyes = perEyeFeatures(x, y, STILL, 0, eyeModel);
      const mapped = engine.mapToScreen(
        eyes.gx,
        eyes.gy,
        useCue ? eyes.lidGy : null,
        headPose,
        WIDTH,
        HEIGHT
      );
      if (!mapped) return null;
      reachedY += Math.abs(mapped.y / HEIGHT - 0.5);
      wantedY += Math.abs(y - 0.5);
      sumErrPx += Math.hypot(mapped.x - x * WIDTH, mapped.y - y * HEIGHT);
    }
    return {
      verticalReach: reachedY / wantedY,
      meanDeg: viewingGeometry.pixelsToDegrees(sumErrPx / TEST_POINTS.length),
    };
  };

  const healthy = reach('ideal', false);
  const lidded = reach('lidded', false);
  const rescued = reach('lidded', true);

  if (!healthy || !lidded || !rescued) {
    console.log('FAIL  lid scenario: no mapping returned');
    failures++;
  } else {
    // A compressed vertical signal must no longer cost *range*. It used to, and
    // that was the standardisation bug rather than the lid: ridge is
    // scale-sensitive, the vertical column has roughly an eighth of the
    // horizontal column's spread, and nothing was actually being standardised,
    // so the vertical coefficient was shrunk by 70% against the horizontal
    // column's 4%. A monotonic signal, however compressed, is recoverable by a
    // larger coefficient — once the penalty stops forbidding one.
    const keepsRange = lidded.verticalReach > 0.85;
    if (!keepsRange) failures++;
    console.log(
      `${keepsRange ? 'ok  ' : 'FAIL'}  a squashed signal still reaches          ` +
        `healthy ${(healthy.verticalReach * 100).toFixed(0)}%  lidded ${(lidded.verticalReach * 100).toFixed(0)}%`
    );

    // What the lid does cost is signal-to-noise, and that is real.
    const costsAccuracy = lidded.meanDeg > healthy.meanDeg * 1.5;
    if (!costsAccuracy) failures++;
    console.log(
      `${costsAccuracy ? 'ok  ' : 'FAIL'}  but it does cost accuracy                ` +
        `${healthy.meanDeg.toFixed(2)}° -> ${lidded.meanDeg.toFixed(2)}°`
    );

    // The cue can still recover some of that on a synthetic eye with a clean
    // cue. It is off regardless, because on real faces it did the opposite —
    // 8.56° against 4.22° with the camera on a desk. Recorded here so the gap
    // between the synthetic case and the real one stays visible.
    console.log(
      `      for reference, a clean cue would give   ` +
        `${lidded.meanDeg.toFixed(2)}° -> ${rescued.meanDeg.toFixed(2)}° on this synthetic eye`
    );

    const healthyWithCue = reach('ideal', true);
    const harmless = healthyWithCue !== null && healthyWithCue.meanDeg < healthy.meanDeg * 1.25;
    if (!harmless) failures++;
    console.log(
      `${harmless ? 'ok  ' : 'FAIL'}  and costs an unaffected eye little       ` +
        `${healthy.meanDeg.toFixed(2)}° -> ${healthyWithCue?.meanDeg.toFixed(2)}°`
    );
  }
}

/**
 * A cue that is worse than useless has to be turned down.
 *
 * The first shipped version of the eyelid cue always went into the fit if the
 * camera supplied it. On a real face that took vertical reach from 50% to
 * 100-120% — the range came back — while vertical error rose past four degrees
 * and the frame-to-frame wobble doubled, because two collinear vertical signals
 * let the fit reach the anchors with large opposing weights and amplify the
 * noise in both. "Ridge will shrink it to nothing if it says nothing" was the
 * intention and was not true.
 *
 * What makes it true is refusing the cue rather than weakening it. The model is
 * now fitted both ways and the cue is kept only when holding an anchor out says
 * it helps, so a cue that is pure noise costs nothing, and one that is actively
 * misleading is declined outright.
 */
{
  console.log('\n--- A cue that carries nothing must be refused ---');

  const GRID = GRIDS['9-point'];
  const fitWith = (cue: (gyTruth: number) => number | null) => {
    reseed();
    const engine = new CalibrationEngine();
    engine.reset();
    GRID.forEach(([x, y], i) => {
      const samples = makeSamples(x, y, 0.0016, 30, STILL, 'lidded').map(sm => ({
        ...sm,
        lidGy: cue(sm.gy),
      }));
      engine.addAnchorFromSamples(`p${i}`, x, y, samples);
    });
    return engine.getModel();
  };

  // Pure noise, on the same scale as the real cue.
  const noise = fitWith(() => gaussian(0.05));
  const refusedNoise = noise.regression?.usesLidCue === false;
  if (!refusedNoise) failures++;
  console.log(
    `${refusedNoise ? 'ok  ' : 'FAIL'}  a cue that is pure noise is declined     ` +
      `usesLidCue ${noise.regression?.usesLidCue}`
  );

  /*
   * Whether a *clean* cue is taken is deliberately not asserted, because it is
   * a coin flip, and asserting a coin flip is asserting noise.
   *
   * An earlier version of this scenario claimed both that a clean cue is taken
   * and that a clean cue is refused — and both passed, because `gaussian(0)`
   * still draws from the generator, so two supposedly identical cues were built
   * on different noise realisations. The finding underneath is that with the
   * vertical column scaled properly the decision is genuinely marginal: `gy`
   * carries the mapping on its own, and the cue neither rescues it nor ruins it
   * on a synthetic eye.
   *
   * Which is the point. The cue was introduced to fix a collapse in vertical
   * reach that turned out to be the standardisation bug — it was compensating
   * for a penalty the vertical column should never have been paying. On real
   * faces it then made things considerably worse. That measurement is what
   * decided it, not this scenario.
   */
  const cleanCue = fitWith(gy => gy);
  console.log(
    `      a clean cue is now marginal either way   ` +
      `taken=${cleanCue.regression?.usesLidCue}, and the reach it once rescued no longer needs it`
  );
}

setEyelidCueEnabled(false);

/**
 * Standardisation has to actually standardise.
 *
 * This is the tightest guard on the worst bug in the file it protects. The
 * variance accumulator was initialised to 1 — the fallback divisor for a column
 * with no spread — and then summed squared deviations on top of it, so every
 * column came back at sqrt((1 + spread) / n). With nine anchors that is 0.333
 * for a constant column and 0.334 for the vertical gaze column, whose real
 * spread is 0.011. Nothing was standardised; every column was divided by a third.
 *
 * Ridge regression is scale-sensitive, which is the only reason to standardise
 * before it. So the penalty fell on the columns wildly unevenly: horizontal
 * gaze, with about eight times the spread, lost 4% of its coefficient, and
 * vertical gaze lost 70%. That is the vertical under-reach that has been in
 * every session since the model was written, and the reason an eyelid cue
 * appeared to help — it supplied a second vertical column with enough spread to
 * survive a penalty the first one was being crushed by.
 *
 * The symptom tests above would catch a regression eventually. This one catches
 * it immediately, and says what broke.
 */
{
  console.log('\n--- Standardisation ---');

  // Two columns with very different spreads, plus a constant.
  const rows = [
    [1, 10.0, 0.10],
    [1, 20.0, 0.12],
    [1, 30.0, 0.14],
    [1, 40.0, 0.16],
  ];
  const { mean, std } = standardiseColumns(rows);

  const truth = (col: number) => {
    const vals = rows.map(r => r[col]);
    const m = vals.reduce((a, b) => a + b, 0) / vals.length;
    return Math.sqrt(vals.reduce((s2, v) => s2 + (v - m) ** 2, 0) / vals.length);
  };

  const wide = Math.abs(std[1] - truth(1)) < 1e-9;
  const narrow = Math.abs(std[2] - truth(2)) < 1e-12;
  const constant = std[0] === 1;
  const meansRight = Math.abs(mean[1] - 25) < 1e-9 && Math.abs(mean[2] - 0.13) < 1e-9;

  for (const [ok, label, got, want] of [
    [wide, 'a wide column reports its own spread   ', std[1], truth(1)],
    [narrow, 'so does a narrow one                   ', std[2], truth(2)],
    [constant, 'a constant column falls back to 1      ', std[0], 1],
  ] as Array<[boolean, string, number, number]>) {
    if (!ok) failures++;
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}  ${got.toPrecision(6)}  (want ${want.toPrecision(6)})`);
  }
  if (!meansRight) failures++;
  console.log(`${meansRight ? 'ok  ' : 'FAIL'}  and the means are the means             ${mean[1]}, ${mean[2]}`);

  // The property that actually matters downstream: after standardising, two
  // columns of wildly different raw scale must present the same spread to the
  // penalty, or ridge silently prefers whichever one happened to be measured in
  // bigger units.
  const scaled = rows.map(r => r.map((v, i) => (i === 0 ? 1 : (v - mean[i]) / std[i])));
  const spread = (col: number) => {
    const vals = scaled.map(r => r[col]);
    const m = vals.reduce((a, b) => a + b, 0) / vals.length;
    return Math.sqrt(vals.reduce((s2, v) => s2 + (v - m) ** 2, 0) / vals.length);
  };
  const evened = Math.abs(spread(1) - spread(2)) < 1e-9 && Math.abs(spread(1) - 1) < 1e-9;
  if (!evened) failures++;
  console.log(
    `${evened ? 'ok  ' : 'FAIL'}  and the penalty then falls evenly       ` +
      `${spread(1).toFixed(4)} vs ${spread(2).toFixed(4)} (raw scales differ by ${(truth(1) / truth(2)).toFixed(0)}x)`
  );
}

/**
 * Every row has to be captured early, in the middle, and late.
 *
 * Capture order and screen row correlated at +0.95 in every recorded session,
 * which made posture drift over the minute of set-up indistinguishable from a
 * genuine vertical gaze effect. The property that fixes it is a balance
 * property, so it is worth asserting as one rather than eyeballing a list of
 * ids — a single transposed pair would restore the confound silently.
 */
{
  console.log('\n--- No row is captured only at the start or only at the end ---');

  const grids: Array<[string, any[]]> = [
    ['5-point', QUICK_CALIBRATION_TARGETS],
    ['9-point', DEFAULT_CALIBRATION_TARGETS],
    ['13-point', PRECISION_CALIBRATION_TARGETS],
  ];

  for (const [name, grid] of grids) {
    const ordered = inCaptureOrder(grid);

    const complete =
      ordered.length === grid.length &&
      new Set(ordered.map(t => t.id)).size === grid.length;
    if (!complete) failures++;

    // Pearson correlation between capture position and vertical position.
    const positions = ordered.map((_, i) => i);
    const ys = ordered.map(t => t.yPercent);
    const mp = positions.reduce((a, b) => a + b, 0) / positions.length;
    const my = ys.reduce((a, b) => a + b, 0) / ys.length;
    const num = positions.reduce((sum, p, i) => sum + (p - mp) * (ys[i] - my), 0);
    const den =
      Math.sqrt(positions.reduce((s, p) => s + (p - mp) ** 2, 0)) *
      Math.sqrt(ys.reduce((s, y) => s + (y - my) ** 2, 0));
    const r = den > 0 ? num / den : 0;

    const decorrelated = Math.abs(r) < 0.2;
    if (!decorrelated) failures++;

    const centreFirst =
      Math.abs(ordered[0].xPercent - 50) < 1 && Math.abs(ordered[0].yPercent - 50) < 1;
    if (!centreFirst) failures++;

    console.log(
      `${complete && decorrelated && centreFirst ? 'ok  ' : 'FAIL'}  ${name.padEnd(9)} ` +
        `order vs row r = ${r >= 0 ? '+' : ''}${r.toFixed(2)}  ` +
        `(was +0.95 raster)  first point (${ordered[0].xPercent}, ${ordered[0].yPercent})  ` +
        `${ordered.length}/${grid.length} points`
    );
  }
}

console.log(failures === 0 ? '\nAll calibration checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
