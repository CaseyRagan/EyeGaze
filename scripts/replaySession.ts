/**
 * Replays a saved session against alternative models.
 *
 *   bun run replay path/to/lantern-session-....json
 *
 * The point of the recording is that a change to the mapping can be argued from
 * a real client's eyes instead of from synthetic data and a plausible story.
 * This is the other half of that: it rebuilds the calibration from the samples
 * that were actually collected, reproduces the accuracy figure the client was
 * shown — which proves the recording is complete enough to reason from — and
 * then refits the same samples under variations, scoring each on the validation
 * points the model never saw.
 *
 * Everything is measured on held-out points. A variation that fits the
 * calibration grid better and the validation worse is a variation that has
 * learned the grid, and the table says so.
 */

// The engine reaches for the DOM for viewport size and storage.
const viewport = { width: 1456, height: 949 };
const store = new Map<string, string>();
(globalThis as any).window = {
  get innerWidth() {
    return viewport.width;
  },
  get innerHeight() {
    return viewport.height;
  },
  screen: { width: 1512, height: 982 },
  devicePixelRatio: 2,
};
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
(globalThis as any).navigator = { userAgent: 'replay' };

const { CalibrationEngine } = await import('../src/services/calibration');
const { viewingGeometry } = await import('../src/services/viewingGeometry');

const path = process.argv[2];
if (!path) {
  console.error('usage: bun run replay <session-file.json>');
  process.exit(1);
}

const { readFileSync } = await import('node:fs');
const record = JSON.parse(readFileSync(path, 'utf8'));

if (!record.capture?.length || !record.validation?.length) {
  console.error('That file has no calibration or validation points in it.');
  process.exit(1);
}

viewport.width = record.environment?.viewport?.width ?? viewport.width;
viewport.height = record.environment?.viewport?.height ?? viewport.height;
if (record.environment?.screen) {
  (globalThis as any).window.screen = record.environment.screen;
}
viewingGeometry.updateSettings(record.geometry.settings);
// The distance is a property of the session, not of this machine.
viewingGeometry.setMeasuredDistanceCm(
  record.geometry.effectiveDistanceCm / (record.geometry.settings.distanceScale || 1),
  record.geometry.measurementAgreement ?? 1
);

const W = viewport.width;
const H = viewport.height;

interface RecordedPoint {
  id: string;
  label?: string;
  xNorm: number;
  yNorm: number;
  samples: any[];
  settled: boolean[];
  timestamps: number[];
  usedSampleCount: number;
}

/*
  Recordings made before v3 hold head yaw in the camera's frame while every other
  quantity in them is mirrored. Flipping it here keeps old sessions comparable
  with new ones instead of quietly scoring them under a convention they were not
  measured in.
*/
if ((record.version ?? 1) < 3) {
  const flip = (samples: any[]) => samples.forEach(s => { s.headYaw = -s.headYaw; });
  for (const p of [...record.capture, ...record.validation]) flip(p.samples);
  if (record.headPass?.samples) flip(record.headPass.samples);
  console.log('(pre-v3 recording: head yaw flipped into the mirrored frame)');
}

const capture: RecordedPoint[] = record.capture;
const validation: RecordedPoint[] = record.validation;

console.log(`\n=== ${path} ===`);
console.log(
  `captured ${record.capturedAt}  ·  ${capture.length} calibration points, ` +
    `${validation.length} check points  ·  ${record.depth}, ` +
    `${record.confirmMode ? 'space-bar confirmed' : 'hands-free'}`
);
console.log(
  `screen ${record.geometry.settings.screenDiagonalInches}" (${record.geometry.settings.screenSizeSource ?? 'unknown'})  ·  ` +
    `distance ${record.geometry.effectiveDistanceCm.toFixed(1)} cm (${record.geometry.distanceConfidence})`
);

/** The samples an anchor should be built from, under one selection rule. */
function samplesFor(point: RecordedPoint, rule: 'settled' | 'all'): any[] {
  if (rule === 'all') return point.samples;
  const settled = point.samples.filter((_, i) => point.settled[i]);
  return settled.length >= 8 ? settled : point.samples;
}

interface Variant {
  label: string;
  rule?: 'settled' | 'all';
  degree?: number | null;
  headGain?: { rotation: number; translation: number } | null;
  stripResiduals?: boolean;
}

