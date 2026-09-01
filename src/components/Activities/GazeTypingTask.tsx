import React, { useState, useEffect, useRef } from 'react';
import { MessageSquare, Volume2, Trash2, Delete, Check, Sparkles } from 'lucide-react';
import { GazeState } from '../../types';
import { soundEngine } from '../../services/audio';

interface GazeTypingTaskProps {
  gaze: GazeState | null;
}

const QUICK_PHRASES = [
  'Yes',
  'No',
  'Thank you',
  'Water, please',
  'Need help',
  'I am doing great',
  'More time',
  'Hello there',
];

const KEYBOARD_ROWS = [
  ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'],
  ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'],
  ['Z', 'X', 'C', 'V', 'B', 'N', 'M', 'SPACE', 'BACKSPACE'],
];

export const GazeTypingTask: React.FC<GazeTypingTaskProps> = ({ gaze }) => {
  const [typedText, setTypedText] = useState('');
  const [activeDwellKey, setActiveDwellKey] = useState<string | null>(null);
  const [dwellProgress, setDwellProgress] = useState(0); // 0 to 1
  const keyRefs = useRef<{ [key: string]: HTMLButtonElement | null }>({});

  const speakText = (text: string) => {
    if (!text || typeof window === 'undefined') return;
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1.0;
      utterance.pitch = 1.0;
      window.speechSynthesis.speak(utterance);
      soundEngine.playChime(600, 0.2);
    }
  };

  // Check gaze collision on buttons
  useEffect(() => {
    if (!gaze) {
      setActiveDwellKey(null);
      setDwellProgress(0);
      return;
    }

    const gx = gaze.screenX;
    const gy = gaze.screenY;

    let hoveredKey: string | null = null;
    let minDistance = Infinity;

    // 1. Direct hit check
    for (const [key, element] of Object.entries(keyRefs.current) as [string, HTMLButtonElement | null][]) {
      if (element) {
        const rect = element.getBoundingClientRect();
        if (gx >= rect.left && gx <= rect.right && gy >= rect.top && gy <= rect.bottom) {
          hoveredKey = key;
          break;
        } else {
          // Calculate distance to key center
          const kcx = (rect.left + rect.right) / 2;
          const kcy = (rect.top + rect.bottom) / 2;
          const dist = Math.hypot(gx - kcx, gy - kcy);
          if (dist < 55 && dist < minDistance) {
            minDistance = dist;
            hoveredKey = key;
          }
        }
      }
    }

    if (hoveredKey) {
      if (hoveredKey === activeDwellKey) {
        setDwellProgress(prev => {
          const next = prev + 0.09; // ~500-600ms dwell time
          if (next >= 1) {
            handleKeyAction(hoveredKey!);
            return 0;
          }
          return next;
        });
      } else {
        setActiveDwellKey(hoveredKey);
        setDwellProgress(0.05);
      }
    } else {
      setActiveDwellKey(null);
      setDwellProgress(0);
    }
  }, [gaze, activeDwellKey]);

  const handleKeyAction = (key: string) => {
    soundEngine.playChime(520, 0.15);

    if (key === 'SPACE') {
      setTypedText(t => t + ' ');
    } else if (key === 'BACKSPACE') {
      setTypedText(t => t.slice(0, -1));
    } else if (key.startsWith('phrase:')) {
      const phrase = key.replace('phrase:', '');
      setTypedText(phrase);
      speakText(phrase);
    } else {
      setTypedText(t => t + key);
    }
  };

  return (
    <div id="gaze-typing-view" className="relative w-full h-full flex flex-col bg-slate-950 p-6 select-none overflow-y-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2.5">
          <div className="w-10 h-10 rounded-2xl bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center text-cyan-400">
            <MessageSquare className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-base font-bold font-['Outfit'] text-white">
              Gaze Communicator
            </h3>
            <p className="text-xs text-slate-400">
              Rest your gaze on any letter or phrase for 0.6s to select
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            id="speak-text-btn"
            onClick={() => speakText(typedText)}
            disabled={!typedText}
            className="px-4 py-2 rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 disabled:opacity-40 text-white text-xs font-semibold flex items-center gap-2 shadow-lg shadow-cyan-500/20 transition-all cursor-pointer"
          >
            <Volume2 className="w-4 h-4" />
            <span>Speak Out Loud</span>
          </button>
          <button
            id="clear-typed-text-btn"
            onClick={() => setTypedText('')}
            className="p-2 rounded-xl border border-slate-800 bg-slate-900 text-slate-400 hover:text-white transition-colors cursor-pointer"
            title="Clear Text"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Live Text Output Display */}
      <div className="w-full min-h-[72px] bg-slate-900/90 border border-slate-800/90 rounded-2xl p-4 mb-4 flex items-center justify-between text-lg font-medium text-white shadow-inner">
        <div className="tracking-wide">
          {typedText || (
            <span className="text-slate-500 italic text-sm">
              Your gaze-composed sentence will appear here...
            </span>
          )}
        </div>
        {typedText && (
          <span className="w-2 h-5 bg-cyan-400 animate-pulse rounded-full ml-2 inline-block" />
        )}
      </div>

      {/* Quick Phrases Section */}
      <div className="mb-4">
        <div className="text-xs font-semibold text-slate-400 mb-2 uppercase tracking-wider">
          Quick Essential Phrases
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
          {QUICK_PHRASES.map(phrase => {
            const keyId = `phrase:${phrase}`;
            const isHovered = activeDwellKey === keyId;

            return (
              <button
                key={phrase}
                ref={el => { keyRefs.current[keyId] = el; }}
                onClick={() => {
                  setTypedText(phrase);
                  speakText(phrase);
                }}
                className={`relative px-4 py-3 rounded-2xl border text-xs font-semibold text-left transition-all duration-150 overflow-hidden cursor-pointer ${
                  isHovered
                    ? 'border-cyan-400 bg-cyan-500/20 text-cyan-200 scale-105 shadow-[0_0_15px_rgba(6,182,212,0.3)]'
                    : 'border-slate-800 bg-slate-900/80 text-slate-300 hover:border-slate-700'
                }`}
              >
                {/* Dwell Fill Bar */}
                {isHovered && (
                  <div
                    className="absolute inset-0 bg-cyan-500/30 -z-10 transition-all duration-75"
                    style={{ width: `${dwellProgress * 100}%` }}
                  />
                )}
                <span>{phrase}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Gaze Keyboard Matrix */}
      <div className="space-y-2 max-w-3xl mx-auto w-full">
        {KEYBOARD_ROWS.map((row, rIdx) => (
          <div key={rIdx} className="flex gap-2 justify-center">
            {row.map(char => {
              const isHovered = activeDwellKey === char;
              const isSpecial = char === 'SPACE' || char === 'BACKSPACE';

              return (
                <button
                  key={char}
                  ref={el => { keyRefs.current[char] = el; }}
                  onClick={() => handleKeyAction(char)}
                  className={`relative py-3.5 px-3 rounded-xl border text-sm font-semibold transition-all duration-150 overflow-hidden cursor-pointer flex items-center justify-center ${
                    isSpecial ? 'flex-1 max-w-[140px] text-xs' : 'w-12 h-14'
                  } ${
                    isHovered
                      ? 'border-cyan-400 bg-cyan-500/25 text-white scale-110 shadow-[0_0_15px_rgba(6,182,212,0.35)]'
                      : 'border-slate-800 bg-slate-900/80 text-slate-300 hover:border-slate-700'
                  }`}
                >
                  {isHovered && (
                    <div
                      className="absolute inset-0 bg-cyan-500/40 -z-10 transition-all duration-75"
                      style={{ width: `${dwellProgress * 100}%` }}
                    />
                  )}
                  {char === 'BACKSPACE' ? <Delete className="w-4 h-4" /> : char}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
};
