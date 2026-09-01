/**
 * 1€ (One-Euro) Adaptive Filter for real-time low-latency, jitter-free signal filtering.
 * Ref: Casiez, G., Roussel, N. and Vogel, D. (2012). 1€ Filter: A Simple Speed-based
 * Low-pass Filter for Noisy Input in Interactive Systems. ACM CHI 2012.
 */

class LowPassFilter {
  private y: number | null = null;
  private s: number | null = null;

  constructor(private alpha: number = 0.5) {}

  public filter(value: number, alpha: number): number {
    this.alpha = alpha;
    if (this.y === null) {
      this.s = value;
      this.y = value;
    } else {
      this.s = alpha * value + (1.0 - alpha) * this.s!;
      this.y = this.s;
    }
    return this.y;
  }

  public filterWithAlpha(value: number): number {
    return this.filter(value, this.alpha);
  }

  public hasLast(): boolean {
    return this.y !== null;
  }

  public last(): number {
    return this.y ?? 0;
  }

  public reset() {
    this.y = null;
    this.s = null;
  }
}

export class OneEuroFilter1D {
  private xFilter: LowPassFilter;
  private dxFilter: LowPassFilter;
  private lastTime: number | null = null;

  /**
   * @param minCutoff Minimum cutoff frequency in Hz (lower = smoother during slow movement / fixations)
   * @param beta Speed coefficient (higher = faster response / less lag during rapid saccades)
   * @param dCutoff Derivative cutoff frequency in Hz
   */
  constructor(
    private minCutoff: number = 1.0,
    private beta: number = 0.02,
    private dCutoff: number = 1.0
  ) {
    this.xFilter = new LowPassFilter();
    this.dxFilter = new LowPassFilter();
  }

  public setParameters(minCutoff: number, beta: number, dCutoff: number = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
  }

  private getAlpha(rate: number, cutoff: number): number {
    const tau = 1.0 / (2.0 * Math.PI * cutoff);
    const te = 1.0 / rate;
    return 1.0 / (1.0 + tau / te);
  }

  public filter(x: number, timestampMs: number): number {
    if (this.lastTime === null) {
      this.lastTime = timestampMs;
      return this.xFilter.filter(x, 1.0);
    }

    // Compute dt in seconds
    const dt = Math.max(0.001, (timestampMs - this.lastTime) / 1000);
    this.lastTime = timestampMs;
    const rate = 1.0 / dt;

    // Estimate the derivative (rate of change)
    const dx = this.xFilter.hasLast() ? (x - this.xFilter.last()) * rate : 0;
    const edx = this.dxFilter.filter(dx, this.getAlpha(rate, this.dCutoff));

    // Dynamic cutoff frequency based on velocity
    const cutoff = this.minCutoff + this.beta * Math.abs(edx);
    return this.xFilter.filter(x, this.getAlpha(rate, cutoff));
  }

  public reset() {
    this.xFilter.reset();
    this.dxFilter.reset();
    this.lastTime = null;
  }
}

export class OneEuroFilter2D {
  private filterX: OneEuroFilter1D;
  private filterY: OneEuroFilter1D;

  constructor(
    minCutoff: number = 0.8,
    beta: number = 0.05,
    dCutoff: number = 1.0
  ) {
    this.filterX = new OneEuroFilter1D(minCutoff, beta, dCutoff);
    this.filterY = new OneEuroFilter1D(minCutoff, beta, dCutoff);
  }

  public setParameters(minCutoff: number, beta: number) {
    this.filterX.setParameters(minCutoff, beta);
    this.filterY.setParameters(minCutoff, beta);
  }

  public filter(x: number, y: number, timestampMs: number): { x: number; y: number } {
    const filteredX = this.filterX.filter(x, timestampMs);
    const filteredY = this.filterY.filter(y, timestampMs);
    return { x: filteredX, y: filteredY };
  }

  public reset() {
    this.filterX.reset();
    this.filterY.reset();
  }
}
