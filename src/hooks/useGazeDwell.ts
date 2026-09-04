import { useEffect, useRef, useState } from 'react';
import { gazeBus } from '../services/gazeBus';
import { driftGuard } from '../services/driftGuard';
import { GazeState } from '../types';

export interface DwellTarget {
  id: string;
  /** Centre, in viewport pixels. */
  x: number;
  y: number;
  radius: number;
}

export interface DwellState {
  activeId: string | null;
  progress: number;
  /** Distance from the gaze to the active target's centre, in pixels. */
  distance: number;
}

interface UseGazeDwellOptions {
  targets: DwellTarget[];
  dwellMs: number;
  /** Extra reach beyond the target radius, to forgive residual calibration error. */
  assistRadius?: number;
  enabled?: boolean;
  onSelect: (id: string, info: { dwellMs: number; firstDistance: number }) => void;
}

/** State updates are throttled to this rate; the ring animates via CSS between them. */
const UI_UPDATE_HZ = 20;

/**
 * Dwell selection: hold your gaze on something for long enough and it activates.
 *
 * Dwell is measured in milliseconds of elapsed time rather than in animation
 * frames. That sounds obvious, but the previous implementation advanced a
 * counter by a fixed amount per frame, which meant the hold a client had to
 * sustain silently changed with the machine's frame rate — a 900 ms dwell on a
 * fast laptop became a 1.8 s dwell on a slow one. For a therapy tool where the
 * dwell time is a prescribed parameter, that is a correctness bug, not a
 * performance detail.
 */
export function useGazeDwell({
  targets,
  dwellMs,
  assistRadius = 45,
  enabled = true,
  onSelect,
}: UseGazeDwellOptions): DwellState {
  const [state, setState] = useState<DwellState>({ activeId: null, progress: 0, distance: Infinity });

  const targetsRef = useRef(targets);
  targetsRef.current = targets;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const dwellMsRef = useRef(dwellMs);
  dwellMsRef.current = dwellMs;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const assistRef = useRef(assistRadius);
  assistRef.current = assistRadius;

  /*
   * The gaze is summed over the dwell as well as timed, because a dwell that
   * completes is the strongest statement this app ever gets about where someone
   * was actually looking — held inside a known target for the full duration.
   * Where the estimate sat on average during that hold, against where the target
   * really was, is a free measurement of the constant error, several times a
   * minute, without anybody stopping to re-centre. See driftGuard.
   */
  const activeRef = useRef<{
    id: string;
    startedAt: number;
    firstDistance: number;
    sumX: number;
    sumY: number;
    samples: number;
  } | null>(null);
  const lastEmitRef = useRef(0);
  const lastPublishedIdRef = useRef<string | null>(null);
  const gazeRef = useRef<GazeState | null>(null);

  useEffect(() => gazeBus.subscribe(g => {
    gazeRef.current = g;
  }), []);

  useEffect(() => {
    let frame = 0;

    const tick = () => {
      const gaze = gazeRef.current;
      const now = performance.now();

      if (!enabledRef.current || !gaze || gaze.event === 'lost') {
        activeRef.current = null;
        publish(null, 0, Infinity);
        frame = requestAnimationFrame(tick);
        return;
      }

      // Pick the nearest target within reach. Ties do not matter: the nearest
      // wins, and hysteresis comes from the fact that an in-progress dwell keeps
      // its target until the gaze leaves that target's own reach.
      let nearest: DwellTarget | null = null;
      let nearestDistance = Infinity;

      for (const target of targetsRef.current) {
        const distance = Math.hypot(gaze.screenX - target.x, gaze.screenY - target.y);
        if (distance <= target.radius + assistRef.current && distance < nearestDistance) {
          nearest = target;
          nearestDistance = distance;
        }
      }

      const current = activeRef.current;

      if (current) {
        const stillOn = targetsRef.current.find(t => t.id === current.id);
        const distanceToCurrent = stillOn
          ? Math.hypot(gaze.screenX - stillOn.x, gaze.screenY - stillOn.y)
          : Infinity;

        if (stillOn && distanceToCurrent <= stillOn.radius + assistRef.current) {
          current.sumX += gaze.screenX;
          current.sumY += gaze.screenY;
          current.samples++;

          const elapsed = now - current.startedAt;
          if (elapsed >= dwellMsRef.current) {
            activeRef.current = null;
            publish(null, 0, distanceToCurrent);
            if (current.samples > 0) {
              driftGuard.observe(
                current.sumX / current.samples,
                current.sumY / current.samples,
                stillOn.x,
                stillOn.y
              );
            }
            onSelectRef.current(current.id, {
              dwellMs: elapsed,
              firstDistance: current.firstDistance,
            });
          } else {
            publish(current.id, elapsed / dwellMsRef.current, distanceToCurrent);
          }
          frame = requestAnimationFrame(tick);
          return;
        }
        activeRef.current = null;
      }

      if (nearest) {
        // A stalled estimate must not start a dwell — that is how a client ends
        // up "selecting" something they never looked at. A blink is not a
        // stall: an in-progress dwell rides through it, and starting one is
        // fine because the held position is still where they were looking.
        if (!gaze.isVisiblyInterrupted) {
          activeRef.current = {
            id: nearest.id,
            startedAt: now,
            firstDistance: nearestDistance,
            sumX: 0,
            sumY: 0,
            samples: 0,
          };
        }
        publish(nearest.id, 0, nearestDistance);
      } else {
        publish(null, 0, nearestDistance);
      }

      frame = requestAnimationFrame(tick);
    };

    const publish = (activeId: string | null, progress: number, distance: number) => {
      const now = performance.now();
      // A change of target is published immediately; progress within a target is
      // rate-limited, since the ring only needs to look smooth, not be exact.
      const isTransition = activeId !== lastPublishedIdRef.current;
      if (!isTransition && now - lastEmitRef.current < 1000 / UI_UPDATE_HZ) return;
      lastEmitRef.current = now;
      lastPublishedIdRef.current = activeId;
      setState(prev =>
        prev.activeId === activeId && Math.abs(prev.progress - progress) < 0.01
          ? prev
          : { activeId, progress, distance }
      );
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
    // The loop reads everything through refs, so it is created once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return state;
}
