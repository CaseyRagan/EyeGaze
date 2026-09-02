/**
 * Spoken prompts.
 *
 * Calibration asks the client to hold their gaze on a dot, which makes reading
 * the screen impossible at exactly the moment the instructions matter. The ears
 * are the only channel left. It also means someone who cannot comfortably read
 * the screen — a fair share of the people this tool is for — gets the same
 * instruction as everyone else rather than a worse experience.
 */

let enabled = true;
let lastSpoken = '';
let lastSpokenAt = 0;
/** Repeats of the same line inside this window are the same request twice. */
const REPEAT_WINDOW_MS = 1500;

export function setSpeechEnabled(value: boolean) {
  enabled = value;
  if (!value) cancelSpeech();
}

export function isSpeechAvailable(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

export function speakPrompt(text: string) {
  if (!enabled || !isSpeechAvailable()) return;

  // Effects can fire twice for one transition — React's development mode does
  // it deliberately — and a prompt stuttering over itself is worse than no
  // prompt at all.
  const now = Date.now();
  if (text === lastSpoken && now - lastSpokenAt < REPEAT_WINDOW_MS) return;
  lastSpoken = text;
  lastSpokenAt = now;

  try {
    // Anything still being said is about the previous step and is now wrong.
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    // A shade slower than default: these are instructions someone is expected
    // to act on immediately, not prose.
    utterance.rate = 0.95;
    window.speechSynthesis.speak(utterance);
  } catch {
    // Speech is an enhancement; the text is on screen either way.
  }
}

export function cancelSpeech() {
  // The de-duplication window is deliberately not reset here. Cancelling is
  // about stopping audio, and a teardown immediately followed by a re-mount —
  // which is exactly what React's development mode does — must not be treated
  // as a fresh request to say the same thing again.
  if (!isSpeechAvailable()) return;
  try {
    window.speechSynthesis.cancel();
  } catch {
    // Ignore.
  }
}
