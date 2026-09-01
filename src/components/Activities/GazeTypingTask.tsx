import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CornerUpLeft, Delete, Trash2, Volume2 } from 'lucide-react';
import { soundEngine } from '../../services/audio';
import { DwellTarget, useGazeDwell } from '../../hooks/useGazeDwell';

interface GazeTypingTaskProps {
  dwellDurationMs: number;
}

/**
 * Two-stage letter selection.
 *
 * A full keyboard laid out as thirty small keys is not usable by eye gaze: at a
 * realistic webcam accuracy of one to two degrees, a key is smaller than the
 * error, so selections land on the wrong letter and the client is blamed for
 * it. Grouping the alphabet into six large tiles and expanding the chosen group
 * into six more keeps every target far larger than the error at both stages.
 * It is the standard approach in eye-gaze communication aids, and it costs one
 * extra selection per letter to gain a usable hit rate.
 */
const GROUPS: string[][] = [
  ['A', 'B', 'C', 'D', 'E'],
  ['F', 'G', 'H', 'I', 'J'],
  ['K', 'L', 'M', 'N', 'O'],
  ['P', 'Q', 'R', 'S', 'T'],
  ['U', 'V', 'W', 'X', 'Y'],
  ['Z', '.', '?', '!', ','],
];

const PHRASES = ['Yes', 'No', 'Thank you', 'Please wait', 'I need help', 'More, please'];

type Tile =
  | { kind: 'group'; id: string; label: string; index: number }
  | { kind: 'letter'; id: string; label: string }
  | { kind: 'action'; id: string; label: string; action: 'space' | 'back' | 'clear' | 'speak' | 'up' }
  | { kind: 'phrase'; id: string; label: string }
  | { kind: 'phrase-menu'; id: string; label: string };

