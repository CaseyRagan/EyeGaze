import { GazeState } from '../types';
import { gradeEquivalentFor, normForGrade } from '../data/readingNorms';
import { viewingGeometry } from './viewingGeometry';

/**
 * Reading eye-movement analysis.
 *
 * The measures here are the ones clinical reading-eye-movement instruments
 * report — fixations and regressions per hundred words, span of recognition,
 * mean fixation duration, and reading rate with comprehension — computed from
 * fixations mapped onto the actual words on screen rather than from raw
 * pointer motion.
 */

/** One word's position on screen, in viewport pixels. */
export interface WordBox {
  index: number;
  line: number;
  text: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface RawGazeSample {
  x: number;
  y: number;
  time: number;
  isFixating: boolean;
  confidence: number;
  headYaw: number;
  headPitch: number;
  headRoll: number;
}

export interface Fixation {
  x: number;
  y: number;
  startTime: number;
  endTime: number;
  durationMs: number;
  wordIndex: number | null;
  line: number | null;
  /** Position in the sequence of fixations that landed on text. */
  order: number;
  isRegression: boolean;
  isReturnSweep: boolean;
}

export interface ReadingAnalysis {
  fixations: Fixation[];
  onTextFixations: number;
  wordCount: number;
  durationSec: number;

  fixationsPer100Words: number;
  regressionsPer100Words: number;
  spanOfRecognition: number;
  averageFixationDurationSec: number;
  readingRateWpm: number;
  readingRateWithComprehensionWpm: number;
  comprehensionPercent: number;

  /** Share of word-to-word movements that went forward. */
  directionalAttackPercent: number;
  /** Share of the passage's words that received at least one fixation. */
  wordCoveragePercent: number;

  gradeEquivalents: {
    fixations: number | null;
    regressions: number | null;
    span: number | null;
    duration: number | null;
    rate: number | null;
    overall: number | null;
  };

