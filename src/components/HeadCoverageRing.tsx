import React from 'react';

/**
 * How far the head has to travel in each direction, in radians from the
 * starting pose.
 *
 * Turning is comfortable over a wider range than nodding, so the two axes get
 * different targets — asking for the same excursion in both would make the
 * vertical half of the ring feel impossible while the horizontal half filled
 * immediately.
 *
 * The figures are set by what the gain fit needs, with margin. It wants a
 * standard deviation of at least 0.02 rad on an axis before it will trust that
 * axis; a sweep out to a peak of 0.16 rad and back has a standard deviation
 * near 0.11, which clears the bar several times over even if the client only
 * manages half of what is asked.
 */
export const HEAD_TARGET_YAW = 0.16;
export const HEAD_TARGET_PITCH = 0.1;

export type CoverageDirection = 'left' | 'right' | 'up' | 'down';

export type HeadCoverage = Record<CoverageDirection, number>;

export const EMPTY_COVERAGE: HeadCoverage = { left: 0, right: 0, up: 0, down: 0 };

/**
 * Updates coverage from a head pose, returning the new coverage and where the
 * head currently sits in the ring's coordinates.
 *
 * Each direction records the furthest the head has *ever* reached during the
 * pass, not where it is now — so a completed arc stays completed when the head
 * comes back to centre. Anything else would empty the ring on the way back from
 * every sweep and make the task look unachievable.
 *
 * Screen coordinates are mirrored, matching the head picture elsewhere in
 * set-up: the client sees themselves as in a mirror, so turning to their own
 * left moves the marker to the left of the screen.
 */
export function accumulateCoverage(
  coverage: HeadCoverage,
  yaw: number,
  pitch: number,
  referenceYaw: number,
  referencePitch: number
): { coverage: HeadCoverage; markerX: number; markerY: number } {
  const x = -(yaw - referenceYaw) / HEAD_TARGET_YAW;
  const y = (pitch - referencePitch) / HEAD_TARGET_PITCH;

  const reach = (previous: number, value: number) => Math.max(previous, Math.min(1, Math.max(0, value)));

  return {
    coverage: {
      left: reach(coverage.left, -x),
      right: reach(coverage.right, x),
      up: reach(coverage.up, -y),
      down: reach(coverage.down, y),
    },
    markerX: Math.max(-1.25, Math.min(1.25, x)),
    markerY: Math.max(-1.25, Math.min(1.25, y)),
  };
}

export function coverageComplete(coverage: HeadCoverage): boolean {
  return (['left', 'right', 'up', 'down'] as const).every(d => coverage[d] >= 1);
}

export function coverageFraction(coverage: HeadCoverage): number {
  const values = (['left', 'right', 'up', 'down'] as const).map(d => coverage[d]);
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Which way to send them next: the emptiest arc, so one instruction at a time. */
export function nextDirection(coverage: HeadCoverage): CoverageDirection | null {
  const order: CoverageDirection[] = ['left', 'right', 'up', 'down'];
  let worst: CoverageDirection | null = null;
  for (const d of order) {
    if (coverage[d] >= 1) continue;
    if (worst === null || coverage[d] < coverage[worst]) worst = d;
  }
  return worst;
}

export const DIRECTION_PROMPT: Record<CoverageDirection, string> = {
  left: 'Turn your head to the left',
  right: 'Turn your head to the right',
  up: 'Tip your chin up',
  down: 'Tip your chin down',
};

/** Centre angle and sweep of each arc, in degrees, with 0° pointing right. */
const ARCS: Record<CoverageDirection, number> = { right: 0, down: 90, left: 180, up: 270 };
const ARC_SWEEP = 74;

function arcPath(cx: number, cy: number, r: number, centreDeg: number, sweepDeg: number): string {
  const toPoint = (deg: number) => {
    const rad = (deg * Math.PI) / 180;
    return `${cx + r * Math.cos(rad)} ${cy + r * Math.sin(rad)}`;
  };
  const from = centreDeg - sweepDeg / 2;
  const to = centreDeg + sweepDeg / 2;
  return `M ${toPoint(from)} A ${r} ${r} 0 0 1 ${toPoint(to)}`;
}

/**
 * Face ID's ring, for the head-movement pass.
 *
 * The problem it solves is that "turn your head side to side, then nod" does
 * not say *how much*, and testers who followed it faithfully still moved too
 * little for the measurement to work — a fit that then quietly fell back to
 * textbook constants and reported nothing. Turning the requirement into four
 * arcs that fill as the head reaches each direction makes the amount visible,
 * and makes finishing unambiguous: the ring is closed, so the pass is done.
 *
 * The dot at the centre is what the eyes stay on throughout, so the ring is
 * drawn around it rather than beside it — the client never has to look away
 * from the thing they are being told not to look away from, and the arcs are
 * read peripherally, which is all they need to be.
 */
export const HeadCoverageRing: React.FC<{
  coverage: HeadCoverage;
  markerX: number;
  markerY: number;
  active: boolean;
}> = ({ coverage, markerX, markerY, active }) => {
  const size = 260;
  const c = size / 2;
  const r = 96;

  return (
    <svg width={size} height={size} className="overflow-visible">
      {(Object.keys(ARCS) as CoverageDirection[]).map(direction => {
        const done = coverage[direction] >= 1;
        return (
          <g key={direction}>
            <path
              d={arcPath(c, c, r, ARCS[direction], ARC_SWEEP)}
              fill="none"
              stroke="var(--border-strong)"
              strokeWidth={8}
              strokeLinecap="round"
            />
            {/*
              Each arc fills from its own centre outwards rather than from one
              end, so partial progress reads as "not far enough yet" in the
              direction being asked for.

              Nothing is drawn at all below a sliver's worth of progress: a
              round-capped path of zero length still paints a dot, and four
              dots sitting in the gaps looked like specks on the screen rather
              than an empty scoreboard.
            */}
            {coverage[direction] > 0.02 && (
              <path
                d={arcPath(c, c, r, ARCS[direction], ARC_SWEEP * coverage[direction])}
                fill="none"
                stroke={done ? 'var(--color-sage-500)' : 'var(--color-clay-400)'}
                strokeWidth={8}
                strokeLinecap="round"
                style={{ transition: 'stroke 200ms linear' }}
              />
            )}
          </g>
        );
      })}

      {/*
        The live position of the head inside the ring. Without it the arcs are
        a scoreboard; with it they are a control, and the client can see which
        way to move without being told in words.
      */}
      {active && (
        <circle
          cx={c + markerX * (r - 18)}
          cy={c + markerY * (r - 18)}
          r={13}
          fill="none"
          stroke="var(--color-clay-400)"
          strokeWidth={2.5}
          opacity={0.75}
          style={{ transition: 'cx 60ms linear, cy 60ms linear' }}
        />
      )}

      {/* The target itself: the one thing the eyes are meant to stay on. */}
      <circle cx={c} cy={c} r={7} fill="var(--color-sage-500)" />
    </svg>
  );
};
