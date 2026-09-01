import { CalibrationModel, CalibrationSample, CalibrationTarget, Point2D, QuadraticCoefficients } from '../types';

const STORAGE_KEY = 'gazeflow_calibration_v2';

export const DEFAULT_CALIBRATION_TARGETS: Omit<CalibrationTarget, 'samples' | 'status'>[] = [
  { id: 1, label: 'Top Left', xPercent: 12, yPercent: 15 },
  { id: 2, label: 'Top Center', xPercent: 50, yPercent: 15 },
  { id: 3, label: 'Top Right', xPercent: 88, yPercent: 15 },
  { id: 4, label: 'Center Left', xPercent: 12, yPercent: 50 },
  { id: 5, label: 'Center', xPercent: 50, yPercent: 50 },
  { id: 6, label: 'Center Right', xPercent: 88, yPercent: 50 },
  { id: 7, label: 'Bottom Left', xPercent: 12, yPercent: 85 },
  { id: 8, label: 'Bottom Center', xPercent: 50, yPercent: 85 },
  { id: 9, label: 'Bottom Right', xPercent: 88, yPercent: 85 },
];

/**
 * Solves Ax = b using Gaussian elimination with partial pivoting.
 */
function solveLinearSystem(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M: number[][] = A.map((row, i) => [...row, b[i]]);

  for (let i = 0; i < n; i++) {
    let maxRow = i;
    for (let k = i + 1; k < n; k++) {
      if (Math.abs(M[k][i]) > Math.abs(M[maxRow][i])) {
        maxRow = k;
      }
    }

    const temp = M[i];
    M[i] = M[maxRow];
    M[maxRow] = temp;

    if (Math.abs(M[i][i]) < 1e-12) {
      return null;
    }

    for (let k = i + 1; k < n; k++) {
      const c = M[k][i] / M[i][i];
      for (let j = i; j <= n; j++) {
        M[k][j] -= c * M[i][j];
      }
    }
  }

  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = M[i][n];
    for (let j = i + 1; j < n; j++) {
      sum -= M[i][j] * x[j];
    }
    x[i] = sum / M[i][i];
  }

  return x;
}

export interface CalibratedAnchorPoint {
  id: string;
  targetX: number; // in px
  targetY: number; // in px
  xPercent: number;
  yPercent: number;
  avgRawX: number;
  avgRawY: number;
  avgHeadYaw: number;
  avgHeadPitch: number;
  label?: string;
  timestamp: number;
}

export class CalibrationEngine {
  private model: CalibrationModel = {
    isCalibrated: false,
    isCenterCalibrated: false,
    centerOffsetX: 0,
    centerOffsetY: 0,
    centerHeadYaw: 0,
    centerHeadPitch: 0,
    offsetX: 0,
    offsetY: 0,
    scaleX: 1,
    scaleY: 1,
  };

  private targetPoints: Map<number | string, CalibratedAnchorPoint> = new Map();

  constructor() {
    this.loadFromStorage();
  }

  public getModel(): CalibrationModel {
    return this.model;
  }

  public isCalibrated(): boolean {
    return this.model.isCalibrated || Boolean(this.model.isCenterCalibrated);
  }

  public isCenterCalibrated(): boolean {
    return Boolean(this.model.isCenterCalibrated);
  }

  public getCalibratedPoints(): CalibratedAnchorPoint[] {
    return Array.from(this.targetPoints.values());
  }

