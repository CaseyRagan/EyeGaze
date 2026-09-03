// Web Audio API harmonic sound generator

class SoundEngine {
  private ctx: AudioContext | null = null;
  private humOsc: OscillatorNode | null = null;
  private humGain: GainNode | null = null;
  private isEnabled: boolean = true;

  private initContext() {
    if (!this.ctx && typeof window !== 'undefined') {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  public setEnabled(enabled: boolean) {
    this.isEnabled = enabled;
    if (!enabled && this.humGain) {
      this.humGain.gain.setTargetAtTime(0, this.ctx?.currentTime || 0, 0.05);
    }
  }

  public playChime(freq = 440, duration = 0.35, waveType: OscillatorType = 'sine') {
    if (!this.isEnabled) return;
    try {
      this.initContext();
      if (!this.ctx) return;

      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = waveType;
      osc.frequency.setValueAtTime(freq, this.ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(freq * 1.02, this.ctx.currentTime + duration * 0.5);

      gain.gain.setValueAtTime(0, this.ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0.18, this.ctx.currentTime + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + duration);

      osc.connect(gain);
      gain.connect(this.ctx.destination);

      osc.start();
      osc.stop(this.ctx.currentTime + duration);
    } catch {
      // Audio context might be restricted before user interaction
    }
  }

  public playStarConnect(index = 0) {
    if (!this.isEnabled) return;
    const pentatonicScale = [261.63, 293.66, 329.63, 392.00, 440.00, 523.25, 587.33, 659.25, 783.99, 880.00];
    const baseFreq = pentatonicScale[index % pentatonicScale.length];
    
    this.playChime(baseFreq, 0.45, 'sine');
    setTimeout(() => {
      this.playChime(baseFreq * 1.5, 0.35, 'triangle');
    }, 60);
  }

  public playBubblePop(pitch = 520) {
    if (!this.isEnabled) return;
    try {
      this.initContext();
      if (!this.ctx) return;

      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(pitch, this.ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(pitch * 2.2, this.ctx.currentTime + 0.12);

      gain.gain.setValueAtTime(0.2, this.ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.14);

      osc.connect(gain);
      gain.connect(this.ctx.destination);

      osc.start();
      osc.stop(this.ctx.currentTime + 0.15);
    } catch {
      // Ignore
    }
  }

  public playCalibrationTargetHit() {
    if (!this.isEnabled) return;
    this.playChime(587.33, 0.3, 'sine');
    setTimeout(() => this.playChime(880.00, 0.4, 'sine'), 90);
  }

  public playGridSnapTick() {
    if (!this.isEnabled) return;
    try {
      this.initContext();
      if (!this.ctx) return;

      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(1200, this.ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(800, this.ctx.currentTime + 0.03);

      gain.gain.setValueAtTime(0.08, this.ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.03);

      osc.connect(gain);
      gain.connect(this.ctx.destination);

      osc.start();
      osc.stop(this.ctx.currentTime + 0.035);
    } catch {
      // Ignore
    }
  }

  public playFocusLock() {
    if (!this.isEnabled) return;
    this.playChime(660, 0.15, 'sine');
  }

  public playLevelComplete() {
    if (!this.isEnabled) return;
    const chords = [523.25, 659.25, 783.99, 1046.50];
    chords.forEach((freq, i) => {
      setTimeout(() => {
        this.playChime(freq, 0.6, 'sine');
      }, i * 80);
    });
  }

  public updateGazeHum(normalizedSpeed: number, isDrawing: boolean) {
    if (!this.isEnabled || !isDrawing) {
      if (this.humGain && this.ctx) {
        this.humGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.08);
      }
      return;
    }

    try {
      this.initContext();
      if (!this.ctx) return;

      if (!this.humOsc || !this.humGain) {
        this.humOsc = this.ctx.createOscillator();
        this.humGain = this.ctx.createGain();

        this.humOsc.type = 'sine';
        this.humOsc.frequency.setValueAtTime(220, this.ctx.currentTime);
        this.humGain.gain.setValueAtTime(0, this.ctx.currentTime);

        this.humOsc.connect(this.humGain);
        this.humGain.connect(this.ctx.destination);
        this.humOsc.start();
      }

      const targetFreq = 180 + Math.min(normalizedSpeed * 280, 400);
      const targetVol = Math.min(0.04 + normalizedSpeed * 0.06, 0.1);

      this.humOsc.frequency.setTargetAtTime(targetFreq, this.ctx.currentTime, 0.05);
      this.humGain.gain.setTargetAtTime(targetVol, this.ctx.currentTime, 0.05);
    } catch {
      // Ignore
    }
  }
}

export const soundEngine = new SoundEngine();
