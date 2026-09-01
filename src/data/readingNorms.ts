/**
 * Developmental norms for reading eye movements.
 *
 * These are the Taylor / Taylor, Frackenpohl & Pettee developmental norms
 * (Educational Developmental Laboratories, 1960), which are the reference set
 * the established clinical reading-eye-movement instruments — the Visagraph
 * and the ReadAlyzer among them — report against. They are included here so
 * this tool can put a client's numbers next to a grade expectation rather than
 * leaving a clinician to interpret raw counts.
 *
 * Two honest caveats, surfaced in the report UI as well as here:
 *
 *  1. The norms were collected with infrared limbal-reflection instruments on
 *     printed text. A webcam reading a screen is a different measurement, and
 *     agreement has not been established. Treat the grade equivalent as a
 *     conversation starter and a within-client progress measure, not as a
 *     diagnostic score.
 *  2. They are more than sixty years old and were normed on a US school
 *     population of the period. Verify against whatever reference your service
 *     actually uses before putting a number in a report.
 */

export interface ReadingNorm {
  /** Grade level; 13 represents college, 14 an adult reader. */
  grade: number;
  label: string;
  fixationsPer100Words: number;
  regressionsPer100Words: number;
  /** Words recognised per fixation. */
  spanOfRecognition: number;
  /** Seconds. */
  averageFixationDuration: number;
  /** Words per minute, adjusted for comprehension. */
  readingRate: number;
}

export const TAYLOR_NORMS: ReadingNorm[] = [
  { grade: 1, label: 'Grade 1', fixationsPer100Words: 224, regressionsPer100Words: 52, spanOfRecognition: 0.45, averageFixationDuration: 0.33, readingRate: 80 },
  { grade: 2, label: 'Grade 2', fixationsPer100Words: 174, regressionsPer100Words: 40, spanOfRecognition: 0.57, averageFixationDuration: 0.30, readingRate: 115 },
  { grade: 3, label: 'Grade 3', fixationsPer100Words: 155, regressionsPer100Words: 35, spanOfRecognition: 0.65, averageFixationDuration: 0.28, readingRate: 138 },
  { grade: 4, label: 'Grade 4', fixationsPer100Words: 139, regressionsPer100Words: 31, spanOfRecognition: 0.72, averageFixationDuration: 0.27, readingRate: 158 },
  { grade: 5, label: 'Grade 5', fixationsPer100Words: 129, regressionsPer100Words: 28, spanOfRecognition: 0.78, averageFixationDuration: 0.27, readingRate: 173 },
  { grade: 6, label: 'Grade 6', fixationsPer100Words: 120, regressionsPer100Words: 25, spanOfRecognition: 0.83, averageFixationDuration: 0.27, readingRate: 185 },
  { grade: 7, label: 'Grade 7', fixationsPer100Words: 114, regressionsPer100Words: 23, spanOfRecognition: 0.88, averageFixationDuration: 0.27, readingRate: 195 },
  { grade: 8, label: 'Grade 8', fixationsPer100Words: 109, regressionsPer100Words: 21, spanOfRecognition: 0.92, averageFixationDuration: 0.27, readingRate: 204 },
  { grade: 9, label: 'Grade 9', fixationsPer100Words: 105, regressionsPer100Words: 20, spanOfRecognition: 0.95, averageFixationDuration: 0.27, readingRate: 214 },
  { grade: 10, label: 'Grade 10', fixationsPer100Words: 101, regressionsPer100Words: 19, spanOfRecognition: 0.99, averageFixationDuration: 0.26, readingRate: 224 },
  { grade: 11, label: 'Grade 11', fixationsPer100Words: 96, regressionsPer100Words: 18, spanOfRecognition: 1.04, averageFixationDuration: 0.26, readingRate: 237 },
  { grade: 12, label: 'Grade 12', fixationsPer100Words: 94, regressionsPer100Words: 17, spanOfRecognition: 1.06, averageFixationDuration: 0.25, readingRate: 250 },
  { grade: 13, label: 'College', fixationsPer100Words: 90, regressionsPer100Words: 15, spanOfRecognition: 1.11, averageFixationDuration: 0.24, readingRate: 280 },
  { grade: 14, label: 'Adult', fixationsPer100Words: 75, regressionsPer100Words: 11, spanOfRecognition: 1.33, averageFixationDuration: 0.23, readingRate: 340 },
];

export type NormMetric =
  | 'fixationsPer100Words'
  | 'regressionsPer100Words'
  | 'spanOfRecognition'
  | 'averageFixationDuration'
  | 'readingRate';

/** Metrics where a smaller number means a more mature reader. */
const LOWER_IS_BETTER: NormMetric[] = ['fixationsPer100Words', 'regressionsPer100Words', 'averageFixationDuration'];

/**
 * Finds the grade whose norm a measured value sits closest to, interpolating
 * between the two bracketing rows so the result moves smoothly rather than
 * jumping a whole grade at a time.
 */
export function gradeEquivalentFor(metric: NormMetric, value: number): number | null {
  if (!Number.isFinite(value) || value < 0) return null;

  const descending = LOWER_IS_BETTER.includes(metric);

  // Zero is a real result for the measures where less is better — a reader who
  // never went back has no regressions, which is the top of the scale, not a
  // missing value. For the others it means nothing was measured.
  if (value === 0) return descending ? TAYLOR_NORMS[TAYLOR_NORMS.length - 1].grade : null;
  const series = TAYLOR_NORMS.map(n => ({ grade: n.grade, value: n[metric] }));

  // Below the least mature norm.
  const first = series[0];
  const last = series[series.length - 1];
  if (descending ? value >= first.value : value <= first.value) return first.grade;
  if (descending ? value <= last.value : value >= last.value) return last.grade;

  for (let i = 0; i < series.length - 1; i++) {
    const a = series[i];
    const b = series[i + 1];
    const withinRange = descending
      ? value <= a.value && value >= b.value
      : value >= a.value && value <= b.value;
    if (!withinRange) continue;

    const span = b.value - a.value;
    const t = Math.abs(span) < 1e-9 ? 0 : (value - a.value) / span;
    return a.grade + t * (b.grade - a.grade);
  }

  return null;
}

export function normForGrade(grade: number): ReadingNorm {
  const clamped = Math.max(1, Math.min(14, Math.round(grade)));
  return TAYLOR_NORMS.find(n => n.grade === clamped) ?? TAYLOR_NORMS[TAYLOR_NORMS.length - 1];
}

export function describeGrade(grade: number | null): string {
  if (grade === null) return 'Not enough data';
  if (grade >= 13.5) return 'Adult level';
  if (grade >= 12.5) return 'College level';
  const rounded = Math.round(grade * 10) / 10;
  return `Grade ${rounded.toFixed(1)}`;
}
