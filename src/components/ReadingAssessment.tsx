import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, BookOpen, Check, Download, Play } from 'lucide-react';
import { GazeState } from '../types';
import { gazeBus } from '../services/gazeBus';
import {
  Fixation,
  RawGazeSample,
  ReadingAnalysis,
  WordBox,
  analyseReading,
  interpretReading,
  toRawSample,
} from '../services/readingMetrics';
import { READING_PASSAGES, ReadingPassage, wordCountOf } from '../data/readingPassages';
import { describeGrade, normForGrade } from '../data/readingNorms';
import { calibrationEngine } from '../services/calibration';
import { soundEngine } from '../services/audio';

type Stage = 'choose' | 'reading' | 'questions' | 'report';

/** Fixed so the passage lays out identically during reading and in the report. */
const TEXT_WIDTH = 720;

interface RecordedSession {
  passage: ReadingPassage;
  samples: RawGazeSample[];
  words: WordBox[];
  lineHeight: number;
  containerRect: { left: number; top: number; width: number; height: number };
  durationSec: number;
}

/**
 * Reading eye-movement assessment.
 *
 * The measurement here is deliberately close to what established clinical
 * reading-eye-movement instruments report, so results can sit alongside them in
 * a file: fixations and regressions per hundred words, span of recognition,
 * mean fixation duration, and reading rate with comprehension, each with a
 * grade equivalent. What it adds is a visible scanpath and an honest statement
 * of how well the tracker was working while it measured.
 */