  public resetCalibration() {
    this.model = {
      isCalibrated: false,
      isCenterCalibrated: false,
      centerOffsetX: 0,
      centerOffsetY: 0,
      centerHeadYaw: 0,
      centerHeadPitch: 0,
      offsetX: 0,
      offsetY: 0,
      scaleX: 1,
      scaleY: 1,
      quadraticCoeffs: undefined,
    };
    this.targetPoints.clear();
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Ignore
    }
  }

  public removePoint(id: string | number, screenWidth: number, screenHeight: number) {
    this.targetPoints.delete(id);
    this.recomputeModel(screenWidth, screenHeight);
  }

  /**
   * Adds or updates a manual click calibration point directly at (targetX, targetY).
   */
  public addManualPoint(
    id: string | number,
    targetX: number,
    targetY: number,
    rawX: number,
    rawY: number,
    headYaw: number,
    headPitch: number,
    screenWidth: number,
    screenHeight: number,
    label?: string
  ): CalibratedAnchorPoint {
    const xPercent = (targetX / Math.max(1, screenWidth)) * 100;
    const yPercent = (targetY / Math.max(1, screenHeight)) * 100;

    const anchor: CalibratedAnchorPoint = {
      id: String(id),
      targetX,
      targetY,
      xPercent,
      yPercent,
      avgRawX: rawX,
      avgRawY: rawY,
      avgHeadYaw: headYaw,
      avgHeadPitch: headPitch,
      label: label || `Point (${Math.round(xPercent)}%, ${Math.round(yPercent)}%)`,
      timestamp: Date.now(),
    };

    this.targetPoints.set(id, anchor);
    this.recomputeModel(screenWidth, screenHeight);
    return anchor;
  }

  /**
   * Fast Center-Lock & Zero-Offset Calibration
   * Automatically zeroes out resting camera mounting bias, user head tilt,
   * and window aspect ratio to baseline gaze directly in the dead center.
   */
  public calibrateCenter(
    samples: CalibrationSample[],
    screenWidth: number,
    screenHeight: number
  ): CalibrationModel {
    if (!samples || samples.length === 0) {
      this.model.isCenterCalibrated = true;
      this.model.lastCalibratedAt = Date.now();
      this.saveToStorage();
      return this.model;
    }

    // Trim outliers
    const sortedX = [...samples.map(s => s.rawX)].sort((a, b) => a - b);
    const sortedY = [...samples.map(s => s.rawY)].sort((a, b) => a - b);
    const sortedYaw = [...samples.map(s => s.headYaw)].sort((a, b) => a - b);
    const sortedPitch = [...samples.map(s => s.headPitch)].sort((a, b) => a - b);

    const trimStart = Math.floor(sortedX.length * 0.15);
    const trimEnd = Math.max(trimStart + 1, Math.floor(sortedX.length * 0.85));

    const subX = sortedX.slice(trimStart, trimEnd);
    const subY = sortedY.slice(trimStart, trimEnd);
    const subYaw = sortedYaw.slice(trimStart, trimEnd);
    const subPitch = sortedPitch.slice(trimStart, trimEnd);

    const avgRawX = subX.reduce((a, b) => a + b, 0) / subX.length;
    const avgRawY = subY.reduce((a, b) => a + b, 0) / subY.length;
    const avgYaw = subYaw.reduce((a, b) => a + b, 0) / subYaw.length;
    const avgPitch = subPitch.reduce((a, b) => a + b, 0) / subPitch.length;

    // Adaptively tune default scaling based on viewport aspect ratio
    const aspect = screenWidth / Math.max(1, screenHeight);
    const scaleX = aspect > 1.3 ? 1.4 : 1.25;
    const scaleY = aspect > 1.3 ? 1.35 : 1.25;

    this.model = {
      ...this.model,
      isCenterCalibrated: true,
      centerOffsetX: avgRawX,
      centerOffsetY: avgRawY,
      centerHeadYaw: avgYaw,
      centerHeadPitch: avgPitch,
      lastCalibratedAt: Date.now(),
      scaleX,
      scaleY,
    };

    // If no 9-point grid has been created yet, seed center target point
    if (this.targetPoints.size === 0) {
      this.targetPoints.set(5, {
        id: '5',
        targetX: screenWidth / 2,
        targetY: screenHeight / 2,
        xPercent: 50,
        yPercent: 50,
        avgRawX,
        avgRawY,
        avgHeadYaw: avgYaw,
        avgHeadPitch: avgPitch,
        label: 'Center',
        timestamp: Date.now(),
      });
    }

    this.saveToStorage();
    return this.model;
  }

  /**
   * Recomputes mapping models (Affine + Quadratic + IDW) from all current target points.
   */
  public recomputeModel(screenWidth: number, screenHeight: number): CalibrationModel {
    const dataPoints = Array.from(this.targetPoints.values());

    if (dataPoints.length < 3) {
      this.model = {
        ...this.model,
        isCalibrated: dataPoints.length > 0,
        lastCalibratedAt: Date.now(),
      };
      this.saveToStorage();
      return this.model;
    }

    let quadraticCoeffs: QuadraticCoefficients | undefined;

    // If >= 5 points, fit 2nd degree bivariate polynomial with lambda ridge
    if (dataPoints.length >= 5) {
      const N = dataPoints.length;
      const K = 6;
      const lambda = 1e-3; // Ridge regularization to prevent polynomial runaway

      const A: number[][] = dataPoints.map(p => [
        1,
        p.avgRawX,
        p.avgRawY,
        p.avgRawX * p.avgRawX,
        p.avgRawY * p.avgRawY,
        p.avgRawX * p.avgRawY,
      ]);

      const ATA: number[][] = Array.from({ length: K }, () => new Array(K).fill(0));
      for (let i = 0; i < K; i++) {
        for (let j = 0; j < K; j++) {
          let sum = 0;
          for (let r = 0; r < N; r++) {
            sum += A[r][i] * A[r][j];
          }
          ATA[i][j] = sum + (i === j ? lambda : 0);
        }
      }

      const ATX: number[] = new Array(K).fill(0);
      const ATY: number[] = new Array(K).fill(0);
      for (let i = 0; i < K; i++) {
        let sumX = 0;
        let sumY = 0;
        for (let r = 0; r < N; r++) {
          sumX += A[r][i] * dataPoints[r].targetX;
          sumY += A[r][i] * dataPoints[r].targetY;
        }
        ATX[i] = sumX;
        ATY[i] = sumY;
      }

      const coeffX = solveLinearSystem(ATA, ATX);
      const coeffY = solveLinearSystem(ATA, ATY);

      if (coeffX && coeffY) {
        quadraticCoeffs = { a: coeffX, b: coeffY };
      }
    }

    let minRawX = Infinity, maxRawX = -Infinity;
    let minRawY = Infinity, maxRawY = -Infinity;
    let minScrX = Infinity, maxScrX = -Infinity;
    let minScrY = Infinity, maxScrY = -Infinity;

    dataPoints.forEach(p => {
      minRawX = Math.min(minRawX, p.avgRawX);
      maxRawX = Math.max(maxRawX, p.avgRawX);
      minRawY = Math.min(minRawY, p.avgRawY);
      maxRawY = Math.max(maxRawY, p.avgRawY);

      minScrX = Math.min(minScrX, p.targetX);
      maxScrX = Math.max(maxScrX, p.targetX);
      minScrY = Math.min(minScrY, p.targetY);
      maxScrY = Math.max(maxScrY, p.targetY);
    });

    const rawRangeX = maxRawX - minRawX || 0.1;
    const rawRangeY = maxRawY - minRawY || 0.1;
    const scrRangeX = maxScrX - minScrX || screenWidth;
    const scrRangeY = maxScrY - minScrY || screenHeight;

    const scaleX = scrRangeX / rawRangeX;
    const scaleY = scrRangeY / rawRangeY;
    const offsetX = minScrX - (minRawX * scaleX);
    const offsetY = minScrY - (minRawY * scaleY);

    this.model = {
      isCalibrated: true,
      isCenterCalibrated: true,
      lastCalibratedAt: Date.now(),
      quadraticCoeffs,
      offsetX,
      offsetY,
      scaleX,
      scaleY,
    };

    this.saveToStorage();
    return this.model;
  }

  /**
   * Computes quadratic bivariate polynomial regression mapping parameters
   * from 9-point or N-point calibration targets with ridge regularization.
   */
  public computeFromTargets(targets: CalibrationTarget[], screenWidth: number, screenHeight: number): CalibrationModel {
    this.targetPoints.clear();

    targets.forEach(t => {
      if (t.samples && t.samples.length >= 1) {
        const sortedX = [...t.samples.map(s => s.rawX)].sort((a, b) => a - b);
        const sortedY = [...t.samples.map(s => s.rawY)].sort((a, b) => a - b);
        const sortedYaw = [...t.samples.map(s => s.headYaw || 0)].sort((a, b) => a - b);
        const sortedPitch = [...t.samples.map(s => s.headPitch || 0)].sort((a, b) => a - b);

        const trimStart = Math.floor(sortedX.length * 0.1);
        const trimEnd = Math.max(trimStart + 1, Math.ceil(sortedX.length * 0.9));

        const subX = sortedX.slice(trimStart, trimEnd);
        const subY = sortedY.slice(trimStart, trimEnd);
        const subYaw = sortedYaw.slice(trimStart, trimEnd);
        const subPitch = sortedPitch.slice(trimStart, trimEnd);

        const avgRawX = subX.reduce((a, b) => a + b, 0) / subX.length;
        const avgRawY = subY.reduce((a, b) => a + b, 0) / subY.length;
        const avgHeadYaw = subYaw.length > 0 ? subYaw.reduce((a, b) => a + b, 0) / subYaw.length : 0;
        const avgHeadPitch = subPitch.length > 0 ? subPitch.reduce((a, b) => a + b, 0) / subPitch.length : 0;

        const targetX = (t.xPercent / 100) * screenWidth;
        const targetY = (t.yPercent / 100) * screenHeight;

        this.targetPoints.set(t.id, {
          id: String(t.id),
          targetX,
          targetY,
          xPercent: t.xPercent,
          yPercent: t.yPercent,
          avgRawX,
          avgRawY,
          avgHeadYaw,
          avgHeadPitch,
          label: t.label,
          timestamp: Date.now(),
        });
      }
    });

    return this.recomputeModel(screenWidth, screenHeight);
  }

  /**
   * Maps raw gaze vector (-0.5 to +0.5 centered) to screen pixel coordinates
   * utilizing zero-offset compensation + 2nd-degree polynomial / IDW interpolation.
   */
  public mapRawGazeToScreen(
    rawX: number,
    rawY: number,
    headYaw: number,
    headPitch: number,
    screenWidth: number,
    screenHeight: number,
    sensitivityX = 1.0,
    sensitivityY = 1.0,
    useHeadCompensation = true,
    useQuadratic = true
  ): Point2D {
    const centerX = screenWidth / 2;
    const centerY = screenHeight / 2;

    // Apply auto-centering zero-offset if center calibration was performed
    const centerOffX = this.model.centerOffsetX || 0;
    const centerOffY = this.model.centerOffsetY || 0;
    const centerHeadYaw = this.model.centerHeadYaw || 0;
    const centerHeadPitch = this.model.centerHeadPitch || 0;

    const zeroedRawX = rawX - centerOffX;
    const zeroedRawY = rawY - centerOffY;
    const zeroedYaw = headYaw - centerHeadYaw;
    const zeroedPitch = headPitch - centerHeadPitch;

    // 1. High-accuracy 2nd-degree bivariate polynomial fit
    if (useQuadratic && this.model.quadraticCoeffs) {
      const { a, b } = this.model.quadraticCoeffs;
      const x2 = rawX * rawX;
      const y2 = rawY * rawY;
      const xy = rawX * rawY;

      let mappedX = a[0] + a[1] * rawX + a[2] * rawY + a[3] * x2 + a[4] * y2 + a[5] * xy;
      let mappedY = b[0] + b[1] * rawX + b[2] * rawY + b[3] * x2 + b[4] * y2 + b[5] * xy;

      mappedX = centerX + (mappedX - centerX) * sensitivityX;
      mappedY = centerY + (mappedY - centerY) * sensitivityY;

      if (useHeadCompensation) {
        mappedX += zeroedYaw * screenWidth * 0.4;
        mappedY -= zeroedPitch * screenHeight * 0.4;
      }

      return {
        x: Math.max(5, Math.min(screenWidth - 5, mappedX)),
        y: Math.max(5, Math.min(screenHeight - 5, mappedY)),
      };
    }

    // 2. Localized Inverse Distance Weighted (IDW) interpolation fallback
    if (this.targetPoints.size >= 4) {
      let weightSum = 0;
      let mappedX = 0;
      let mappedY = 0;

      this.targetPoints.forEach(tp => {
        const dx = rawX - tp.avgRawX;
        const dy = rawY - tp.avgRawY;
        const distSq = dx * dx + dy * dy;
        const weight = 1 / (distSq + 0.0001);

        weightSum += weight;
        mappedX += tp.targetX * weight;
        mappedY += tp.targetY * weight;
      });

      if (weightSum > 0) {
        mappedX /= weightSum;
        mappedY /= weightSum;

        mappedX = centerX + (mappedX - centerX) * sensitivityX;
        mappedY = centerY + (mappedY - centerY) * sensitivityY;

        if (useHeadCompensation) {
          mappedX += zeroedYaw * screenWidth * 0.45;
          mappedY -= zeroedPitch * screenHeight * 0.45;
        }

        return {
          x: Math.max(5, Math.min(screenWidth - 5, mappedX)),
          y: Math.max(5, Math.min(screenHeight - 5, mappedY)),
        };
      }
    }

    // 3. Center-Zeroed Dynamic Responsive Mapping
    let sx = centerX + (zeroedRawX * screenWidth * 1.65 * sensitivityX);
    let sy = centerY + (zeroedRawY * screenHeight * 1.85 * sensitivityY);

    if (useHeadCompensation) {
      sx += zeroedYaw * screenWidth * 0.5;
      sy -= zeroedPitch * screenHeight * 0.5;
    }

    return {
      x: Math.max(5, Math.min(screenWidth - 5, sx)),
      y: Math.max(5, Math.min(screenHeight - 5, sy)),
    };
  }

  private saveToStorage() {
    try {
      const data = {
        model: this.model,
        targets: Array.from(this.targetPoints.entries()),
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      // Ignore
    }
  }

  private loadFromStorage() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed && parsed.model) {
          this.model = parsed.model;
          if (parsed.targets) {
            this.targetPoints = new Map(parsed.targets);
          }
        }
      }
    } catch {
      // Ignore
    }
  }
}

export const calibrationEngine = new CalibrationEngine();