function evaluate(variant: Variant) {
  const engine = new CalibrationEngine();
  engine.reset();

  for (const point of capture) {
    const samples = samplesFor(point, variant.rule ?? 'settled');
    if (samples.length === 0) continue;
    engine.addAnchorFromSamples(`p${point.id}`, point.xNorm, point.yNorm, samples, point.label);
  }
  if (!engine.isCalibrated()) return null;

  // The head-movement pass, replayed the same way the session ran it.
  if (record.headPass?.samples?.length && variant.headGain === undefined) {
    engine.fitHeadGainFromMotionPass(record.headPass.samples);
  } else if (variant.headGain) {
    engine.setHeadGain(variant.headGain);
  }

  if (variant.degree != null) engine.overrideFeatureDegree(variant.degree);

  const model = engine.getModel();
  if (variant.stripResiduals && model.regression) {
    (model.regression as any).residuals = [];
  }

  // Score on the check points, which no variant was fitted on.
  let sum = 0;
  let counted = 0;
  const perPoint: number[] = [];

  for (const point of validation) {
    const samples = samplesFor(point, variant.rule ?? 'settled');
    if (samples.length === 0) continue;

    let sx = 0;
    let sy = 0;
    let n = 0;
    for (const s of samples) {
      const mapped = engine.mapToScreen(
        s.gx,
        s.gy,
        {
          yaw: s.headYaw,
          pitch: s.headPitch,
          roll: 0,
          translateX: s.headTranslateX,
          translateY: s.headTranslateY,
          distanceCm: record.geometry.effectiveDistanceCm,
          distanceAgreement: 1,
          interocularSpan: 0.08,
        },
        W,
        H
      );
      if (!mapped) continue;
      sx += mapped.x;
      sy += mapped.y;
      n++;
    }
    if (n === 0) continue;

    const errorPx = Math.hypot(sx / n - point.xNorm * W, sy / n - point.yNorm * H);
    perPoint.push(viewingGeometry.pixelsToDegrees(errorPx));
    sum += errorPx;
    counted++;
  }

  if (counted === 0) return null;
  const meanPx = sum / counted;
  return {
    meanPx,
    meanDeg: viewingGeometry.pixelsToDegrees(meanPx),
    perPoint,
    looPx: engine.getModel().quality?.crossValidatedErrorPx ?? NaN,
    degree: engine.getModel().quality?.featureDegree ?? NaN,
    headGain: engine.getModel().headGain,
  };
}

// --- What the client was actually shown -------------------------------------

const asRun = evaluate({ label: 'as it ran' });
if (!asRun) {
  console.error('\nCould not rebuild the calibration from this recording.');
  process.exit(1);
}

const reported = record.result?.accuracyDeg;
console.log('\n--- Reproducing the session ---');
console.log(`replayed accuracy   ${asRun.meanDeg.toFixed(2)}°  (${asRun.meanPx.toFixed(0)} px)`);
if (typeof reported === 'number') {
  const drift = Math.abs(asRun.meanDeg - reported);
  // A difference means one of two things, and they are opposite in sign: either
  // the recording is missing something the live run had, or the mapping has
  // been changed since and the replay is showing what this session *would* have
  // scored under the current code. The second is the entire point of keeping
  // recordings, so it is not reported as a fault.
  console.log(
    `reported at the time ${reported.toFixed(2)}°  ` +
      (drift < 0.5
        ? '— matches, so the recording is complete'
        : drift > 0 && asRun.meanDeg < reported
          ? `— ${drift.toFixed(2)}° better under the current mapping`
          : `— ${drift.toFixed(2)}° worse under the current mapping`)
  );
}

// --- What else the same samples could have produced --------------------------

const variants: Variant[] = [
  { label: 'as it ran' },
  { label: 'no head compensation', headGain: { rotation: 0, translation: 0 } },
  { label: 'nominal head gain', headGain: { rotation: 1, translation: 1 } },
  { label: 'global fit only (no local term)', stripResiduals: true },
  { label: 'straight line (degree 1)', degree: 1 },
  { label: 'with cross term (degree 2)', degree: 2 },
  { label: 'full quadratic (degree 3)', degree: 3 },
  { label: 'every sample, settled or not', rule: 'all' },
];

/**
 * How much head compensation this client's eyes actually wanted.
 *
 * When the movement pass fails to measure the gain, the nominal constants are
 * applied at full strength on the reasoning that textbook anatomy is better than
 * nothing. Whether that is true is an empirical question about a particular
 * person, and it is answerable here: sweep the multiplier and see where the
 * held-out error is lowest.
 */
const sweep: Variant[] = [-1, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1, 1.5, 2].map(k => ({
  label: `head gain x${k}`,
  headGain: { rotation: k, translation: k },
}));

