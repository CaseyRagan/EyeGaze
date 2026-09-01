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
  regionName: string;
}

export class HeatmapRenderer {
  private shadowCanvas: HTMLCanvasElement;
  private shadowCtx: CanvasRenderingContext2D | null;
  private colorCanvas: HTMLCanvasElement;
  private colorCtx: CanvasRenderingContext2D | null;
  private colorGradient: Uint8ClampedArray | null = null;
  private points: HeatmapPoint[] = [];
  private maxDensity = 1;
  private radius = 45;
  private opacity = 0.75;
  private width = 0;
  private height = 0;

  constructor() {
    this.shadowCanvas = document.createElement('canvas');
    this.shadowCtx = this.shadowCanvas.getContext('2d', { willReadFrequently: true });
    this.colorCanvas = document.createElement('canvas');
    this.colorCtx = this.colorCanvas.getContext('2d');
    this.initColorGradient();
  }

  private initColorGradient() {
    const paletteCanvas = document.createElement('canvas');
    paletteCanvas.width = 256;
    paletteCanvas.height = 1;
    const pCtx = paletteCanvas.getContext('2d');
    if (!pCtx) return;

    // Heatmap gradient spectrum: Deep Obsidian/Indigo -> Cyan -> Emerald -> Solar Gold -> Hot Coral -> White Peak
    const grad = pCtx.createLinearGradient(0, 0, 256, 0);
    grad.addColorStop(0.0, 'rgba(0, 0, 0, 0)');
    grad.addColorStop(0.12, 'rgba(6, 182, 212, 0.25)'); // Cyan
    grad.addColorStop(0.30, 'rgba(16, 185, 129, 0.55)'); // Emerald
    grad.addColorStop(0.55, 'rgba(234, 179, 8, 0.75)'); // Amber / Gold
    grad.addColorStop(0.80, 'rgba(239, 68, 68, 0.90)'); // Hot Crimson
    grad.addColorStop(1.0, 'rgba(255, 255, 255, 1.0)'); // White Core

    pCtx.fillStyle = grad;
    pCtx.fillRect(0, 0, 256, 1);
    this.colorGradient = pCtx.getImageData(0, 0, 256, 1).data;
  }

  public resize(width: number, height: number) {
    if (this.width === width && this.height === height) return;
    this.width = width;
    this.height = height;
    this.shadowCanvas.width = width;
    this.shadowCanvas.height = height;
    this.colorCanvas.width = width;
    this.colorCanvas.height = height;
    this.redrawAllPoints();
  }

  public setRadius(r: number) {
    this.radius = Math.max(15, Math.min(100, r));
    this.redrawAllPoints();
  }

  public setOpacity(op: number) {
    this.opacity = Math.max(0.1, Math.min(1.0, op));
  }

  public getPointCount(): number {
    return this.points.length;
  }

  public addPoint(x: number, y: number, isFixating: boolean = false) {
    if (x < 0 || x > this.width || y < 0 || y > this.height) return;

    const weight = isFixating ? 2.2 : 1.0;
    const now = Date.now();

    // Prevent identical point spam in a tight loop (< 6px within 40ms)
    if (this.points.length > 0) {
      const last = this.points[this.points.length - 1];
      if (now - last.time < 35 && Math.hypot(x - last.x, y - last.y) < 6) {
        last.weight += weight * 0.4;
        this.renderSinglePoint(last.x, last.y, weight * 0.4);
        return;
      }
    }

    const pt: HeatmapPoint = { x, y, weight, time: now };
    this.points.push(pt);

    // Limit buffer to 2500 points for memory safety
    if (this.points.length > 2500) {
      this.points.shift();
    }

    this.renderSinglePoint(x, y, weight);
  }

  private renderSinglePoint(x: number, y: number, weight: number) {
    if (!this.shadowCtx || this.width === 0 || this.height === 0) return;

    const r = this.radius;
    const radGrad = this.shadowCtx.createRadialGradient(x, y, 0, x, y, r);
    const alpha = Math.min(0.25, (weight * 0.08));

    radGrad.addColorStop(0, `rgba(0, 0, 0, ${alpha})`);
    radGrad.addColorStop(0.5, `rgba(0, 0, 0, ${alpha * 0.45})`);
    radGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');

    this.shadowCtx.fillStyle = radGrad;
    this.shadowCtx.beginPath();
    this.shadowCtx.arc(x, y, r, 0, Math.PI * 2);
    this.shadowCtx.fill();
  }

  private redrawAllPoints() {
    if (!this.shadowCtx || this.width === 0 || this.height === 0) return;
    this.shadowCtx.clearRect(0, 0, this.width, this.height);
    for (let i = 0; i < this.points.length; i++) {
      const p = this.points[i];
      this.renderSinglePoint(p.x, p.y, p.weight);
    }
  }

  public clear() {
    this.points = [];
    if (this.shadowCtx) {
      this.shadowCtx.clearRect(0, 0, this.width, this.height);
    }
  }

  public getPeakHotspot(): HeatmapHotspot | null {
    if (this.points.length === 0 || this.width === 0 || this.height === 0) return null;

    // Find center of mass / dense cluster using a coarse 6x6 spatial grid
    const cols = 6;
    const rows = 6;
    const cellW = this.width / cols;
    const cellH = this.height / rows;
    const grid: number[][] = Array.from({ length: rows }, () => Array(cols).fill(0));

    let maxVal = 0;
    let maxR = 0;
    let maxC = 0;

    for (let i = 0; i < this.points.length; i++) {
      const p = this.points[i];
      const c = Math.min(cols - 1, Math.max(0, Math.floor(p.x / cellW)));
      const r = Math.min(rows - 1, Math.max(0, Math.floor(p.y / cellH)));
      grid[r][c] += p.weight;
      if (grid[r][c] > maxVal) {
        maxVal = grid[r][c];
        maxR = r;
        maxC = c;
      }
    }

    const centerX = (maxC + 0.5) * cellW;
    const centerY = (maxR + 0.5) * cellH;

    // Region description
    const vName = maxR < 2 ? 'Top' : maxR > 3 ? 'Bottom' : 'Center';
    const hName = maxC < 2 ? 'Left' : maxC > 3 ? 'Right' : 'Center';
    const regionName = vName === 'Center' && hName === 'Center' ? 'Canvas Center' : `${vName}-${hName}`;

    return {
      x: Math.round(centerX),
      y: Math.round(centerY),
      density: maxVal,
      regionName,
    };
  }

  public render(targetCtx: CanvasRenderingContext2D) {
    if (!this.shadowCtx || !this.colorCtx || !this.colorGradient || this.width === 0 || this.height === 0) return;
    if (this.points.length === 0) return;

    // Get alpha data from shadow canvas
    const imgData = this.shadowCtx.getImageData(0, 0, this.width, this.height);
    const data = imgData.data;
    const lut = this.colorGradient;

    // Transform alpha values to the spectral color palette
    for (let i = 0; i < data.length; i += 4) {
      const alpha = data[i + 3];
      if (alpha > 0) {
        // Look up color from gradient table
        const lutIndex = alpha * 4;
        data[i] = lut[lutIndex];         // R
        data[i + 1] = lut[lutIndex + 1]; // G
        data[i + 2] = lut[lutIndex + 2]; // B
        data[i + 3] = Math.round(lut[lutIndex + 3] * this.opacity); // A
      }
    }

    this.colorCtx.putImageData(imgData, 0, 0);

    // Draw onto destination target canvas
    targetCtx.save();
    targetCtx.globalAlpha = 1.0;
    targetCtx.drawImage(this.colorCanvas, 0, 0);
    targetCtx.restore();
  }
}
