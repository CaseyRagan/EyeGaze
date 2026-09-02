import React, { useEffect, useState } from 'react';
import { AlertCircle, CameraOff, CheckCircle2, Settings as SettingsIcon } from 'lucide-react';
import { ActivityMode } from '../types';
import { calibrationEngine } from '../services/calibration';

export interface ActivityDefinition {
  id: ActivityMode;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  group: 'play' | 'assess';
  purpose: string;
}

interface HomeScreenProps {
  appName: string;
  activities: ActivityDefinition[];
  onSelect: (id: ActivityMode) => void;
  onOpenCalibration: () => void;
  onOpenSettings: () => void;
}

/**
 * The resting place.
 *
 * A therapy tool spends a good deal of its life open but unused — between
 * clients, mid-conversation, while someone gets settled. Tracking through all
 * of that means a camera light burning at a person who is not using it, which
 * is uncomfortable in a way that no reassurance about where the video goes
 * really fixes. So this screen holds the camera off, and it is what the app
 * opens on and what the wordmark returns to.
 *
 * It doubles as the activity chooser, because picking what to do next is
 * exactly the moment you are not looking at the screen anyway.
 */
export const HomeScreen: React.FC<HomeScreenProps> = ({
  appName,
  activities,
  onSelect,
  onOpenCalibration,
  onOpenSettings,
}) => {
  const [, forceUpdate] = useState(0);
  useEffect(() => calibrationEngine.subscribe(() => forceUpdate(n => n + 1)), []);

  const validation = calibrationEngine.getValidation();
  const calibrated = calibrationEngine.isCalibrated();
  const accuracyDeg = validation && Number.isFinite(validation.accuracyDeg) ? validation.accuracyDeg : null;
  const ready = calibrated && accuracyDeg !== null && accuracyDeg <= 3;

  const play = activities.filter(a => a.group === 'play');
  const assess = activities.filter(a => a.group === 'assess');

  return (
    <div className="absolute inset-0 overflow-auto bg-[var(--surface)]">
      <div className="max-w-4xl mx-auto px-6 py-12 space-y-8">
        <header className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-3xl font-semibold text-ink">{appName}</h1>
            <p className="text-sm text-ink-soft mt-1.5 max-w-lg leading-relaxed">
              Eye tracking for therapy and for play. Choose something to do, and the camera starts.
            </p>
          </div>
          <button
            onClick={onOpenSettings}
            className="p-2.5 rounded-xl text-ink-soft hover:text-ink hover:bg-[var(--surface-sunken)] transition-colors"
            aria-label="Settings"
          >
            <SettingsIcon className="w-5 h-5" />
          </button>
        </header>

        <div className="surface rounded-2xl px-6 py-5 flex items-start justify-between gap-4 flex-wrap">
          <div className="flex items-start gap-3">
            {ready ? (
              <CheckCircle2 className="w-5 h-5 mt-0.5 shrink-0 text-sage-600" />
            ) : (
              <AlertCircle className="w-5 h-5 mt-0.5 shrink-0 text-clay-500" />
            )}
            <div>
              <p className="text-sm font-medium text-ink">
                {!calibrated
                  ? 'Eye tracking is not set up yet'
                  : accuracyDeg === null
                  ? 'Set up, but accuracy has not been checked'
                  : `Set up — accuracy about ${accuracyDeg.toFixed(1)}°`}
              </p>
              <p className="text-xs text-ink-soft mt-1 leading-relaxed max-w-md">
                {!calibrated
                  ? 'It takes under a minute, and you get an accuracy figure so you know how much to trust what follows.'
                  : ready
                  ? 'Good to go. Worth running again if someone else sits down, or if you move seat.'
                  : 'Worth another go before measuring anything — set-up will say what is working against it.'}
              </p>
            </div>
          </div>
          <button
            onClick={onOpenCalibration}
            className={`px-5 py-2.5 rounded-xl font-medium text-sm transition-colors shrink-0 ${
              ready
                ? 'border border-strong text-ink hover:bg-[var(--surface-sunken)]'
                : 'bg-sage-500 hover:bg-sage-600 text-white'
            }`}
          >
            {calibrated ? 'Set up again' : 'Start set-up'}
          </button>
        </div>

        <Section title="Practice and play" activities={play} onSelect={onSelect} />
        <Section title="Assessment" activities={assess} onSelect={onSelect} />

        <p className="text-xs text-ink-faint flex items-center gap-2 pt-2">
          <CameraOff className="w-3.5 h-3.5" />
          The camera is off while you are on this screen. It starts when you choose an activity, and
          stops again when you come back.
        </p>
      </div>
    </div>
  );
};

const Section: React.FC<{
  title: string;
  activities: ActivityDefinition[];
  onSelect: (id: ActivityMode) => void;
}> = ({ title, activities, onSelect }) => {
  if (activities.length === 0) return null;
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-semibold text-ink-soft">{title}</h2>
      <div className="grid sm:grid-cols-2 gap-3">
        {activities.map(activity => {
          const Icon = activity.icon;
          return (
            <button
              key={activity.id}
              onClick={() => onSelect(activity.id)}
              className="surface rounded-2xl px-5 py-4 text-left flex items-start gap-3.5 hover:border-strong transition-colors group"
            >
              <span className="w-10 h-10 rounded-xl bg-sage-100 text-sage-600 flex items-center justify-center shrink-0 transition-colors group-hover:bg-sage-200">
                <Icon className="w-5 h-5" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium text-ink">{activity.label}</span>
                <span className="block text-xs text-ink-soft mt-1 leading-relaxed">{activity.purpose}</span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
};
