/**
 * Small, dependency-free linear algebra and robust-statistics helpers used by
 * the calibration model.
 *
 * Everything here is written for the sizes we actually use (at most ~12
 * unknowns, a few thousand samples), so clarity beats micro-optimisation.
 */

/** Solves A·x = b by Gaussian elimination with partial pivoting. */
export function solveLinearSystem(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  if (n === 0 || A.length !== n) return null;

  const M: number[][] = A.map((row, i) => [...row, b[i]]);

  for (let i = 0; i < n; i++) {
    let maxRow = i;
    for (let k = i + 1; k < n; k++) {
      if (Math.abs(M[k][i]) > Math.abs(M[maxRow][i])) maxRow = k;
    }
    [M[i], M[maxRow]] = [M[maxRow], M[i]];

    if (Math.abs(M[i][i]) < 1e-12) return null;

    for (let k = i + 1; k < n; k++) {
      const c = M[k][i] / M[i][i];
      if (c === 0) continue;
      for (let j = i; j <= n; j++) M[k][j] -= c * M[i][j];
    }
  }

  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = M[i][n];
    for (let j = i + 1; j < n; j++) sum -= M[i][j] * x[j];
    x[i] = sum / M[i][i];
  }
  return x.every(Number.isFinite) ? x : null;
}

/**
 * Ridge regression: minimises ‖Φ·w − y‖² + λ‖w‖² (the intercept, assumed to be
 * column 0, is left unpenalised so the fit is not biased toward zero).
 *
 * Features are expected to be standardised by the caller; the ridge penalty is
 * only fair when every column is on the same scale.
 */
export function ridgeSolve(phi: number[][], y: number[], lambda: number): number[] | null {
  const n = phi.length;
  if (n === 0) return null;
  const k = phi[0].length;

  const ATA: number[][] = Array.from({ length: k }, () => new Array(k).fill(0));
  const ATy: number[] = new Array(k).fill(0);

  for (let r = 0; r < n; r++) {
    const row = phi[r];
    for (let i = 0; i < k; i++) {
      ATy[i] += row[i] * y[r];
      for (let j = i; j < k; j++) ATA[i][j] += row[i] * row[j];
    }
  }
  // Mirror the symmetric upper triangle we just filled.
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < i; j++) ATA[i][j] = ATA[j][i];
  }
  for (let i = 1; i < k; i++) ATA[i][i] += lambda;

  return solveLinearSystem(ATA, ATy);
}

/** Column-wise mean and standard deviation, with a floor to avoid divide-by-zero. */
export function standardiseColumns(rows: number[][]): { mean: number[]; std: number[] } {
  const k = rows[0]?.length ?? 0;
  const mean = new Array(k).fill(0);
  const std = new Array(k).fill(1);
  if (rows.length === 0) return { mean, std };

  for (const row of rows) {
    for (let i = 0; i < k; i++) mean[i] += row[i];
  }
  for (let i = 0; i < k; i++) mean[i] /= rows.length;

  for (const row of rows) {
    for (let i = 0; i < k; i++) {
      const d = row[i] - mean[i];
      std[i] += d * d;
    }
  }
  for (let i = 0; i < k; i++) {
    std[i] = Math.sqrt(std[i] / Math.max(1, rows.length));
    if (!Number.isFinite(std[i]) || std[i] < 1e-6) std[i] = 1;
  }
  return { mean, std };
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Median absolute deviation, scaled so it estimates σ for normal data. */
export function medianAbsoluteDeviation(values: number[], centre?: number): number {
  if (values.length === 0) return 0;
  const m = centre ?? median(values);
  return 1.4826 * median(values.map(v => Math.abs(v - m)));
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function standardDeviation(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = values.reduce((acc, v) => acc + (v - m) * (v - m), 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/**
 * Pearson correlation. Returns 0 when either channel is flat, because an axis
 * that never moved is not correlated with anything — it is simply absent.
 */
export function correlation(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length < 2) return 0;
  const meanA = mean(a);
  const meanB = mean(b);
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < a.length; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  if (varA < 1e-12 || varB < 1e-12) return 0;
  return cov / Math.sqrt(varA * varB);
}

/**
 * Drops samples further than `threshold` MADs from the median on any of the
 * supplied channels, then returns the surviving indices. Falls back to keeping
 * everything if rejection would leave too little data to work with.
 */
export function robustInlierIndices(channels: number[][], threshold = 2.5): number[] {
  const n = channels[0]?.length ?? 0;
  if (n === 0) return [];

  const keep: number[] = [];
  const centres = channels.map(c => median(c));
  const spreads = channels.map((c, i) => Math.max(1e-6, medianAbsoluteDeviation(c, centres[i])));

  for (let i = 0; i < n; i++) {
    let ok = true;
    for (let c = 0; c < channels.length; c++) {
      if (Math.abs(channels[c][i] - centres[c]) > threshold * spreads[c]) {
        ok = false;
        break;
      }
    }
    if (ok) keep.push(i);
  }

  if (keep.length < Math.max(3, Math.floor(n * 0.4))) {
    return Array.from({ length: n }, (_, i) => i);
  }
  return keep;
}
