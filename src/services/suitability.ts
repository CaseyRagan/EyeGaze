import { viewingGeometry } from './viewingGeometry';

/**
 * What a given accuracy is actually good for.
 *
 * A single verdict — "good", "needs another go" — answers a question nobody
 * asked. What a clinician needs to know is whether *this* session can support
 * *this* task, and those have very different requirements: a large dwell target
 * forgives half a screen-inch of error, and attributing a fixation to the word
 * it landed on forgives almost none. Reporting one grade against an absolute
 * scale hides that, and tells someone sitting at a perfectly usable accuracy for
 * the games that their set-up failed.
 *
 * So the figure is compared against the reach of the things it will actually be
 * used on, taken from the activities themselves rather than invented here.
 */
export interface Suitability {
  label: string;
  detail: string;
  /** Half-width of the thing being aimed at, in CSS pixels. */
  reachPx: number;
  verdict: 'comfortable' | 'workable' | 'not yet';
}

/**
 * A target's reach is its radius plus the assist margin the activity allows, so
 * these are the real distances a gaze has to land within — not the drawn size.
 */
const TASKS: Array<{ label: string; detail: string; reachPx: number }> = [
  {
    label: 'Games on the large setting',
    detail: 'Find and hold, join the dots, mazes — the biggest targets in the app.',
    reachPx: 62 + 55,
  },
  {
    label: 'Games on the medium setting',
    detail: 'The usual size for a session once someone is comfortable.',
    reachPx: 44 + 35,
  },
  {
    label: 'Spelling by gaze',
    detail: 'Letter tiles are smaller than game targets and sit next to each other.',
    reachPx: 60,
  },
  {
    label: 'Games on the small setting',
    detail: 'Deliberately demanding — for someone whose control is already good.',
    reachPx: 30 + 18,
  },
  {
    label: 'Reading assessment',
    detail: 'Every fixation has to be attributed to the word it landed on.',
    reachPx: 35,
  },
];

/**
 * How far inside a target's reach the average error has to sit before the task
 * feels reliable rather than lucky. Landing exactly on the boundary means
 * missing about half the time.
 */
const COMFORTABLE_FRACTION = 0.6;

export function suitabilityFor(accuracyPx: number): Suitability[] {
  return TASKS.map(task => ({
    ...task,
    verdict:
      !Number.isFinite(accuracyPx) || accuracyPx > task.reachPx
        ? 'not yet'
        : accuracyPx <= task.reachPx * COMFORTABLE_FRACTION
          ? 'comfortable'
          : 'workable',
  }));
}

/**
 * The accuracy, in degrees, that would move the first not-yet-reachable task
 * into range — so the result screen can say what improving would buy, rather
 * than only that improvement is wanted.
 */
export function nextMilestone(accuracyPx: number): { label: string; deg: number } | null {
  const next = suitabilityFor(accuracyPx).find(s => s.verdict === 'not yet');
  if (!next) return null;
  return { label: next.label, deg: viewingGeometry.pixelsToDegrees(next.reachPx) };
}