  /** Fraction of samples that were usable; low values invalidate the report. */
  trackingRatio: number;
  /** Total head rotation per second, in degrees — a proxy for head-led reading. */
  headMovementDegPerSec: number;
  /** How far the reader's grade equivalents spread; wide spread means a mixed profile. */
  profileConsistency: number;
}

/** Minimum time on a spot before it counts as a fixation. */
const MIN_FIXATION_MS = 80;
/**
 * Gaps shorter than this (a blink, a dropped frame) do not split a fixation.
 *
 * Sized for a blink rather than a dropped frame. A spontaneous blink closes the
 * lids for 100-150 ms and people blink around fifteen times a minute, so at the
 * old 75 ms threshold a normal reader's blinks each cut one fixation in two and
 * inflated the fixations-per-hundred-words count by several percent — a
 * measurement error that pushed every grade equivalent the wrong way. The
 * distance test below still applies, so two fixations genuinely separated by a
 * saccade are never merged however close together in time they fall.
 */
const MERGE_GAP_MS = 250;
/** Two fixation clusters within this angle are treated as one fixation. */
const MERGE_DISTANCE_DEG = 1.0;
/** A fixation must land within this distance of a line to be counted as on-text. */
const LINE_TOLERANCE_FACTOR = 0.9;

/**
 * Groups a raw sample stream into fixations. This runs offline over the whole
 * recording rather than live, so it can merge across dropouts that a real-time
 * classifier has to guess about.
 */
export function extractFixations(samples: RawGazeSample[]): Array<Omit<Fixation, 'wordIndex' | 'line' | 'order' | 'isRegression' | 'isReturnSweep'>> {
  const clusters: Array<{ xs: number[]; ys: number[]; start: number; end: number }> = [];
  let current: { xs: number[]; ys: number[]; start: number; end: number } | null = null;

  for (const s of samples) {
    if (!s.isFixating || s.confidence < 0.2) {
      if (current) {
        clusters.push(current);
        current = null;
      }
      continue;
    }
    if (!current) {
      current = { xs: [s.x], ys: [s.y], start: s.time, end: s.time };
    } else if (s.time - current.end > MERGE_GAP_MS) {
      clusters.push(current);
      current = { xs: [s.x], ys: [s.y], start: s.time, end: s.time };
    } else {
      current.xs.push(s.x);
      current.ys.push(s.y);
      current.end = s.time;
    }
  }
  if (current) clusters.push(current);

  const mergeDistancePx = viewingGeometry.degreesToPixels(MERGE_DISTANCE_DEG);

  const fixations: Array<{ x: number; y: number; startTime: number; endTime: number; durationMs: number }> = [];
  for (const c of clusters) {
    const x = c.xs.reduce((a, b) => a + b, 0) / c.xs.length;
    const y = c.ys.reduce((a, b) => a + b, 0) / c.ys.length;
    const durationMs = c.end - c.start;

    const previous = fixations[fixations.length - 1];
    if (
      previous &&
      c.start - previous.endTime <= MERGE_GAP_MS &&
      Math.hypot(x - previous.x, y - previous.y) <= mergeDistancePx
    ) {
      // Same spot, brief interruption: extend rather than start a new fixation.
      const total = previous.durationMs + durationMs;
      const w = total > 0 ? previous.durationMs / total : 0.5;
      previous.x = previous.x * w + x * (1 - w);
      previous.y = previous.y * w + y * (1 - w);
      previous.endTime = c.end;
      previous.durationMs = previous.endTime - previous.startTime;
      continue;
    }

    if (durationMs < MIN_FIXATION_MS) continue;
    fixations.push({ x, y, startTime: c.start, endTime: c.end, durationMs });
  }

  return fixations;
}

/** Finds the word a fixation landed on, or null if it fell outside the text. */
function assignToWord(x: number, y: number, words: WordBox[], lineHeight: number): WordBox | null {
  let best: WordBox | null = null;
  let bestScore = Infinity;
  const verticalTolerance = lineHeight * LINE_TOLERANCE_FACTOR;

  for (const w of words) {
    const centreY = (w.top + w.bottom) / 2;
    const dy = Math.abs(y - centreY);
    if (dy > verticalTolerance) continue;

    const dx = x < w.left ? w.left - x : x > w.right ? x - w.right : 0;
    // Vertical distance is weighted more heavily: landing on the wrong line is
    // a bigger error than landing between two words on the right line.
    const score = dx + dy * 2;
    if (score < bestScore) {
      bestScore = score;
      best = w;
    }
  }

  // Reject fixations that are far to the side of every word on the line.
  if (best && bestScore > lineHeight * 3) return null;
  return best;
}

export function analyseReading(params: {
  samples: RawGazeSample[];
  words: WordBox[];
  lineHeight: number;
  wordCount: number;
  durationSec: number;
  comprehensionPercent: number;
}): ReadingAnalysis {
  const { samples, words, lineHeight, wordCount, durationSec, comprehensionPercent } = params;

  const rawFixations = extractFixations(samples);

  const fixations: Fixation[] = [];
  let order = 0;
  let previousOnText: Fixation | null = null;
  let forwardMoves = 0;
  let backwardMoves = 0;
  const fixatedWords = new Set<number>();

  for (const f of rawFixations) {
    const word = assignToWord(f.x, f.y, words, lineHeight);

    const fixation: Fixation = {
      ...f,
      wordIndex: word?.index ?? null,
      line: word?.line ?? null,
      order: word ? order++ : -1,
      isRegression: false,
      isReturnSweep: false,
    };

    if (word) {
      fixatedWords.add(word.index);

      if (previousOnText && previousOnText.line !== null && fixation.line !== null) {
        if (fixation.line > previousOnText.line) {
          // Moving down a line is a return sweep, which is forward progress.
          fixation.isReturnSweep = true;
          forwardMoves++;
        } else if (fixation.line < previousOnText.line) {
          fixation.isRegression = true;
          backwardMoves++;
        } else if (fixation.wordIndex! < previousOnText.wordIndex!) {
          fixation.isRegression = true;
          backwardMoves++;
        } else if (fixation.wordIndex! > previousOnText.wordIndex!) {
          forwardMoves++;
        }
      }
      previousOnText = fixation;
    }

    fixations.push(fixation);
  }

  const onText = fixations.filter(f => f.wordIndex !== null);
  const onTextFixations = onText.length;
  const regressions = onText.filter(f => f.isRegression).length;

  const per100 = wordCount > 0 ? 100 / wordCount : 0;
  const fixationsPer100Words = onTextFixations * per100;
  const regressionsPer100Words = regressions * per100;
  const spanOfRecognition = onTextFixations > 0 ? wordCount / onTextFixations : 0;

  const averageFixationDurationSec =
    onTextFixations > 0 ? onText.reduce((sum, f) => sum + f.durationMs, 0) / onTextFixations / 1000 : 0;

  const readingRateWpm = durationSec > 0 ? (wordCount / durationSec) * 60 : 0;
  const readingRateWithComprehensionWpm = readingRateWpm * (comprehensionPercent / 100);

  const totalMoves = forwardMoves + backwardMoves;
  const directionalAttackPercent = totalMoves > 0 ? (forwardMoves / totalMoves) * 100 : 0;
  const wordCoveragePercent = wordCount > 0 ? (fixatedWords.size / wordCount) * 100 : 0;

  const usableSamples = samples.filter(s => s.confidence >= 0.2).length;
  const trackingRatio = samples.length > 0 ? usableSamples / samples.length : 0;

  // Head movement: total rotation travelled per second of reading. A reader who
  // moves their head instead of their eyes shows up clearly here, and it is a
  // target of therapy in its own right.
  let totalRotationRad = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    totalRotationRad += Math.hypot(b.headYaw - a.headYaw, b.headPitch - a.headPitch, b.headRoll - a.headRoll);
  }
  const headMovementDegPerSec = durationSec > 0 ? (totalRotationRad * (180 / Math.PI)) / durationSec : 0;

  // With nothing on the text there is nothing to grade. Each individual
  // measure would otherwise be handed a zero and asked what it meant.
  const measured = onTextFixations > 0;

