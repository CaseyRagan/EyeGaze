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

const { CalibrationEngine } = await import('../src/services/calibration');
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
    gx: 0.16 * u + 0.03 * u * v - 0.02 * u * u * Math.sign(u) + headGx,
    gy: 0.14 * v - 0.025 * v * v * Math.sign(v) + 0.015 * u * v + headGy,
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

function makeSamples(xNorm: number, yNorm: number, noise: number, count = 30, posture: Posture = STILL) {
  return Array.from({ length: count }, () => {
    // Small involuntary posture variation within a single dwell.
    const jittered: Posture = {
      yaw: posture.yaw + gaussian(0.01),
      pitch: posture.pitch + gaussian(0.01),
      translateX: posture.translateX + gaussian(0.004),
      translateY: posture.translateY + gaussian(0.004),
    };
    const truth = trueFeatureFor(xNorm, yNorm, jittered);
    return {
      gx: truth.gx + gaussian(noise),
      gy: truth.gy + gaussian(noise),
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
      distanceCm: 55, interocularSpan: 0.1,
    };

    let sumErrorPx = 0;
    let worstPx = 0;
    let worstLabel = '';
    let spanX = { min: Infinity, max: -Infinity };

    for (const [x, y] of TEST_POINTS) {
      const truth = trueFeatureFor(x, y);
      const mapped = engine.mapToScreen(truth.gx, truth.gy, headPose, WIDTH, HEIGHT);
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
        `reach ${(reachFraction * 100).toFixed(0)}%`
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
      const truth = trueFeatureFor(x, y, posture);
      const mapped = engine.mapToScreen(
        truth.gx,
        truth.gy,
        { yaw: posture.yaw, pitch: posture.pitch, roll: 0, translateX: posture.translateX, translateY: posture.translateY, distanceCm: 55, interocularSpan: 0.1 },
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
    const truth = trueFeatureFor(0.5, 0.5, jittered);
    return {
      gx: truth.gx + gaussian(0.0016),
      gy: truth.gy + gaussian(0.0016),
      headYaw: jittered.yaw,
      headPitch: jittered.pitch,
      headTranslateX: jittered.translateX,
      headTranslateY: jittered.translateY,
      quality: 0.9,
    };
  });

  const fittedGain = withPass.fitHeadGainFromMotionPass(motionSamples);
  console.log(
    `      head-movement pass measured gain: rotation ${fittedGain?.rotation.toFixed(2)}, ` +
      `translation ${fittedGain?.translation.toFixed(2)} (truth implies 1.30 / 1.30)`
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

console.log(failures === 0 ? '\nAll calibration checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
