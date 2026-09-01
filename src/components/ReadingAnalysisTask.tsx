import React, { useState, useEffect, useRef } from 'react';
import { Play, Square, CheckCircle2, XCircle, BrainCircuit, Activity, Eye, Move } from 'lucide-react';
import { GazeState } from '../types';
import { soundEngine } from '../services/audio';

interface ReadingAnalysisTaskProps {
  gaze: GazeState | null;
}

const READING_TEXT = `The quick brown fox jumps over the lazy dog. This pangram contains every letter of the English alphabet at least once. It is often used to test typewriters and computer keyboards. Eye tracking during reading can reveal fascinating insights into cognitive processing. As you read these words, your eyes do not move smoothly across the line. Instead, they make short, rapid movements called saccades, interspersed with brief stops known as fixations. Sometimes, your eyes even move backwards to reread previous text, which are called regressions. Analyzing these patterns helps diagnose reading difficulties and optimize visual learning strategies.`;

const WORD_COUNT = READING_TEXT.split(' ').length; // ~93 words

export const ReadingAnalysisTask: React.FC<ReadingAnalysisTaskProps> = ({ gaze }) => {
  const [sessionState, setSessionState] = useState<'idle' | 'reading' | 'quiz' | 'results'>('idle');
  
  // Metrics
  const [fixations, setFixations] = useState(0);
  const [regressions, setRegressions] = useState(0);
  const [wpm, setWpm] = useState(0);
  const [headMovementDegPerSec, setHeadMovementDegPerSec] = useState(0);
  const [comprehensionScore, setComprehensionScore] = useState(0);

  // Tracking Refs
  const startTimeRef = useRef(0);
  const lastGazeRef = useRef<{ x: number, y: number, time: number } | null>(null);
  const lastFixationTimeRef = useRef(0);
  const lastRegressionTimeRef = useRef(0);
  const headPosesRef = useRef<Array<{ yaw: number, pitch: number, roll: number, time: number }>>([]);
  const textContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (sessionState !== 'reading' || !gaze) return;

    const now = Date.now();
    const { screenX, screenY, isFixating, headPose } = gaze;

    // Track Head Movement
    headPosesRef.current.push({ ...headPose, time: now });
    if (headPosesRef.current.length > 300) { // Keep last few seconds to prevent memory leak, but for a short test it's fine.
      // We will calculate the total degrees per second at the end
    }

    if (!lastGazeRef.current) {
      lastGazeRef.current = { x: screenX, y: screenY, time: now };
      return;
    }

    const prev = lastGazeRef.current;
    const dx = screenX - prev.x;
    const dy = screenY - prev.y;

    // Detect Fixations
    if (isFixating && (now - lastFixationTimeRef.current > 250)) {
      setFixations(f => f + 1);
      lastFixationTimeRef.current = now;
      soundEngine.playGridSnapTick(); // subtle auditory feedback (optional)
    }

    // Detect Regressions (moving significantly leftwards while reading left-to-right)
    if (dx < -60 && Math.abs(dy) < 40 && (now - lastRegressionTimeRef.current > 300)) {
      // Check if we are inside the text container roughly to avoid counting off-screen looks
      if (textContainerRef.current) {
        const rect = textContainerRef.current.getBoundingClientRect();
        if (screenX >= rect.left && screenX <= rect.right && screenY >= rect.top && screenY <= rect.bottom) {
          setRegressions(r => r + 1);
          lastRegressionTimeRef.current = now;
        }
      }
    }

    lastGazeRef.current = { x: screenX, y: screenY, time: now };

  }, [gaze, sessionState]);

  const startReading = () => {
    setFixations(0);
    setRegressions(0);
    setWpm(0);
    setHeadMovementDegPerSec(0);
    headPosesRef.current = [];
    lastGazeRef.current = null;
    lastFixationTimeRef.current = 0;
    lastRegressionTimeRef.current = 0;
    startTimeRef.current = Date.now();
    setSessionState('reading');
    soundEngine.playChime(500, 0.2);
  };

  const finishReading = () => {
    const durationMin = (Date.now() - startTimeRef.current) / 60000;
    const calculatedWpm = Math.round(WORD_COUNT / durationMin);
    setWpm(calculatedWpm);

    // Calculate Head Movement (Degrees per second)
    // HeadPose values from mediapipe are roughly in radians.
    let totalHeadDeltaRads = 0;
    for (let i = 1; i < headPosesRef.current.length; i++) {
      const p1 = headPosesRef.current[i - 1];
      const p2 = headPosesRef.current[i];
      const dYaw = p2.yaw - p1.yaw;
      const dPitch = p2.pitch - p1.pitch;
      const dRoll = p2.roll - p1.roll;
      totalHeadDeltaRads += Math.sqrt(dYaw*dYaw + dPitch*dPitch + dRoll*dRoll);
    }
    const durationSec = (Date.now() - startTimeRef.current) / 1000;
    const degPerSec = durationSec > 0 ? (totalHeadDeltaRads * (180 / Math.PI)) / durationSec : 0;
    setHeadMovementDegPerSec(Number(degPerSec.toFixed(2)));

    setSessionState('quiz');
    soundEngine.playLevelComplete();
  };

  const submitQuiz = (correct: boolean) => {
    setComprehensionScore(correct ? 100 : 0);
    setSessionState('results');
    soundEngine.playChime(correct ? 600 : 300, 0.3);
  };

  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center p-8 bg-[#0a0a0a]">
      {sessionState === 'idle' && (
        <div className="max-w-xl text-center space-y-6">
          <div className="w-16 h-16 rounded-2xl bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center mx-auto text-cyan-400">
            <BrainCircuit className="w-8 h-8" />
          </div>
          <h2 className="text-3xl font-light text-white font-serif-chic">Reading Analyzer</h2>
          <p className="text-sm text-white/50 leading-relaxed font-mono">
            Track visual behavior, saccades, fixations, regressions, and head movement while reading. 
            Modeled after clinical eye-tracking reading assessments.
          </p>
          <button
            onClick={startReading}
            className="px-6 py-3 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-black font-bold flex items-center justify-center gap-2 mx-auto transition-colors"
          >
            <Play className="w-5 h-5" />
            <span>Start Reading Test</span>
          </button>
        </div>
      )}

      {sessionState === 'reading' && (
        <div className="max-w-3xl w-full flex flex-col items-center gap-8">
          <div className="flex justify-between w-full text-xs font-mono text-white/40 uppercase tracking-widest px-4 border-b border-white/10 pb-4">
            <span className="flex items-center gap-2"><Eye className="w-4 h-4 text-emerald-400" /> Tracking Active</span>
            <span className="animate-pulse text-emerald-400">Recording Data...</span>
          </div>
          
          <div 
            ref={textContainerRef}
            className="bg-[#111] border border-white/5 rounded-2xl p-8 shadow-2xl relative"
          >
            <p className="text-2xl text-white/90 font-serif leading-loose tracking-wide text-justify">
              {READING_TEXT}
            </p>
          </div>

          <button
            onClick={finishReading}
            className="px-8 py-3 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-black font-bold flex items-center justify-center gap-2 transition-colors shadow-[0_0_20px_rgba(16,185,129,0.3)]"
          >
            <CheckCircle2 className="w-5 h-5" />
            <span>I have finished reading</span>
          </button>
        </div>
      )}

      {sessionState === 'quiz' && (
        <div className="max-w-xl text-center space-y-8 bg-[#111] p-10 rounded-3xl border border-white/10">
          <h3 className="text-xl font-medium text-white">Comprehension Check</h3>
          <p className="text-lg text-white/70">What are the short, rapid movements made by eyes during reading called?</p>
          <div className="flex flex-col gap-3">
            <button onClick={() => submitQuiz(false)} className="p-4 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 transition-colors text-white">
              Regressions
            </button>
            <button onClick={() => submitQuiz(true)} className="p-4 rounded-xl border border-white/10 bg-white/5 hover:bg-emerald-500/20 hover:border-emerald-500/50 transition-colors text-white">
              Saccades
            </button>
            <button onClick={() => submitQuiz(false)} className="p-4 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 transition-colors text-white">
              Fixations
            </button>
          </div>
        </div>
      )}

      {sessionState === 'results' && (
        <div className="max-w-4xl w-full space-y-8 animate-in slide-in-from-bottom-8 fade-in duration-500">
          <div className="text-center space-y-2">
            <h2 className="text-3xl font-light text-white font-serif-chic">Reading Profile Results</h2>
            <p className="text-sm text-white/40 font-mono">Clinical Eye Tracking Telemetry</p>
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-[#111] p-6 rounded-2xl border border-white/10 flex flex-col gap-2">
              <div className="flex items-center gap-2 text-cyan-400 text-xs font-mono uppercase">
                <Activity className="w-4 h-4" /> Reading Speed
              </div>
              <div className="text-4xl font-light text-white">{wpm} <span className="text-lg text-white/30">WPM</span></div>
            </div>
            
            <div className="bg-[#111] p-6 rounded-2xl border border-white/10 flex flex-col gap-2">
              <div className="flex items-center gap-2 text-emerald-400 text-xs font-mono uppercase">
                <Eye className="w-4 h-4" /> Fixations
              </div>
              <div className="text-4xl font-light text-white">{fixations}</div>
              <div className="text-[10px] text-white/40 font-mono">Stops made while reading</div>
            </div>

            <div className="bg-[#111] p-6 rounded-2xl border border-white/10 flex flex-col gap-2">
              <div className="flex items-center gap-2 text-amber-400 text-xs font-mono uppercase">
                <Square className="w-4 h-4" /> Regressions
              </div>
              <div className="text-4xl font-light text-white">{regressions}</div>
              <div className="text-[10px] text-white/40 font-mono">Backward eye movements</div>
            </div>

            <div className="bg-[#111] p-6 rounded-2xl border border-white/10 flex flex-col gap-2">
              <div className="flex items-center gap-2 text-purple-400 text-xs font-mono uppercase">
                <Move className="w-4 h-4" /> Head Movement
              </div>
              <div className="text-4xl font-light text-white">{headMovementDegPerSec} <span className="text-lg text-white/30">°/s</span></div>
            </div>
          </div>

          <div className="bg-[#111] p-6 rounded-2xl border border-white/10 flex items-center justify-between">
            <div className="space-y-1">
              <div className="text-white text-lg">Comprehension</div>
              <div className="text-white/50 text-sm">Post-reading quiz score</div>
            </div>
            <div className={`text-3xl font-bold ${comprehensionScore === 100 ? 'text-emerald-400' : 'text-red-400'}`}>
              {comprehensionScore}%
            </div>
          </div>

          <div className="flex justify-center pt-4">
            <button
              onClick={() => setSessionState('idle')}
              className="px-6 py-3 rounded-xl border border-white/10 text-white hover:bg-white/5 transition-colors font-mono text-sm"
            >
              Start New Assessment
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
