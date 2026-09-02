import React, { useEffect, useState } from 'react';
import { Check, Copy, X } from 'lucide-react';
import { FaceMeshTracker } from '../services/faceMeshTracker';
import { calibrationEngine } from '../services/calibration';
import { viewingGeometry } from '../services/viewingGeometry';
import { useThrottledGaze } from '../services/gazeBus';

interface DiagnosticsPanelProps {
  isOpen: boolean;
  tracker: FaceMeshTracker | null;
  onClose: () => void;
}

/**
 * The raw state of the tracker, in one place.
 *
 * Every accuracy problem in this project so far has been a plausible-looking
 * number produced by a broken intermediate — a transposed rotation matrix, a
 * viewing distance three times too small, calibration points recorded in a
 * different coordinate space from the one they were drawn in. None of them were
 * visible from the outside, and each took a round trip with the person sitting
 * in front of the camera to find.
 *
 * So this exists to make the next one visible immediately. It is also why there
 * is a copy button: the fastest way to diagnose a tracking problem on hardware
 * you do not have is to be handed the numbers.
 */
export const DiagnosticsPanel: React.FC<DiagnosticsPanelProps> = ({ isOpen, tracker, onClose }) => {
  const gaze = useThrottledGaze(4);
  const [copied, setCopied] = useState(false);
  const [, tick] = useState(0);

  // The tracker's diagnostics live outside React, so poll them while open.
  useEffect(() => {
    if (!isOpen) return;
    const id = window.setInterval(() => tick(n => n + 1), 400);
    return () => window.clearInterval(id);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const diag = tracker?.getDiagnostics();
  const model = calibrationEngine.getModel();
  const validation = calibrationEngine.getValidation();
  const geometry = viewingGeometry.getSettings();
  const toDeg = (rad: number) => `${((rad * 180) / Math.PI).toFixed(1)}°`;

  // With no frames from the camera there is nothing to report, and showing
  // "undefined" or a confident agreement figure would be worse than saying so.
  const hasCameraSignal = !!diag?.features;

  const report = {
    capturedAt: new Date().toISOString(),
    camera: {
      resolution: diag?.resolution ? `${diag.resolution.width}x${diag.resolution.height}` : null,
      fps: diag?.fps ?? null,
      hasSignal: hasCameraSignal,
      landmarkCount: diag?.features?.landmarkCount ?? null,
      matrixLayout: diag?.features?.matrixLayout ?? null,
      usedFallbackHeadPose: diag?.features?.usedFallbackHeadPose ?? null,
    },
    signal: gaze
      ? {
          gx: Number(gaze.gx.toFixed(5)),
          gy: Number(gaze.gy.toFixed(5)),
          confidence: Number(gaze.confidence.toFixed(3)),
          event: gaze.event,
          isHeld: gaze.isHeld,
          velocityDegPerSec: Number(gaze.velocityDegPerSec.toFixed(1)),
        }
      : null,
    head: gaze
      ? {
          yawDeg: Number(((gaze.headPose.yaw * 180) / Math.PI).toFixed(1)),
          pitchDeg: Number(((gaze.headPose.pitch * 180) / Math.PI).toFixed(1)),
          rollDeg: Number(((gaze.headPose.roll * 180) / Math.PI).toFixed(1)),
          translateX: Number(gaze.headPose.translateX.toFixed(4)),
          translateY: Number(gaze.headPose.translateY.toFixed(4)),
          interocularSpan: Number(gaze.headPose.interocularSpan.toFixed(4)),
        }
      : null,
    distance: {
      fromFaceModelCm: diag?.features?.modelDistanceCm ?? null,
      fromIrisSizeCm: diag?.features?.irisDistanceCm ?? null,
      agreement: gaze ? Number(gaze.headPose.distanceAgreement.toFixed(2)) : null,
      inUseCm: Number(viewingGeometry.getEffectiveDistanceCm().toFixed(1)),
      isMeasured: viewingGeometry.isDistanceMeasured(),
      userScale: Number(geometry.distanceScale.toFixed(3)),
    },
    screen: {
      diagonalInches: geometry.screenDiagonalInches,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      screen: `${window.screen?.width}x${window.screen?.height}`,
      devicePixelRatio: window.devicePixelRatio,
      mmPerPixel: Number(viewingGeometry.getMillimetresPerPixel().toFixed(4)),
      workingAreaScale: geometry.workingAreaScale,
      halfAngleDeg: Number(viewingGeometry.getViewportHalfAngleDeg().toFixed(1)),
    },
    calibration: {
      isCalibrated: model.isCalibrated,
      anchors: calibrationEngine.getAnchors().length,
      degree: model.regression?.degree ?? null,
      headGain: model.headGain ?? null,
      leaveOneOutErrorPx: model.quality ? Number(model.quality.crossValidatedErrorPx.toFixed(1)) : null,
      coverage: model.quality ? Number(model.quality.coverage.toFixed(2)) : null,
    },
    lastCheck: validation
      ? {
          accuracyDeg: Number(validation.accuracyDeg.toFixed(2)),
          accuracyPx: Number(validation.accuracyPx.toFixed(0)),
          precisionDeg: Number(validation.precisionDeg.toFixed(2)),
          trackingRatio: Number(validation.trackingRatio.toFixed(2)),
          perPointDeg: validation.points.map(p => Number(p.errorDeg.toFixed(2))),
        }
      : null,
    userAgent: navigator.userAgent,
  };

  const copy = () => {
    navigator.clipboard.writeText(JSON.stringify(report, null, 2)).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2200);
    });
  };

  const layout = diag?.features?.matrixLayout;
  const layoutIsHealthy = layout === 'column-major' || layout === 'row-major';

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-[rgba(44,50,48,0.25)]" onClick={onClose}>
      <aside
        className="w-full max-w-lg h-full bg-[var(--surface-raised)] shadow-lift overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <header className="sticky top-0 bg-[var(--surface-raised)] border-b border-soft px-6 py-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-ink">What the tracker is seeing</h2>
          <div className="flex items-center gap-2">
            <button
              onClick={copy}
              className="px-3 py-2 rounded-xl border border-strong text-sm text-ink flex items-center gap-2 hover:bg-[var(--surface-sunken)] transition-colors"
            >
              {copied ? <Check className="w-4 h-4 text-sage-600" /> : <Copy className="w-4 h-4" />}
              {copied ? 'Copied' : 'Copy report'}
            </button>
            <button
              onClick={onClose}
              className="p-2 rounded-xl text-ink-faint hover:text-ink hover:bg-[var(--surface-sunken)] transition-colors"
              aria-label="Close"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </header>

        <div className="px-6 py-5 space-y-6">
          <p className="text-sm text-ink-soft leading-relaxed">
            If tracking is not behaving, copy this and send it over. It is far faster to read the
            numbers than to guess at them from a description.
          </p>

          {!hasCameraSignal && (
            <div className="rounded-2xl border border-honey-300 bg-honey-100 px-4 py-3">
              <p className="text-sm text-honey-700 leading-relaxed">
                No frames are arriving from the camera, so the readings below are empty or come from
                the mouse fallback rather than from your eyes.
              </p>
            </div>
          )}

          <Group title="Camera">
            <Row label="Resolution" value={report.camera.resolution ?? '—'} />
            <Row label="Frames per second" value={report.camera.fps !== null ? String(report.camera.fps) : '—'} />
            <Row
              label="Landmarks"
              value={report.camera.landmarkCount !== null ? String(report.camera.landmarkCount) : '—'}
              warn={report.camera.landmarkCount !== null && report.camera.landmarkCount < 478}
              note={
                report.camera.landmarkCount !== null && report.camera.landmarkCount < 478
                  ? 'Iris landmarks missing — gaze cannot be measured properly'
                  : undefined
              }
            />
            <Row
              label="Head pose source"
              value={
                !hasCameraSignal
                  ? '—'
                  : layout === 'absent'
                  ? 'facial proportions (no matrix)'
                  : layout === 'undetectable'
                  ? 'facial proportions (matrix unreadable)'
                  : `face model (${layout})`
              }
              warn={hasCameraSignal && !layoutIsHealthy}
              note={
                hasCameraSignal && !layoutIsHealthy
                  ? 'Falling back to a rougher estimate from facial proportions'
                  : undefined
              }
            />
          </Group>

          <Group title="Distance — every degree figure is computed from this">
            <Row
              label="From the face model"
              value={report.distance.fromFaceModelCm !== null ? `${report.distance.fromFaceModelCm.toFixed(0)} cm` : 'unavailable'}
            />
            <Row
              label="From the iris size"
              value={report.distance.fromIrisSizeCm !== null ? `${report.distance.fromIrisSizeCm.toFixed(0)} cm` : 'unavailable'}
            />
            <Row
              label="Agreement"
              value={
                hasCameraSignal && report.distance.agreement !== null
                  ? `${Math.round(report.distance.agreement * 100)}%`
                  : '—'
              }
              warn={hasCameraSignal && report.distance.agreement !== null && report.distance.agreement < 0.5}
              note={
                hasCameraSignal && report.distance.agreement !== null && report.distance.agreement < 0.5
                  ? 'The two estimates disagree, so the setting is being used instead'
                  : undefined
              }
            />
            <Row
              label="In use"
              value={`${report.distance.inUseCm} cm${report.distance.isMeasured ? ' (measured)' : ' (from settings)'}`}
              warn={report.distance.inUseCm < 32 || report.distance.inUseCm > 95}
              note={
                report.distance.inUseCm < 32 || report.distance.inUseCm > 95
                  ? 'Nobody sits at this distance — correct it in settings'
                  : undefined
              }
            />
            {report.distance.userScale !== 1 && (
              <Row label="Your correction" value={`x${report.distance.userScale}`} />
            )}
          </Group>

          <Group title="How much eye movement the screen demands">
            <Row
              label="Screen edges are"
              value={`${report.screen.halfAngleDeg}° off centre`}
              warn={report.screen.halfAngleDeg > 22}
              note={
                report.screen.halfAngleDeg > 22
                  ? 'Past about 22° the iris starts hiding behind the eyelid and accuracy falls away — sit further back or reduce the working area'
                  : undefined
              }
            />
            <Row
              label="Working area"
              value={
                report.screen.workingAreaScale >= 0.99
                  ? 'whole window'
                  : `${Math.round(report.screen.workingAreaScale * 100)}% of the window`
              }
            />
          </Group>

          <Group title="Signal right now">
            <Row label="Eye measurement" value={gaze ? `${gaze.gx.toFixed(4)}, ${gaze.gy.toFixed(4)}` : '—'} />
            <Row label="Confidence" value={gaze ? `${Math.round(gaze.confidence * 100)}%` : '—'} />
            <Row label="State" value={gaze ? (gaze.isHeld ? `${gaze.event} (held)` : gaze.event) : '—'} />
            <Row
              label="Head turn"
              value={gaze ? `${toDeg(gaze.headPose.yaw)} yaw, ${toDeg(gaze.headPose.pitch)} pitch` : '—'}
            />
          </Group>

          <Group title="Calibration">
            <Row label="Points in use" value={String(report.calibration.anchors)} />
            <Row label="Model terms" value={report.calibration.degree !== null ? String(report.calibration.degree) : '—'} />
            <Row
              label="Head allowance"
              value={
                report.calibration.headGain
                  ? `x${report.calibration.headGain.rotation.toFixed(2)} turn, x${report.calibration.headGain.translation.toFixed(2)} shift`
                  : 'standard'
              }
            />
            <Row
              label="Points agree to within"
              value={
                report.calibration.leaveOneOutErrorPx !== null
                  ? `${report.calibration.leaveOneOutErrorPx} px`
                  : '—'
              }
            />
          </Group>

          {report.lastCheck && (
            <Group title="Last accuracy check">
              <Row label="Accuracy" value={`${report.lastCheck.accuracyDeg}° (${report.lastCheck.accuracyPx} px)`} />
              <Row label="Steadiness" value={`${report.lastCheck.precisionDeg}°`} />
              <Row label="Eyes found" value={`${Math.round(report.lastCheck.trackingRatio * 100)}%`} />
              <Row label="Per point" value={report.lastCheck.perPointDeg.map(d => `${d}°`).join(', ')} />
            </Group>
          )}
        </div>
      </aside>
    </div>
  );
};

const Group: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <section>
    <h3 className="text-sm font-semibold text-ink mb-2">{title}</h3>
    <dl className="surface-quiet rounded-xl divide-y divide-[var(--border-soft)]">{children}</dl>
  </section>
);

const Row: React.FC<{ label: string; value: string; warn?: boolean; note?: string }> = ({
  label,
  value,
  warn,
  note,
}) => (
  <div className="px-4 py-2.5">
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-sm text-ink-soft">{label}</dt>
      <dd className={`text-sm font-medium tabular-nums text-right ${warn ? 'text-clay-500' : 'text-ink'}`}>
        {value}
      </dd>
    </div>
    {note && <p className="text-xs text-clay-500 mt-1 leading-relaxed">{note}</p>}
  </div>
);
