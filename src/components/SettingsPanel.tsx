import React, { useEffect, useState } from 'react';
import { Monitor, RotateCcw, Sliders, Sun, Volume2, X } from 'lucide-react';
import { TrackingEngineMode, TrackingSettings } from '../types';
import { calibrationEngine } from '../services/calibration';
import { viewingGeometry } from '../services/viewingGeometry';
import { soundEngine } from '../services/audio';
import { useThrottledGaze } from '../services/gazeBus';

interface SettingsPanelProps {
  isOpen: boolean;
  settings: TrackingSettings;
  theme: 'light' | 'dim';
  onThemeChange: (theme: 'light' | 'dim') => void;
  onClose: () => void;
  onUpdateSettings: (patch: Partial<TrackingSettings>) => void;
  onRecalibrate: () => void;
}

const ENGINE_MODES: Array<{ value: TrackingEngineMode; label: string; detail: string }> = [
  { value: 'binocular', label: 'Both eyes', detail: 'The default. Averages the two eyes and weights the clearer one more heavily.' },
  { value: 'left_eye', label: 'Left eye only', detail: 'For a strabismus, an occluded eye, or a monocular assessment.' },
  { value: 'right_eye', label: 'Right eye only', detail: 'As above, for the other eye.' },
  { value: 'head_pointer', label: 'Head pointing', detail: 'Point with head movement instead of gaze. Useful when eye movement is unreliable, or when head control is the target.' },
];

