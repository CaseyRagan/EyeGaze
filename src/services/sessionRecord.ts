import {
  CalibrationModel,
  CalibrationSample,
  TrackingSettings,
  ValidationResult,
} from '../types';
import { calibrationEngine } from './calibration';
import { viewingGeometry } from './viewingGeometry';

/**
 * The raw material of one set-up session, saved to a file.
 *
 * Everything else this app reports is a summary — an accuracy figure, a
 * cross-validated error, five per-point numbers. Summaries are enough to know a
 * session went badly and never enough to know why. Four bad runs in a row
 * produced four different signatures, and each was diagnosed by inference from
 * five aggregate numbers, which is guessing with extra steps.
 *
 * What breaks that loop is keeping the *samples*, not the conclusions. With
 * every sample that went into every calibration point, plus the head poses they
 * were taken at and the model that was fitted from them, a session can be
 * replayed offline: refit it with a different model, a different kernel, no head
 * compensation at all, and see which one would have put the client's gaze in the
 * right place. `scripts/replaySession.ts` does exactly that. A change to the
 * mapping can then be argued from a real client's eyes rather than from
 * synthetic data and a plausible story.
 *
 * It is also the honest record of a clinical measurement. A figure a clinician
 * acts on should be reproducible from what was actually observed.
 */
export const SESSION_RECORD_VERSION = 2;

export interface RecordedPoint {
  id: string;
  label?: string;
  /** Where the dot was, as a fraction of the viewport. */
  xNorm: number;
  yNorm: number;
  /**
   * Every usable sample collected while this dot was on screen, in order.
   *
   * The whole window rather than the accepted subset: which samples *should*
   * have been accepted is one of the things worth re-deciding offline, and a
   * recording that has already thrown away the rejects cannot answer it.
   */
  samples: CalibrationSample[];
  /** Whether each sample was judged settled at the time it arrived. */
  settled: boolean[];
  /** Sample timestamps, so dwell structure survives the trip. */
  timestamps: number[];
  /** How many samples the anchor was actually built from. */
  usedSampleCount: number;
  /** When the client pressed to confirm, in confirmed mode. */
  confirmedAt?: number;
}

export interface SessionRecord {
  version: number;
  capturedAt: string;
  environment: {
    userAgent: string;
    viewport: { width: number; height: number };
    screen: { width: number; height: number };
    devicePixelRatio: number;
  };
  camera: {
    resolution: { width: number; height: number } | null;
    fps: number;
    matrixLayout: string | null;
    usedFallbackHeadPose: boolean | null;
  };
  geometry: {
    settings: ReturnType<typeof viewingGeometry.getSettings>;
    effectiveDistanceCm: number;
    distanceConfidence: string;
    measurementAgreement: number;
    millimetresPerPixel: number;
  };
  trackingSettings: TrackingSettings;
  depth: string;
  confirmMode: boolean;
  /** The calibration grid: the points the model was taught from. */
  capture: RecordedPoint[];
  headPass: {
    samples: CalibrationSample[];
    coverage: Record<string, number>;
    outcome: string;
  } | null;
  /** The check: points the model was never fitted on. */
  validation: RecordedPoint[];
  prunedPoints: string[];
  /** The fitted model, including its residuals, so it can be reproduced exactly. */
  model: CalibrationModel;
  result: ValidationResult | null;
}

export interface SessionRecordDraft {
  depth: string;
  confirmMode: boolean;
  capture: RecordedPoint[];
  headPass: SessionRecord['headPass'];
  validation: RecordedPoint[];
  prunedPoints: string[];
  result: ValidationResult | null;
  cameraDiagnostics: {
    resolution: { width: number; height: number } | null;
    fps: number;
    matrixLayout: string | null;
    usedFallbackHeadPose: boolean | null;
  };
  trackingSettings: TrackingSettings;
}

export function buildSessionRecord(draft: SessionRecordDraft): SessionRecord {
  return {
    version: SESSION_RECORD_VERSION,
    capturedAt: new Date().toISOString(),
    environment: {
      userAgent: navigator.userAgent,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      screen: { width: window.screen?.width ?? 0, height: window.screen?.height ?? 0 },
      devicePixelRatio: window.devicePixelRatio ?? 1,
    },
    camera: draft.cameraDiagnostics,
    geometry: {
      settings: viewingGeometry.getSettings(),
      effectiveDistanceCm: viewingGeometry.getEffectiveDistanceCm(),
      distanceConfidence: viewingGeometry.getDistanceConfidence(),
      measurementAgreement: viewingGeometry.getMeasurementAgreement(),
      millimetresPerPixel: viewingGeometry.getMillimetresPerPixel(),
    },
    trackingSettings: draft.trackingSettings,
    depth: draft.depth,
    confirmMode: draft.confirmMode,
    capture: draft.capture,
    headPass: draft.headPass,
    validation: draft.validation,
    prunedPoints: draft.prunedPoints,
    model: calibrationEngine.getModel(),
    result: draft.result,
  };
}

/** Offers the record as a file. Nothing leaves the machine unless it is sent. */
export function downloadSessionRecord(record: SessionRecord) {
  const stamp = record.capturedAt.replace(/[:.]/g, '-').slice(0, 19);
  const blob = new Blob([JSON.stringify(record, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `lantern-session-${stamp}.json`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  // Revoked on the next tick so the download has taken the reference.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Roughly how large the file will be, for telling the user before they save. */
export function estimateRecordSizeKb(record: SessionRecord): number {
  return Math.round(JSON.stringify(record).length / 1024);
}
