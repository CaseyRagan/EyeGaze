export interface HeatmapPoint {
  x: number;
  y: number;
  weight: number;
  time: number;
}

export interface HeatmapHotspot {
  x: number;
  y: number;
  density: number;
}

const MAX_POINTS = 2500;

/**
 * Accumulates where the gaze has spent its time and paints it as a soft
 * density map.
 *
 * The colourised bitmap is rebuilt only when new points have arrived, not on
 * every frame. Recolouring means reading and rewriting every pixel of a
 * full-screen canvas, which at 1920×1080 is over eight million array
 * operations — fine a few times a second, ruinous at sixty.
 */
export class HeatmapRenderer {
  private densityCanvas: HTMLCanvasElement;
  private densityCtx: CanvasRenderingContext2D | null;
  private colourCanvas: HTMLCanvasElement;
  private colourCtx: CanvasRenderingContext2D | null;
  private gradient: Uint8ClampedArray | null = null;
  private points: HeatmapPoint[] = [];
  private radius = 46;
  private opacity = 0.72;
  private width = 0;
  private height = 0;
  private dirty = true;

  constructor() {
    this.densityCanvas = document.createElement('canvas');
    this.densityCtx = this.densityCanvas.getContext('2d', { willReadFrequently: true });
    this.colourCanvas = document.createElement('canvas');
    this.colourCtx = this.colourCanvas.getContext('2d');
    this.buildGradient();
  }

  private buildGradient() {
    const palette = document.createElement('canvas');
    palette.width = 256;
    palette.height = 1;
    const ctx = palette.getContext('2d');
    if (!ctx) return;

    // Warm, low-saturation ramp: pale sage through honey to clay. Deliberately
    // avoids the rainbow scale, which exaggerates differences that are not
    // there and is unreadable for anyone with a red-green colour deficiency.
    const grad = ctx.createLinearGradient(0, 0, 256, 0);
    grad.addColorStop(0.0, 'rgba(255, 255, 255, 0)');
    grad.addColorStop(0.2, 'rgba(185, 215, 206, 0.35)');
    grad.addColorStop(0.45, 'rgba(143, 188, 175, 0.6)');
    grad.addColorStop(0.68, 'rgba(237, 203, 132, 0.78)');
    grad.addColorStop(0.86, 'rgba(204, 143, 110, 0.88)');
    grad.addColorStop(1.0, 'rgba(181, 113, 79, 0.95)');

    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 256, 1);
    this.gradient = ctx.getImageData(0, 0, 256, 1).data;
  }

  public resize(width: number, height: number) {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    if (this.width === w && this.height === h) return;
    this.width = w;
    this.height = h;
    this.densityCanvas.width = w;
    this.densityCanvas.height = h;
    this.colourCanvas.width = w;
    this.colourCanvas.height = h;
    this.redrawAll();
  }

  public setRadius(r: number) {
    this.radius = Math.max(15, Math.min(120, r));
    this.redrawAll();
  }

  public setOpacity(value: number) {
    this.opacity = Math.max(0.1, Math.min(1, value));
    this.dirty = true;
  }

  public getPointCount(): number {
    return this.points.length;
  }

  public addPoint(x: number, y: number, isFixating = false) {
    if (x < 0 || x > this.width || y < 0 || y > this.height) return;

    // Fixations count for more than transit: time spent looking is the signal,
    // and a saccade passing over a spot is not the same as dwelling on it.
    const weight = isFixating ? 2.2 : 1;
    const now = Date.now();

    const last = this.points[this.points.length - 1];
    if (last && now - last.time < 35 && Math.hypot(x - last.x, y - last.y) < 6) {
      last.weight += weight * 0.4;
      this.stampPoint(last.x, last.y, weight * 0.4);
      this.dirty = true;
      return;
    }

    this.points.push({ x, y, weight, time: now });
    if (this.points.length > MAX_POINTS) this.points.shift();

    this.stampPoint(x, y, weight);
    this.dirty = true;
  }

  private stampPoint(x: number, y: number, weight: number) {
    if (!this.densityCtx || this.width === 0) return;

    const alpha = Math.min(0.25, weight * 0.08);
    const grad = this.densityCtx.createRadialGradient(x, y, 0, x, y, this.radius);
    grad.addColorStop(0, `rgba(0, 0, 0, ${alpha})`);
    grad.addColorStop(0.5, `rgba(0, 0, 0, ${alpha * 0.45})`);
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');

    this.densityCtx.fillStyle = grad;
    this.densityCtx.beginPath();
    this.densityCtx.arc(x, y, this.radius, 0, Math.PI * 2);
    this.densityCtx.fill();
  }

  private redrawAll() {
    if (!this.densityCtx || this.width === 0) return;
    this.densityCtx.clearRect(0, 0, this.width, this.height);
    for (const p of this.points) this.stampPoint(p.x, p.y, p.weight);
    this.dirty = true;
  }

  public clear() {
    this.points = [];
    this.densityCtx?.clearRect(0, 0, this.width, this.height);
    this.colourCtx?.clearRect(0, 0, this.width, this.height);
    this.dirty = false;
  }

  /** The densest region, as a rough summary of where attention settled. */
  public getPeakHotspot(): HeatmapHotspot | null {
    if (this.points.length < 12) return null;

    let best: HeatmapHotspot | null = null;
    for (const candidate of this.points) {
      let density = 0;
      for (const other of this.points) {
        const d = Math.hypot(candidate.x - other.x, candidate.y - other.y);
        if (d < this.radius) density += other.weight * (1 - d / this.radius);
      }
      if (!best || density > best.density) best = { x: candidate.x, y: candidate.y, density };
    }
    return best;
  }

  /** Recolours if needed, then composites onto the target context. */
  public render(targetCtx: CanvasRenderingContext2D) {
    if (!this.densityCtx || !this.colourCtx || !this.gradient || this.width === 0) return;
    if (this.points.length === 0) return;

    if (this.dirty) {
      const image = this.densityCtx.getImageData(0, 0, this.width, this.height);
      const data = image.data;
      const lut = this.gradient;

      for (let i = 0; i < data.length; i += 4) {
        const alpha = data[i + 3];
        if (alpha === 0) continue;
        const lutIndex = alpha * 4;
        data[i] = lut[lutIndex];
        data[i + 1] = lut[lutIndex + 1];
        data[i + 2] = lut[lutIndex + 2];
        data[i + 3] = Math.round(lut[lutIndex + 3] * this.opacity);
      }

      this.colourCtx.putImageData(image, 0, 0);
      this.dirty = false;
    }

    targetCtx.drawImage(this.colourCanvas, 0, 0, this.width, this.height);
  }
}