console.log('\n--- Same samples, different model (scored on the check points) ---');
let best = { label: '', deg: Infinity };
for (const variant of variants) {
  const result = evaluate(variant);
  if (!result) {
    console.log(`  ${variant.label.padEnd(34)} did not fit`);
    continue;
  }
  if (result.meanDeg < best.deg) best = { label: variant.label, deg: result.meanDeg };
  const gain = result.headGain
    ? `${result.headGain.rotation.toFixed(2)}/${result.headGain.translation.toFixed(2)}`
    : 'none';
  console.log(
    `  ${variant.label.padEnd(34)} ${result.meanDeg.toFixed(2)}°  ` +
      `(${result.meanPx.toFixed(0)} px)   loo ${result.looPx.toFixed(0)} px   ` +
      `terms ${result.degree}   gain ${gain}`
  );
}
console.log(`\n  best here: ${best.label} at ${best.deg.toFixed(2)}°`);

console.log('\n--- How much head compensation did these eyes want? ---');
let bestGain = { k: '', deg: Infinity };
for (const variant of sweep) {
  const result = evaluate(variant);
  if (!result) continue;
  if (result.meanDeg < bestGain.deg) bestGain = { k: variant.label, deg: result.meanDeg };
  const bar = '#'.repeat(Math.max(1, Math.round(result.meanDeg * 6)));
  console.log(`  ${variant.label.padEnd(16)} ${result.meanDeg.toFixed(2)}°  ${bar}`);
}
console.log(`  → lowest at ${bestGain.k}`);

// --- Did the head-movement pass contain any head movement? ------------------
//
// The pass can complete, report success, and have measured nothing — the fit
// falls back to the textbook constants rather than failing loudly. The spread of
// the poses it saw is the direct answer, and it is worth knowing before reading
// anything else here, because a nominal gain means every head-compensation row
// above is comparing the same model to itself.

if (record.headPass?.samples?.length) {
  const spread = (key: string) => {
    const values = record.headPass.samples.map((s: any) => s[key]);
    return Math.max(...values) - Math.min(...values);
  };
  const yawDeg = (spread('headYaw') * 180) / Math.PI;
  const pitchDeg = (spread('headPitch') * 180) / Math.PI;
  console.log('\n--- The head-movement pass ---');
  console.log(
    `  ${record.headPass.samples.length} samples, reported "${record.headPass.outcome}"  ·  ` +
      `yaw swept ${yawDeg.toFixed(1)}°, pitch ${pitchDeg.toFixed(1)}°  ·  ` +
      `ring ${Object.entries(record.headPass.coverage ?? {})
        .map(([k, v]) => `${k[0].toUpperCase()}${(v as number).toFixed(2)}`)
        .join(' ')}`
  );
  if (yawDeg < 4 && pitchDeg < 4) {
    console.log('  → barely any movement, so nothing could have been measured from it.');
  }
}

// --- Where the session was unsteady -----------------------------------------

console.log('\n--- Per point ---');
for (let i = 0; i < validation.length; i++) {
  const p = validation[i];
  const deg = asRun.perPoint[i];
  const heads = p.samples.map((s: any) => s.headYaw);
  const yawSpreadDeg =
    heads.length > 1
      ? ((Math.max(...heads) - Math.min(...heads)) * 180) / Math.PI
      : 0;
  console.log(
    `  check ${String(p.id).padEnd(3)} (${p.xNorm.toFixed(2)}, ${p.yNorm.toFixed(2)})  ` +
      `${deg !== undefined ? `${deg.toFixed(2)}°` : '  —  '}  ` +
      `${p.samples.length} samples, ${p.settled.filter(Boolean).length} settled, ` +
      `head moved ${yawSpreadDeg.toFixed(1)}°`
  );
}

/**
 * How far the head drifted between teaching the model and checking it.
 *
 * This is the difference the head compensation has to absorb, and the one place
 * a session can look fine throughout and still produce a poor figure — the grid
 * is internally consistent, the check is internally consistent, and they
 * describe two different head positions.
 */
const meanOf = (values: number[]) => values.reduce((a, b) => a + b, 0) / (values.length || 1);
const poseOf = (points: RecordedPoint[], key: string) =>
  meanOf(points.flatMap(p => p.samples.map((s: any) => s[key])));

console.log('\n--- Head position: grid vs check ---');
for (const [key, label, unit] of [
  ['headYaw', 'yaw', 'deg'],
  ['headPitch', 'pitch', 'deg'],
  ['headTranslateX', 'sideways', 'units'],
  ['headTranslateY', 'vertical', 'units'],
] as const) {
  const a = poseOf(capture, key);
  const b = poseOf(validation, key);
  const scale = unit === 'deg' ? 180 / Math.PI : 1;
  console.log(
    `  ${label.padEnd(10)} grid ${(a * scale).toFixed(2)}  check ${(b * scale).toFixed(2)}  ` +
      `drift ${((b - a) * scale).toFixed(2)} ${unit}`
  );
}