export const ReadingAssessment: React.FC = () => {
  const [stage, setStage] = useState<Stage>('choose');
  const [passage, setPassage] = useState<ReadingPassage>(READING_PASSAGES[1]);
  const [answers, setAnswers] = useState<number[]>([]);
  const [analysis, setAnalysis] = useState<ReadingAnalysis | null>(null);
  const [session, setSession] = useState<RecordedSession | null>(null);

  const samplesRef = useRef<RawGazeSample[]>([]);
  const startTimeRef = useRef(0);
  const textRef = useRef<HTMLParagraphElement | null>(null);
  const recordingRef = useRef(false);

  // Recording subscribes once and writes into a ref; nothing here re-renders
  // while the client is reading, which matters because a re-render mid-passage
  // is a visible flicker to someone concentrating on the text.
  useEffect(
    () =>
      gazeBus.subscribe((gaze: GazeState) => {
        if (recordingRef.current) samplesRef.current.push(toRawSample(gaze));
      }),
    []
  );

  const measureWords = useCallback((): { words: WordBox[]; lineHeight: number; rect: DOMRect } | null => {
    const container = textRef.current;
    if (!container) return null;

    const spans: HTMLElement[] = Array.from(container.querySelectorAll('[data-word]')) as HTMLElement[];
    if (spans.length === 0) return null;

    const rect = container.getBoundingClientRect();

    // Group words into lines by their vertical position. Words that share a
    // line agree on `top` to within a pixel or two after rounding.
    const tops: number[] = [];
    const raw = spans.map(span => {
      const r = span.getBoundingClientRect();
      const centre = r.top + r.height / 2;
      let line = tops.findIndex(t => Math.abs(t - centre) < r.height * 0.6);
      if (line === -1) {
        tops.push(centre);
        line = tops.length - 1;
      }
      return { span, r, line };
    });

    // Re-order line indices top-to-bottom in case the DOM order surprised us.
    const order = tops.map((t, i) => ({ t, i })).sort((a, b) => a.t - b.t);
    const lineRemap = new Map(order.map((o, newIndex) => [o.i, newIndex]));

    const words: WordBox[] = raw.map(({ span, r, line }) => ({
      index: Number(span.dataset.word),
      line: lineRemap.get(line) ?? line,
      text: span.textContent ?? '',
      left: r.left,
      top: r.top,
      right: r.right,
      bottom: r.bottom,
    }));

    const lineHeight = raw.length > 0 ? raw[0].r.height : 24;
    return { words, lineHeight, rect };
  }, []);

  const startReading = () => {
    samplesRef.current = [];
    setAnswers([]);
    setAnalysis(null);
    setStage('reading');
    soundEngine.playChime(520, 0.15);
    // Recording starts a beat after the text paints, so the first saccade onto
    // the passage is not counted as a reading fixation.
    window.setTimeout(() => {
      startTimeRef.current = Date.now();
      recordingRef.current = true;
    }, 350);
  };

  const finishReading = () => {
    recordingRef.current = false;
    const durationSec = (Date.now() - startTimeRef.current) / 1000;
    const measured = measureWords();

    if (measured) {
      setSession({
        passage,
        samples: [...samplesRef.current],
        words: measured.words,
        lineHeight: measured.lineHeight,
        containerRect: {
          left: measured.rect.left,
          top: measured.rect.top,
          width: measured.rect.width,
          height: measured.rect.height,
        },
        durationSec,
      });
    }

    setStage('questions');
    soundEngine.playChime(600, 0.15);
  };

  const submitAnswers = (finalAnswers: number[]) => {
    if (!session) return;

    const correct = finalAnswers.reduce(
      (count, answer, i) => count + (answer === passage.questions[i].correctIndex ? 1 : 0),
      0
    );
    const comprehensionPercent = (correct / passage.questions.length) * 100;

    setAnalysis(
      analyseReading({
        samples: session.samples,
        words: session.words,
        lineHeight: session.lineHeight,
        wordCount: wordCountOf(passage),
        durationSec: session.durationSec,
        comprehensionPercent,
      })
    );
    setStage('report');
    soundEngine.playLevelComplete();
  };

  const words = useMemo(() => passage.text.trim().split(/\s+/), [passage]);

  return (
    <div className="absolute inset-0 overflow-auto">
      {stage === 'choose' && (
        <ChooseStage passage={passage} onChoose={setPassage} onStart={startReading} />
      )}

      {stage === 'reading' && (
        <div className="min-h-full flex flex-col items-center justify-center px-6 py-12 gap-8">
          <p className="text-sm text-ink-faint">Read at your normal pace. Press the button when you reach the end.</p>
          <p
            ref={textRef}
            className="font-reading text-[21px] leading-[2.1] text-ink"
            style={{ width: TEXT_WIDTH, maxWidth: '100%' }}
          >
            {words.map((word, i) => (
              <span key={i} data-word={i}>
                {word}
                {i < words.length - 1 ? ' ' : ''}
              </span>
            ))}
          </p>
          <button
            onClick={finishReading}
            className="px-6 py-3 rounded-xl bg-sage-500 hover:bg-sage-600 text-white font-medium transition-colors"
          >
            I’ve finished reading
          </button>
        </div>
      )}

      {stage === 'questions' && (
        <QuestionsStage passage={passage} answers={answers} onAnswers={setAnswers} onSubmit={submitAnswers} />
      )}

      {stage === 'report' && analysis && session && (
        <ReportStage
          analysis={analysis}
          session={session}
          onRestart={() => {
            setStage('choose');
            setAnalysis(null);
            setSession(null);
          }}
        />
      )}
    </div>
  );
};

// --------------------------------------------------------------------------