export const SettingsPanel: React.FC<SettingsPanelProps> = ({
  isOpen,
  settings,
  theme,
  onThemeChange,
  onClose,
  onUpdateSettings,
  onRecalibrate,
}) => {
  const [geometry, setGeometry] = useState(viewingGeometry.getSettings());

  useEffect(() => {
    if (isOpen) setGeometry(viewingGeometry.getSettings());
  }, [isOpen]);

  if (!isOpen) return null;

  const updateGeometry = (patch: Partial<typeof geometry>) => {
    const next = { ...geometry, ...patch };
    setGeometry(next);
    viewingGeometry.updateSettings(patch);
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-[rgba(44,50,48,0.25)]" onClick={onClose}>
      <aside
        className="w-full max-w-md h-full bg-[var(--surface-raised)] shadow-lift overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        <header className="sticky top-0 bg-[var(--surface-raised)] border-b border-soft px-6 py-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-ink flex items-center gap-2">
            <Sliders className="w-4 h-4 text-sage-500" />
            Settings
          </h2>
          <button
            onClick={onClose}
            className="p-2 rounded-xl text-ink-faint hover:text-ink hover:bg-[var(--surface-sunken)] transition-colors"
            aria-label="Close settings"
          >
            <X className="w-5 h-5" />
          </button>
        </header>

        <div className="px-6 py-5 space-y-8">
          <Section
            title="Your screen"
            description="These two numbers are what turn a pixel error into a degree of visual angle. If they are wrong, every accuracy figure in the app is wrong too."
            icon={Monitor}
          >
            <Field label="Screen size (diagonal)" value={`${geometry.screenDiagonalInches}"`}>
              <input
                type="range"
                min={9}
                max={34}
                step={0.1}
                value={geometry.screenDiagonalInches}
                onChange={e => updateGeometry({ screenDiagonalInches: Number(e.target.value) })}
                className="w-full"
              />
            </Field>

            <label className="flex items-start gap-3 text-sm text-ink-soft cursor-pointer">
              <input
                type="checkbox"
                checked={geometry.useMeasuredDistance}
                onChange={e => updateGeometry({ useMeasuredDistance: e.target.checked })}
                className="mt-1 accent-[var(--color-sage-500)]"
              />
              <span>
                <span className="text-ink font-medium block">Measure viewing distance from the camera</span>
                Estimated two ways — from the face model, and from how large the iris appears. Both
                divide by an assumed camera lens angle, and webcams vary, so check it below.
              </span>
            </label>

            {geometry.useMeasuredDistance && <DistanceCheck onChanged={() => setGeometry(viewingGeometry.getSettings())} />}

            {!geometry.useMeasuredDistance && (
              <Field label="Viewing distance" value={`${geometry.assumedDistanceCm} cm`}>
                <input
                  type="range"
                  min={30}
                  max={100}
                  step={1}
                  value={geometry.assumedDistanceCm}
                  onChange={e => updateGeometry({ assumedDistanceCm: Number(e.target.value) })}
                  className="w-full"
                />
              </Field>
            )}
          </Section>

          <Section title="Which eyes to use" description="" icon={Sliders}>
            <div className="space-y-2">
              {ENGINE_MODES.map(mode => (
                <button
                  key={mode.value}
                  onClick={() => onUpdateSettings({ trackingEngineMode: mode.value })}
                  className={`w-full text-left px-4 py-3 rounded-xl border transition-colors ${
                    (settings.trackingEngineMode ?? 'binocular') === mode.value
                      ? 'border-sage-400 bg-sage-50'
                      : 'border-soft hover:border-strong'
                  }`}
                >
                  <span className="text-sm font-medium text-ink">{mode.label}</span>
                  <span className="block text-xs text-ink-soft mt-0.5 leading-relaxed">{mode.detail}</span>
                </button>
              ))}
            </div>
            {settings.trackingEngineMode && settings.trackingEngineMode !== 'binocular' && (
              <p className="text-xs text-honey-700 bg-honey-100 border border-honey-300 rounded-xl px-3 py-2 leading-relaxed">
                Changing which eyes are used changes what the tracker measures, so the existing
                calibration no longer applies. Run set-up again before relying on the numbers.
              </p>
            )}
          </Section>

          <Section
            title="Feel of the pointer"
            description="Steadier is calmer but lags a little behind fast eye movements. Quicker keeps up but shows more of the eye's natural tremor."
            icon={Sliders}
          >
            <Field label="Steadiness" value={settings.oneEuroMinCutoff <= 0.6 ? 'Very steady' : settings.oneEuroMinCutoff >= 1.6 ? 'Very quick' : 'Balanced'}>
              <input
                type="range"
                min={0.3}
                max={2.5}
                step={0.05}
                value={settings.oneEuroMinCutoff}
                onChange={e => onUpdateSettings({ oneEuroMinCutoff: Number(e.target.value) })}
                className="w-full"
              />
            </Field>

            <Field label="Ignore small wobble" value={`${settings.deadzone} px`}>
              <input
                type="range"
                min={0}
                max={24}
                step={1}
                value={settings.deadzone}
                onChange={e => onUpdateSettings({ deadzone: Number(e.target.value) })}
                className="w-full"
              />
            </Field>

            <Field label="How long to hold a look to select" value={`${(settings.dwellDurationMs / 1000).toFixed(1)} s`}>
              <input
                type="range"
                min={300}
                max={2500}
                step={50}
                value={settings.dwellDurationMs}
                onChange={e => onUpdateSettings({ dwellDurationMs: Number(e.target.value) })}
                className="w-full"
              />
            </Field>

            <Field
              label="Reach"
              value={settings.sensitivityX === 1 ? 'Normal' : `${Math.round(settings.sensitivityX * 100)}%`}
            >
              <input
                type="range"
                min={0.7}
                max={1.6}
                step={0.05}
                value={settings.sensitivityX}
                onChange={e =>
                  onUpdateSettings({ sensitivityX: Number(e.target.value), sensitivityY: Number(e.target.value) })
                }
                className="w-full"
              />
              <p className="text-xs text-ink-faint mt-1 leading-relaxed">
                Turn this up if the screen edges feel out of reach. It is a comfort adjustment, not an
                accuracy one — it stretches the mapping rather than improving it.
              </p>
            </Field>

            <Toggle
              label="Hold steady through blinks"
              detail="Keeps the pointer where it was instead of following the eyelids down."
              checked={settings.holdThroughBlinks}
              onChange={v => onUpdateSettings({ holdThroughBlinks: v })}
            />
          </Section>

          <Section title="What you see" description="" icon={Sun}>
            <div className="flex gap-2">
              {(['light', 'dim'] as const).map(t => (
                <button
                  key={t}
                  onClick={() => onThemeChange(t)}
                  className={`flex-1 px-4 py-2.5 rounded-xl border text-sm font-medium transition-colors ${
                    theme === t ? 'border-sage-400 bg-sage-50 text-ink' : 'border-soft text-ink-soft hover:border-strong'
                  }`}
                >
                  {t === 'light' ? 'Daylight' : 'Dimmed room'}
                </button>
              ))}
            </div>

            <Toggle
              label="Show the gaze marker"
              detail="Some people track better without seeing where the tracker thinks they are looking."
              checked={settings.showGazeReticle}
              onChange={v => onUpdateSettings({ showGazeReticle: v })}
            />
            <Toggle
              label="Show a short trail"
              checked={settings.showGazeTrail}
              onChange={v => onUpdateSettings({ showGazeTrail: v })}
            />
            <Toggle
              label="Show the camera view"
              checked={settings.showWebcamPiP}
              onChange={v => onUpdateSettings({ showWebcamPiP: v })}
            />
            <Toggle
              label="Show the head position guide"
              detail="Keeps the set-up target on screen so you can line back up after moving or looking away, without redoing set-up. Toggle it any time with H."
              checked={settings.showPostureGuide}
              onChange={v => onUpdateSettings({ showPostureGuide: v })}
            />
          </Section>

          <Section title="Sound" description="" icon={Volume2}>
            <Toggle
              label="Sound effects"
              checked={settings.audioEnabled}
              onChange={v => {
                onUpdateSettings({ audioEnabled: v });
                soundEngine.setEnabled(v);
              }}
            />
          </Section>

          <Section title="Calibration" description="" icon={RotateCcw}>
            <button
              onClick={onRecalibrate}
              className="w-full py-3 rounded-xl bg-sage-500 hover:bg-sage-600 text-white font-medium transition-colors"
            >
              Run set-up again
            </button>
            <button
              onClick={() => {
                if (window.confirm('Clear the saved calibration? You will need to run set-up again.')) {
                  calibrationEngine.reset();
                }
              }}
              className="w-full py-3 rounded-xl border border-strong text-ink-soft hover:text-ink font-medium transition-colors"
            >
              Clear saved calibration
            </button>
          </Section>
        </div>
      </aside>
    </div>
  );
};