  const gradeEquivalents = {
    fixations: measured ? gradeEquivalentFor('fixationsPer100Words', fixationsPer100Words) : null,
    regressions: measured ? gradeEquivalentFor('regressionsPer100Words', regressionsPer100Words) : null,
    span: measured ? gradeEquivalentFor('spanOfRecognition', spanOfRecognition) : null,
    duration: measured ? gradeEquivalentFor('averageFixationDuration', averageFixationDurationSec) : null,
    rate: measured ? gradeEquivalentFor('readingRate', readingRateWithComprehensionWpm) : null,
    overall: null as number | null,
  };

  const presentGrades = [
    gradeEquivalents.fixations,
    gradeEquivalents.regressions,
    gradeEquivalents.span,
    gradeEquivalents.rate,
  ].filter((g): g is number => g !== null);

  // An "overall" figure drawn from a single surviving measure is not an
  // overall figure, and reporting one from a recording where the eyes were
  // barely tracked is how a tool ends up quoting a grade level it has no basis
  // for. Three of the four measures have to be present.
  gradeEquivalents.overall =
    presentGrades.length >= 3 ? presentGrades.reduce((a, b) => a + b, 0) / presentGrades.length : null;

  // A wide spread between the individual grade equivalents is itself
  // informative: it usually means efficiency and speed have come apart.
  let profileConsistency = 1;
  if (presentGrades.length >= 2) {
    const spread = Math.max(...presentGrades) - Math.min(...presentGrades);
    profileConsistency = Math.max(0, 1 - spread / 8);
  }

  return {
    fixations,
    onTextFixations,
    wordCount,
    durationSec,
    fixationsPer100Words,
    regressionsPer100Words,
    spanOfRecognition,
    averageFixationDurationSec,
    readingRateWpm,
    readingRateWithComprehensionWpm,
    comprehensionPercent,
    directionalAttackPercent,
    wordCoveragePercent,
    gradeEquivalents,
    trackingRatio,
    headMovementDegPerSec,
    profileConsistency,
  };
}

/** Turns a live gaze sample into the compact form the analysis consumes. */
export function toRawSample(gaze: GazeState): RawGazeSample {
  return {
    x: gaze.screenX,
    y: gaze.screenY,
    time: gaze.timestamp,
    isFixating: gaze.isFixating,
    confidence: gaze.isHeld ? 0 : gaze.confidence,
    headYaw: gaze.headPose.yaw,
    headPitch: gaze.headPose.pitch,
    headRoll: gaze.headPose.roll,
  };
}

/** Plain-language interpretation lines for the report. */
export function interpretReading(analysis: ReadingAnalysis): string[] {
  const notes: string[] = [];
  const overall = analysis.gradeEquivalents.overall;

  if (analysis.onTextFixations === 0) {
    notes.push(
      'No fixations were recorded on the text at all. Either tracking was lost, or the mapping is far enough out that the gaze never landed on a word. Run set-up again before repeating this.'
    );
    return notes;
  }

  if (analysis.onTextFixations < 20) {
    notes.push(
      'Very few fixations were recorded, so the per-hundred-word figures rest on too little data to interpret. Check the accuracy figure and repeat the passage.'
    );
  }

  if (analysis.trackingRatio < 0.7) {
    notes.push(
      'Tracking was intermittent for part of this passage, so treat these numbers as indicative only. Check lighting and seating, then run it again.'
    );
  }

  if (overall !== null) {
    const norm = normForGrade(overall);
    if (analysis.regressionsPer100Words > norm.regressionsPer100Words * 1.4) {
      notes.push(
        'Regressions are high relative to the rest of the profile. Re-reading this often usually points to comprehension effort or to difficulty holding place on the line, rather than to decoding speed.'
      );
    }
    if (analysis.spanOfRecognition < norm.spanOfRecognition * 0.8) {
      notes.push(
        'A short span of recognition means fewer words are being taken in per stop. Widening this is often the most productive target, and it tends to pull reading rate along with it.'
      );
    }
    if (analysis.averageFixationDurationSec > norm.averageFixationDuration * 1.25) {
      notes.push(
        'Fixations are lasting longer than expected. Long stops with an otherwise typical pattern usually reflect processing time rather than an oculomotor difficulty.'
      );
    }
  }

  if (analysis.headMovementDegPerSec > 6) {
    notes.push(
      'A lot of head movement accompanied this reading. Some readers use the head to lead the eyes; if that is happening, stabilising the head is worth addressing before re-measuring.'
    );
  }

  if (analysis.directionalAttackPercent > 88 && analysis.profileConsistency > 0.6) {
    notes.push('Eye movements were consistently left-to-right with an even rhythm across lines.');
  }

  if (analysis.wordCoveragePercent < 55) {
    notes.push(
      'Fewer than half the words received a fixation. That can indicate efficient reading, or it can mean the mapping drifted during the passage — check the accuracy figure before concluding either.'
    );
  }

  if (notes.length === 0) {
    notes.push('This profile sits close to expectation across all four measures.');
  }

  return notes;
}