const ChooseStage: React.FC<{
  passage: ReadingPassage;
  onChoose: (p: ReadingPassage) => void;
  onStart: () => void;
}> = ({ passage, onChoose, onStart }) => {
  const validation = calibrationEngine.getValidation();
  const accuracyWarning = !validation || !Number.isFinite(validation.accuracyDeg) || validation.accuracyDeg > 2;

  return (
    <div className="max-w-2xl mx-auto px-6 py-12 space-y-7">
      <div className="flex items-start gap-4">
        <span className="w-11 h-11 rounded-2xl bg-sage-100 text-sage-600 flex items-center justify-center shrink-0">
          <BookOpen className="w-5 h-5" />
        </span>
        <div>
          <h2 className="text-2xl font-semibold text-ink">Reading assessment</h2>
          <p className="text-sm text-ink-soft mt-1.5 leading-relaxed">
            Read a short passage while the tracker records where your eyes stop and how often they go
            back. Afterwards you get a profile of fixations, regressions, span of recognition and
            reading rate, each set against developmental norms.
          </p>
        </div>
      </div>

      {accuracyWarning && (
        <div className="rounded-2xl border border-honey-300 bg-honey-100 px-4 py-3">
          <p className="text-sm text-honey-700 leading-relaxed">
            {validation && Number.isFinite(validation.accuracyDeg)
              ? `Current accuracy is about ${validation.accuracyDeg.toFixed(1)}°, which is wider than a word on this screen. `
              : 'Eye tracking has not been checked yet. '}
            Reading measures depend on knowing which word was fixated, so run set-up first if you want
            numbers you can put in a file.
          </p>
        </div>
      )}

      <div className="space-y-2">
        <p className="text-sm font-medium text-ink">Choose a passage</p>
        {READING_PASSAGES.map(p => (
          <button
            key={p.id}
            onClick={() => onChoose(p)}
            className={`w-full text-left px-4 py-3.5 rounded-xl border transition-colors ${
              passage.id === p.id ? 'border-sage-400 bg-sage-50' : 'border-soft hover:border-strong'
            }`}
          >
            <span className="flex items-baseline justify-between gap-3">
              <span className="text-sm font-medium text-ink">{p.title}</span>
              <span className="text-xs text-ink-faint shrink-0">
                {p.levelLabel} · {wordCountOf(p)} words
              </span>
            </span>
            <span className="block text-xs text-ink-soft mt-1 line-clamp-2 leading-relaxed">
              {p.text.slice(0, 120)}…
            </span>
          </button>
        ))}
      </div>

      <button
        onClick={onStart}
        className="w-full py-3.5 rounded-xl bg-sage-500 hover:bg-sage-600 text-white font-medium flex items-center justify-center gap-2 transition-colors"
      >
        <Play className="w-4 h-4" />
        Begin
      </button>
    </div>
  );
};

// --------------------------------------------------------------------------

const QuestionsStage: React.FC<{
  passage: ReadingPassage;
  answers: number[];
  onAnswers: (a: number[]) => void;
  onSubmit: (a: number[]) => void;
}> = ({ passage, answers, onAnswers, onSubmit }) => {
  const allAnswered = passage.questions.every((_, i) => answers[i] !== undefined);

  return (
    <div className="max-w-2xl mx-auto px-6 py-12 space-y-7">
      <div>
        <h2 className="text-xl font-semibold text-ink">A few questions</h2>
        <p className="text-sm text-ink-soft mt-1.5 leading-relaxed">
          Reading speed only means something alongside comprehension, so these answers are folded into
          the reading rate rather than scored separately.
        </p>
      </div>

      {passage.questions.map((q, qi) => (
        <div key={qi} className="space-y-2">
          <p className="text-sm font-medium text-ink">{q.prompt}</p>
          <div className="space-y-2">
            {q.options.map((option, oi) => (
              <button
                key={oi}
                onClick={() => {
                  const next = [...answers];
                  next[qi] = oi;
                  onAnswers(next);
                }}
                className={`w-full text-left px-4 py-3 rounded-xl border text-sm transition-colors ${
                  answers[qi] === oi
                    ? 'border-sage-400 bg-sage-50 text-ink'
                    : 'border-soft text-ink-soft hover:border-strong'
                }`}
              >
                {option}
              </button>
            ))}
          </div>
        </div>
      ))}

      <button
        disabled={!allAnswered}
        onClick={() => onSubmit(answers)}
        className="w-full py-3.5 rounded-xl bg-sage-500 hover:bg-sage-600 disabled:bg-[var(--border-strong)] disabled:cursor-not-allowed text-white font-medium transition-colors"
      >
        See the results
      </button>
    </div>
  );
};

// --------------------------------------------------------------------------