/**
 * Lets the user anchor the distance estimate to a real measurement.
 *
 * Every accuracy figure the app reports in degrees is computed from this
 * number, so an estimate that is out by a factor of three turns a two-degree
 * result into a nine-degree one and sends someone chasing a tracking problem
 * that does not exist. Thirty seconds with a tape measure removes the whole
 * class of error.
 */
const DistanceCheck: React.FC<{ onChanged: () => void }> = ({ onChanged }) => {
  const gaze = useThrottledGaze(3);
  const [entry, setEntry] = useState('');
  const [saved, setSaved] = useState(false);

  const measured = viewingGeometry.getMeasuredDistanceCm();
  const agreement = viewingGeometry.getMeasurementAgreement();
  const reliable = viewingGeometry.isDistanceMeasured();

  const apply = () => {
    const value = Number(entry);
    if (!Number.isFinite(value)) return;
    if (viewingGeometry.calibrateDistance(value)) {
      setSaved(true);
      setEntry('');
      onChanged();
      window.setTimeout(() => setSaved(false), 2500);
    }
  };

  return (
    <div className="rounded-xl surface-quiet px-4 py-3 space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm text-ink">Right now it reads</span>
        <span className="text-sm font-semibold text-ink tabular-nums">
          {gaze && measured !== null ? `${measured.toFixed(0)} cm` : '—'}
        </span>
      </div>

      {!reliable && measured !== null && (
        <p className="text-xs text-honey-700 leading-relaxed">
          The two estimates disagree{agreement > 0 ? ` (${Math.round(agreement * 100)}% agreement)` : ''}, so
          the setting above is being used instead. Correcting it below will fix that.
        </p>
      )}

      <p className="text-xs text-ink-soft leading-relaxed">
        If that is wrong, measure from your eyes to the screen and type the real number. Everything
        after that is scaled to match.
      </p>

      <div className="flex gap-2">
        <input
          type="number"
          inputMode="decimal"
          min={20}
          max={150}
          value={entry}
          onChange={e => setEntry(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && apply()}
          placeholder="cm"
          className="flex-1 min-w-0 px-3 py-2 rounded-lg border border-soft bg-[var(--surface-raised)] text-sm text-ink"
        />
        <button
          onClick={apply}
          disabled={!entry || measured === null}
          className="px-4 py-2 rounded-lg bg-sage-500 hover:bg-sage-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
        >
          {saved ? 'Saved' : 'Set'}
        </button>
      </div>
    </div>
  );
};

const Section: React.FC<{
  title: string;
  description?: string;
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}> = ({ title, description, icon: Icon, children }) => (
  <section className="space-y-3">
    <div>
      <h3 className="text-sm font-semibold text-ink flex items-center gap-2">
        <Icon className="w-4 h-4 text-sage-500" />
        {title}
      </h3>
      {description && <p className="text-xs text-ink-soft mt-1 leading-relaxed">{description}</p>}
    </div>
    {children}
  </section>
);

const Field: React.FC<{ label: string; value: string; children: React.ReactNode }> = ({ label, value, children }) => (
  <div>
    <div className="flex justify-between items-baseline mb-1">
      <span className="text-sm text-ink">{label}</span>
      <span className="text-sm text-ink-soft tabular-nums">{value}</span>
    </div>
    {children}
  </div>
);

const Toggle: React.FC<{
  label: string;
  detail?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}> = ({ label, detail, checked, onChange }) => (
  <label className="flex items-start gap-3 cursor-pointer">
    <input
      type="checkbox"
      checked={checked}
      onChange={e => onChange(e.target.checked)}
      className="mt-1 accent-[var(--color-sage-500)]"
    />
    <span className="text-sm">
      <span className="text-ink font-medium block">{label}</span>
      {detail && <span className="text-xs text-ink-soft leading-relaxed">{detail}</span>}
    </span>
  </label>
);
