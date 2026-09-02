import { useEffect, useRef, useState } from 'react';
import { GazeState } from '../types';

/**
 * A tiny publish/subscribe channel for gaze samples.
 *
 * Gaze arrives at 30–60 Hz. Routing it through React state re-renders the whole
 * application on every frame, which is what made the previous version stutter:
 * every activity, every panel and every canvas was reconciled sixty times a
 * second to move one dot. Components now subscribe to exactly what they need —
 * a raw per-frame callback for canvas work, or a deliberately slow throttled
 * value for text readouts.
 */
class GazeBus {
  private latest: GazeState | null = null;
  private subscribers = new Set<(gaze: GazeState) => void>();

  public publish(gaze: GazeState) {
    this.latest = gaze;
    this.subscribers.forEach(fn => {
      try {
        fn(gaze);
      } catch (err) {
        console.error('Gaze subscriber failed', err);
      }
    });
  }

  public subscribe(fn: (gaze: GazeState) => void): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  public get(): GazeState | null {
    return this.latest;
  }

  public clear() {
    this.latest = null;
  }
}

export const gazeBus = new GazeBus();

/**
 * A ref that always holds the newest sample, without ever re-rendering.
 * Use this inside animation frames and event handlers.
 */
export function useGazeRef() {
  const ref = useRef<GazeState | null>(gazeBus.get());
  useEffect(() => gazeBus.subscribe(gaze => {
    ref.current = gaze;
  }), []);
  return ref;
}

/**
 * Runs `callback` on every gaze sample. The callback is kept in a ref so
 * re-creating it inline does not resubscribe — this was the bug that made the
 * cursor tear down and rebuild its animation loop sixty times a second.
 */
export function useGazeFrame(callback: (gaze: GazeState) => void) {
  const cbRef = useRef(callback);
  cbRef.current = callback;
  useEffect(() => gazeBus.subscribe(gaze => cbRef.current(gaze)), []);
}

/**
 * Re-renders at most `hz` times a second. For status text, counters and
 * anything else a human reads rather than watches.
 */
export function useThrottledGaze(hz = 6): GazeState | null {
  const [gaze, setGaze] = useState<GazeState | null>(gazeBus.get());
  const lastRef = useRef(0);

  useEffect(() => {
    const interval = 1000 / hz;
    return gazeBus.subscribe(sample => {
      const now = sample.timestamp;
      if (now - lastRef.current >= interval) {
        lastRef.current = now;
        setGaze(sample);
      }
    });
  }, [hz]);

  return gaze;
}