const ReportStage: React.FC<{
  analysis: ReadingAnalysis;
  session: RecordedSession;
  onRestart: () => void;
}> = ({ analysis, session, onRestart }) => {
  const overall = analysis.gradeEquivalents.overall;
  const norm = overall !== null ? normForGrade(overall) : normForGrade(8);
  const notes = interpretReading(analysis);
  const validation = calibrationEngine.getValidation();

  const rows: Array<{ label: string; value: string; normValue: string; grade: number | null; hint: string }> = [
    {
      label: 'Fixations per 100 words',
      value: analysis.fixationsPer100Words.toFixed(0),
      normValue: norm.fixationsPer100Words.toFixed(0),
      grade: analysis.gradeEquivalents.fixations,
      hint: 'How many separate stops the eyes made. Fewer stops means more is taken in at once.',
    },
    {
      label: 'Regressions per 100 words',
      value: analysis.regressionsPer100Words.toFixed(0),
      normValue: norm.regressionsPer100Words.toFixed(0),
      grade: analysis.gradeEquivalents.regressions,
      hint: 'Backward movements to re-read. Some are normal; a lot suggests effort or losing place.',
    },
    {
      label: 'Span of recognition',
      value: `${analysis.spanOfRecognition.toFixed(2)} words`,
      normValue: `${norm.spanOfRecognition.toFixed(2)} words`,
      grade: analysis.gradeEquivalents.span,
      hint: 'Words taken in per stop. This is usually the most productive thing to widen.',
    },
    {
      label: 'Average fixation',
      value: `${(analysis.averageFixationDurationSec * 1000).toFixed(0)} ms`,
      normValue: `${(norm.averageFixationDuration * 1000).toFixed(0)} ms`,
      grade: analysis.gradeEquivalents.duration,
      hint: 'How long each stop lasted. Long stops usually mean processing time rather than eye control.',
    },
    {
      label: 'Reading rate with comprehension',
      value: `${analysis.readingRateWithComprehensionWpm.toFixed(0)} wpm`,
      normValue: `${norm.readingRate} wpm`,
      grade: analysis.gradeEquivalents.rate,
      hint: `Raw rate was ${analysis.readingRateWpm.toFixed(0)} wpm at ${analysis.comprehensionPercent.toFixed(0)}% comprehension.`,
    },
  ];

  const download = () => {
    const payload = {
      recordedAt: new Date().toISOString(),
      passage: { id: session.passage.id, title: session.passage.title, level: session.passage.level },
      metrics: {
        fixationsPer100Words: analysis.fixationsPer100Words,
        regressionsPer100Words: analysis.regressionsPer100Words,
        spanOfRecognition: analysis.spanOfRecognition,
        averageFixationDurationSec: analysis.averageFixationDurationSec,
        readingRateWpm: analysis.readingRateWpm,
        readingRateWithComprehensionWpm: analysis.readingRateWithComprehensionWpm,
        comprehensionPercent: analysis.comprehensionPercent,
        directionalAttackPercent: analysis.directionalAttackPercent,
        wordCoveragePercent: analysis.wordCoveragePercent,
        headMovementDegPerSec: analysis.headMovementDegPerSec,
      },
      gradeEquivalents: analysis.gradeEquivalents,
      dataQuality: {
        trackingRatio: analysis.trackingRatio,
        calibrationAccuracyDeg: validation?.accuracyDeg ?? null,
        calibrationPrecisionDeg: validation?.precisionDeg ?? null,
      },
      normsReference: 'Taylor developmental norms (EDL, 1960); see readingNorms.ts for caveats.',
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `reading-assessment-${session.passage.id}-${Date.now()}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  if (analysis.onTextFixations === 0) {
    return (
      <div className="max-w-2xl mx-auto px-6 py-12 space-y-5">
        <h2 className="text-2xl font-semibold text-ink">Nothing was recorded on the text</h2>
        <p className="text-sm text-ink-soft leading-relaxed">
          The tracker did not register a single fixation landing on a word. That means either the eyes
          were not being tracked during the passage, or the mapping is far enough out that the gaze
          never landed where the words are — a table of zeros would not tell you which.
        </p>
        <p className="text-sm text-ink-soft leading-relaxed">
          {validation && Number.isFinite(validation.accuracyDeg)
            ? `Accuracy was last measured at ${validation.accuracyDeg.toFixed(1)}°. `
            : 'Eye tracking has not been checked. '}
          Run set-up, confirm the marker lands where you are looking, then try the passage again.
        </p>
        <button
          onClick={onRestart}
          className="px-5 py-3 rounded-xl bg-sage-500 hover:bg-sage-600 text-white font-medium transition-colors"
        >
          Back to passages
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-6 py-10 space-y-7">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-2xl font-semibold text-ink">Reading profile</h2>
          <p className="text-sm text-ink-soft mt-1">
            {session.passage.title} · {analysis.wordCount} words · {analysis.durationSec.toFixed(0)} seconds
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={download}
            className="px-4 py-2.5 rounded-xl border border-strong text-ink text-sm font-medium flex items-center gap-2 hover:bg-[var(--surface-sunken)] transition-colors"
          >
            <Download className="w-4 h-4" />
            Save results
          </button>
          <button
            onClick={onRestart}
            className="px-4 py-2.5 rounded-xl border border-strong text-ink text-sm font-medium flex items-center gap-2 hover:bg-[var(--surface-sunken)] transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            New passage
          </button>
        </div>
      </div>

      {analysis.trackingRatio < 0.7 && (
        <div className="rounded-2xl border border-clay-300 bg-clay-100 px-4 py-3">
          <p className="text-sm text-clay-500 leading-relaxed">
            The eyes were only tracked for {Math.round(analysis.trackingRatio * 100)}% of this passage.
            The pattern below is probably incomplete — worth repeating before recording it anywhere.
          </p>
        </div>
      )}

      <div className="surface rounded-2xl px-6 py-5">
        <p className="text-sm text-ink-soft">Overall grade equivalent</p>
        <p className="text-3xl font-semibold text-ink mt-1">{describeGrade(overall)}</p>
        <p className="text-xs text-ink-soft mt-2 leading-relaxed">
          Averaged across fixations, regressions, span and rate. The individual measures below often
          disagree with each other, and where they do, the disagreement is usually the interesting part.
        </p>
      </div>

      <div className="surface rounded-2xl overflow-hidden">
        {rows.map((row, i) => (
          <div key={row.label} className={`px-6 py-4 ${i > 0 ? 'border-t border-soft' : ''}`}>
            <div className="flex items-baseline justify-between gap-4 flex-wrap">
              <span className="text-sm font-medium text-ink">{row.label}</span>
              <span className="flex items-baseline gap-3">
                <span className="text-lg font-semibold text-ink tabular-nums">{row.value}</span>
                <span className="text-xs text-ink-faint">expected {row.normValue}</span>
                <span className="text-xs px-2 py-0.5 rounded-full bg-sage-50 text-sage-700 whitespace-nowrap">
                  {describeGrade(row.grade)}
                </span>
              </span>
            </div>
            <p className="text-xs text-ink-soft mt-1.5 leading-relaxed">{row.hint}</p>
          </div>
        ))}
      </div>

      <Scanpath analysis={analysis} session={session} />

      <div className="surface rounded-2xl px-6 py-5 space-y-3">
        <h3 className="text-sm font-semibold text-ink">What stands out</h3>
        {notes.map((note, i) => (
          <p key={i} className="text-sm text-ink-soft leading-relaxed">
            {note}
          </p>
        ))}
      </div>

      <div className="grid sm:grid-cols-3 gap-3">
        <SmallStat label="Forward movement" value={`${analysis.directionalAttackPercent.toFixed(0)}%`} />
        <SmallStat label="Words fixated" value={`${analysis.wordCoveragePercent.toFixed(0)}%`} />
        <SmallStat label="Head movement" value={`${analysis.headMovementDegPerSec.toFixed(1)}°/s`} />
      </div>

      <p className="text-xs text-ink-faint leading-relaxed">
        Norms are the Taylor developmental norms (Educational Developmental Laboratories, 1960), the
        same reference set used by established reading-eye-movement instruments. Those were collected
        with infrared instruments on printed text; a webcam reading a screen is a different
        measurement and agreement has not been established. Use these figures to track change within a
        client over time, and check them against your service’s own reference before they go in a report.
      </p>
    </div>
  );
};

const SmallStat: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="surface rounded-2xl px-4 py-3">
    <p className="text-xs text-ink-faint">{label}</p>
    <p className="text-lg font-semibold text-ink mt-0.5 tabular-nums">{value}</p>
  </div>
);

// --------------------------------------------------------------------------

/**
 * Draws the recorded scanpath over a re-render of the passage. The reading view
 * uses a fixed text width so the line breaks here are identical, which is what
 * lets the fixations line up with the words they landed on.
 */
const Scanpath: React.FC<{ analysis: ReadingAnalysis; session: RecordedSession }> = ({ analysis, session }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [showAll, setShowAll] = useState(false);

  const words = useMemo(() => session.passage.text.trim().split(/\s+/), [session.passage]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = wrap.clientWidth;
    const height = wrap.clientHeight;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const scale = width / session.containerRect.width;
    const toLocal = (f: Fixation) => ({
      x: (f.x - session.containerRect.left) * scale,
      y: (f.y - session.containerRect.top) * scale,
    });

    const visible = analysis.fixations.filter(f => showAll || f.wordIndex !== null);

    // Connecting lines first, so the fixation markers sit on top of them.
    ctx.lineWidth = 1;
    for (let i = 1; i < visible.length; i++) {
      const a = toLocal(visible[i - 1]);
      const b = toLocal(visible[i]);
      ctx.strokeStyle = visible[i].isRegression ? 'rgba(204, 143, 110, 0.55)' : 'rgba(122, 138, 133, 0.35)';
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    visible.forEach(f => {
      const { x, y } = toLocal(f);
      // Radius carries duration, so long stops are visible at a glance.
      const radius = Math.max(4, Math.min(18, Math.sqrt(f.durationMs) * 0.55));
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fillStyle = f.isRegression ? 'rgba(204, 143, 110, 0.3)' : 'rgba(78, 135, 121, 0.24)';
      ctx.fill();
      ctx.strokeStyle = f.isRegression ? 'rgba(181, 113, 79, 0.85)' : 'rgba(63, 109, 98, 0.7)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });
  }, [analysis, session, showAll, words]);

  return (
    <div className="surface rounded-2xl p-6">
      <div className="flex items-baseline justify-between mb-4 gap-3 flex-wrap">
        <h3 className="text-sm font-semibold text-ink">Where the eyes went</h3>
        <label className="text-xs text-ink-soft flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={showAll}
            onChange={e => setShowAll(e.target.checked)}
            className="accent-[var(--color-sage-500)]"
          />
          Include fixations off the text
        </label>
      </div>

      <div ref={wrapRef} className="relative overflow-x-auto">
        <p
          className="font-reading text-[21px] leading-[2.1] text-ink-faint select-none"
          style={{ width: TEXT_WIDTH, maxWidth: '100%' }}
        >
          {words.map((word, i) => (
            <span key={i}>
              {word}
              {i < words.length - 1 ? ' ' : ''}
            </span>
          ))}
        </p>
        <canvas ref={canvasRef} className="absolute inset-0 pointer-events-none" />
      </div>

      <div className="flex items-center gap-5 mt-4 text-xs text-ink-soft flex-wrap">
        <span className="flex items-center gap-2">
          <span className="w-3 h-3 rounded-full bg-sage-300/60 border border-sage-600" /> Forward fixation
        </span>
        <span className="flex items-center gap-2">
          <span className="w-3 h-3 rounded-full bg-clay-300/60 border border-clay-500" /> Regression
        </span>
        <span className="flex items-center gap-2">
          <Check className="w-3.5 h-3.5" /> Circle size shows how long the eye stayed
        </span>
      </div>
    </div>
  );
};
