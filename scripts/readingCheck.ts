/**
 * Checks the reading eye-movement measures against hand-built gaze streams.
 *
 * Run with: bun run check:reading
 *
 * These numbers end up next to developmental norms in something a clinician may
 * put in a file, so the arithmetic that produces them deserves a test that does
 * not involve a person, a camera, or a judgement call about what happened.
 */

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

const { analyseReading, extractFixations } = await import('../src/services/readingMetrics');
const { viewingGeometry } = await import('../src/services/viewingGeometry');
import type { RawGazeSample, WordBox } from '../src/services/readingMetrics';

viewingGeometry.updateSettings({
  screenDiagonalInches: 15.6,
  assumedDistanceCm: 55,
  useMeasuredDistance: false,
});

const SAMPLE_MS = 33;
let failures = 0;

function check(label: string, ok: boolean, detail: string) {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(46)} ${detail}`);
}

/** A run of samples sitting still at one spot. */
function dwell(x: number, y: number, ms: number, startTime: number, fixating = true): RawGazeSample[] {
  const out: RawGazeSample[] = [];
  for (let t = 0; t < ms; t += SAMPLE_MS) {
    out.push({
      x: x + (Math.random() - 0.5) * 2,
      y: y + (Math.random() - 0.5) * 2,
      time: startTime + t,
      isFixating: fixating,
      confidence: fixating ? 0.9 : 0.05,
      headYaw: 0,
      headPitch: 0,
      headRoll: 0,
    });
  }
  return out;
}

// --- A blink in the middle of a fixation ------------------------------------
{
  // Someone looks at a word for 200 ms, blinks for 150 ms, and carries on
  // looking at the same word for another 200 ms. That is one fixation.
  const samples = [
    ...dwell(400, 300, 200, 0),
    ...dwell(400, 300, 150, 200, false),
    ...dwell(400, 300, 200, 350),
  ];
  const fixations = extractFixations(samples);
  check(
    'blink does not split one fixation',
    fixations.length === 1,
    `${fixations.length} fixation(s), expected 1`
  );
}

// --- A real saccade between two words ---------------------------------------
{
  // Same shape of interruption, but the eye lands somewhere else afterwards.
  // That is two fixations however brief the gap.
  const samples = [
    ...dwell(400, 300, 200, 0),
    ...dwell(400, 300, 100, 200, false),
    ...dwell(700, 300, 200, 300),
  ];
  const fixations = extractFixations(samples);
  check(
    'a genuine saccade still splits fixations',
    fixations.length === 2,
    `${fixations.length} fixation(s), expected 2`
  );
}

// --- Regressions are backward movements, not any leftward motion ------------
{
  const lineHeight = 30;
  const words: WordBox[] = [];
  // Two lines of ten words.
  for (let line = 0; line < 2; line++) {
    for (let i = 0; i < 10; i++) {
      words.push({
        index: line * 10 + i,
        line,
        text: `w${i}`,
        left: 100 + i * 60,
        right: 150 + i * 60,
        top: 200 + line * 50,
        bottom: 200 + line * 50 + lineHeight,
      });
    }
  }

  const centreOf = (i: number) => ({
    x: (words[i].left + words[i].right) / 2,
    y: (words[i].top + words[i].bottom) / 2,
  });

  let t = 0;
  const samples: RawGazeSample[] = [];
  // Read words 0-4, glance back to word 2, carry on, then sweep to line two.
  for (const idx of [0, 1, 2, 3, 4, 2, 5, 6, 7, 8, 9, 10, 11, 12, 13]) {
    const c = centreOf(idx);
    samples.push(...dwell(c.x, c.y, 200, t));
    t += 200;
    samples.push(...dwell(c.x, c.y, 60, t, false));
    t += 60;
  }

  const analysis = analyseReading({
    samples,
    words,
    lineHeight,
    wordCount: 20,
    durationSec: t / 1000,
    comprehensionPercent: 100,
  });

  const regressions = analysis.fixations.filter(f => f.isRegression).length;
  const returnSweeps = analysis.fixations.filter(f => f.isReturnSweep).length;

  check(
    'the single backward glance is one regression',
    regressions === 1,
    `${regressions} regression(s), expected 1`
  );
  check(
    'moving down to the next line is not a regression',
    returnSweeps === 1,
    `${returnSweeps} return sweep(s), expected 1`
  );
  check(
    'fixations land on the words they were over',
    analysis.onTextFixations === 15,
    `${analysis.onTextFixations} on text, expected 15`
  );
}

// --- Nothing on the text is reported as nothing, not as zeros ---------------
{
  const words: WordBox[] = [
    { index: 0, line: 0, text: 'a', left: 100, right: 150, top: 200, bottom: 230 },
  ];
  // Fixating steadily, but a long way from any word.
  const samples = dwell(1200, 800, 1000, 0);
  const analysis = analyseReading({
    samples,
    words,
    lineHeight: 30,
    wordCount: 20,
    durationSec: 1,
    comprehensionPercent: 100,
  });

  check(
    'gaze off the text yields no on-text fixations',
    analysis.onTextFixations === 0,
    `${analysis.onTextFixations} on text, expected 0`
  );
  check(
    'no overall grade is claimed from nothing',
    analysis.gradeEquivalents.overall === null,
    `overall was ${analysis.gradeEquivalents.overall}`
  );
}

console.log(failures === 0 ? '\nAll reading checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