export const GazeTypingTask: React.FC<GazeTypingTaskProps> = ({ dwellDurationMs }) => {
  const [text, setText] = useState('');
  const [openGroup, setOpenGroup] = useState<number | null>(null);
  const [showPhrases, setShowPhrases] = useState(false);
  const tileRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  // Bumped once the tiles have been laid out, and again on resize, so the dwell
  // targets are recomputed from real positions rather than from refs that were
  // still empty on the first render.
  const [layoutTick, setLayoutTick] = useState(0);

  const speak = useCallback((value: string) => {
    if (!value.trim() || !('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(value));
  }, []);

  const tiles: Tile[] = useMemo(() => {
    if (showPhrases) {
      return [
        ...PHRASES.map((p, i) => ({ kind: 'phrase' as const, id: `phrase-${i}`, label: p })),
        { kind: 'action' as const, id: 'up', label: 'Back', action: 'up' as const },
        { kind: 'action' as const, id: 'speak', label: 'Speak', action: 'speak' as const },
      ];
    }
    if (openGroup !== null) {
      return [
        ...GROUPS[openGroup].map(letter => ({ kind: 'letter' as const, id: `letter-${letter}`, label: letter })),
        { kind: 'action' as const, id: 'up', label: 'Back', action: 'up' as const },
        { kind: 'action' as const, id: 'space', label: 'Space', action: 'space' as const },
      ];
    }
    return [
      ...GROUPS.map((group, i) => ({
        kind: 'group' as const,
        id: `group-${i}`,
        label: `${group[0]} – ${group[group.length - 1]}`,
        index: i,
      })),
      { kind: 'action' as const, id: 'space', label: 'Space', action: 'space' as const },
      { kind: 'action' as const, id: 'back', label: 'Delete', action: 'back' as const },
      { kind: 'phrase-menu' as const, id: 'phrases', label: 'Phrases' },
      { kind: 'action' as const, id: 'speak', label: 'Speak', action: 'speak' as const },
      { kind: 'action' as const, id: 'clear', label: 'Clear', action: 'clear' as const },
    ];
  }, [openGroup, showPhrases]);

  // Tile positions are read from the DOM, so the layout stays responsive and
  // the dwell targets always match what is actually on screen.
  useEffect(() => {
    const onResize = () => setLayoutTick(t => t + 1);
    window.addEventListener('resize', onResize);
    // One tick after mount so the refs are populated before targets are read.
    const raf = requestAnimationFrame(() => setLayoutTick(t => t + 1));
    return () => {
      window.removeEventListener('resize', onResize);
      cancelAnimationFrame(raf);
    };
  }, [tiles]);

  const targets: DwellTarget[] = useMemo(() => {
    return tiles
      .map(tile => {
        const el = tileRefs.current[tile.id];
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return {
          id: tile.id,
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          // An inscribed circle keeps neighbouring tiles from overlapping.
          radius: Math.min(rect.width, rect.height) / 2,
        };
      })
      .filter((t): t is DwellTarget => t !== null);
    // Recomputed whenever the tiles change or the window resizes.
  }, [tiles, layoutTick]);

  const handleSelect = useCallback(
    (id: string) => {
      const tile = tiles.find(t => t.id === id);
      if (!tile) return;

      soundEngine.playChime(560, 0.1);

      switch (tile.kind) {
        case 'phrase-menu':
          setShowPhrases(true);
          break;
        case 'group':
          setOpenGroup(tile.index);
          break;
        case 'letter':
          setText(t => t + tile.label);
          setOpenGroup(null);
          break;
        case 'phrase':
          setText(t => (t ? `${t} ${tile.label}` : tile.label));
          setShowPhrases(false);
          break;
        case 'action':
          if (tile.action === 'space') setText(t => `${t} `);
          if (tile.action === 'back') setText(t => t.slice(0, -1));
          if (tile.action === 'clear') setText('');
          if (tile.action === 'up') {
            setOpenGroup(null);
            setShowPhrases(false);
          }
          if (tile.action === 'speak') setText(t => (speak(t), t));
          break;
      }
    },
    [tiles, speak]
  );

  const dwell = useGazeDwell({ targets, dwellMs: dwellDurationMs, assistRadius: 20, onSelect: handleSelect });

  const iconFor = (tile: Tile) => {
    if (tile.kind !== 'action') return null;
    if (tile.action === 'speak') return <Volume2 className="w-5 h-5" />;
    if (tile.action === 'back') return <Delete className="w-5 h-5" />;
    if (tile.action === 'clear') return <Trash2 className="w-5 h-5" />;
    if (tile.action === 'up') return <CornerUpLeft className="w-5 h-5" />;
    return null;
  };

  return (
    <div className="absolute inset-0 flex flex-col p-6 gap-5">
      <div className="surface rounded-2xl px-6 py-5 min-h-[92px] flex items-center">
        <p className="text-2xl text-ink break-words">
          {text || <span className="text-ink-faint">Look at a group of letters to begin…</span>}
        </p>
      </div>

      <div className="flex-1 grid grid-cols-3 sm:grid-cols-4 gap-4 min-h-0">
        {tiles.map(tile => {
          const isActive = dwell.activeId === tile.id;
          const progress = isActive ? dwell.progress : 0;
          return (
            <button
              key={tile.id}
              ref={el => {
                tileRefs.current[tile.id] = el;
              }}
              onClick={() => handleSelect(tile.id)}
              className={`relative rounded-2xl border-2 flex items-center justify-center gap-2 text-xl font-semibold transition-colors overflow-hidden ${
                isActive
                  ? 'border-sage-400 bg-sage-50 text-sage-700'
                  : 'border-soft bg-[var(--surface-raised)] text-ink hover:border-strong'
              }`}
            >
              {/* The fill sweeps upward as the dwell completes, which reads as
                  progress without needing a separate ring to look at. */}
              <span
                className="absolute inset-x-0 bottom-0 bg-sage-200/70 pointer-events-none"
                style={{ height: `${progress * 100}%`, transition: 'height 60ms linear' }}
              />
              <span className="relative flex items-center gap-2">
                {iconFor(tile)}
                {tile.label}
              </span>
            </button>
          );
        })}
      </div>

      <p className="text-xs text-ink-faint text-center">
        Hold your gaze on a tile for {(dwellDurationMs / 1000).toFixed(1)} seconds to choose it. You can change
        that in settings.
      </p>
    </div>
  );
};
