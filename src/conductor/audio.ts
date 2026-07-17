// Optional mic overlay: layers audio reactivity onto whichever conductor is
// active. Spectral-flux beat detection + bass/mid/treble energy bands.

export interface AudioFrame {
  /** 0–1 overall loudness boost. */
  energy: number;
  bass: number;
  /** True on the exact frame a beat lands. */
  beat: number; // 0 or pulse strength
}

export class MicOverlay {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private stream: MediaStream | null = null;
  private freq = new Uint8Array(0);
  private prevFreq = new Float32Array(0);
  private fluxHistory: number[] = [];
  private refractory = 0;

  get active(): boolean {
    return this.ctx !== null;
  }

  async enable(): Promise<void> {
    if (this.ctx) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    this.ctx = new AudioContext();
    const source = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.55;
    source.connect(this.analyser);
    this.freq = new Uint8Array(this.analyser.frequencyBinCount);
    this.prevFreq = new Float32Array(this.analyser.frequencyBinCount);
    this.fluxHistory = [];
  }

  disable(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.analyser = null;
    this.stream = null;
  }

  update(dt: number): AudioFrame {
    if (!this.analyser) return { energy: 0, bass: 0, beat: 0 };
    this.analyser.getByteFrequencyData(this.freq);

    const bandAvg = (from: number, to: number) => {
      let sum = 0;
      for (let i = from; i < to; i++) sum += this.freq[i];
      return sum / ((to - from) * 255);
    };
    const bass = bandAvg(1, 10);
    const mids = bandAvg(10, 80);
    const treble = bandAvg(80, 400);
    const energy = Math.min(1, bass * 0.55 + mids * 0.3 + treble * 0.3);

    // Spectral flux (positive changes only) against a rolling threshold.
    let flux = 0;
    const bins = Math.min(200, this.freq.length);
    for (let i = 0; i < bins; i++) {
      const diff = this.freq[i] - this.prevFreq[i];
      if (diff > 0) flux += diff;
      this.prevFreq[i] = this.freq[i];
    }
    flux /= bins * 255;
    this.fluxHistory.push(flux);
    if (this.fluxHistory.length > 45) this.fluxHistory.shift();

    let beat = 0;
    this.refractory -= dt;
    if (this.fluxHistory.length > 20 && this.refractory <= 0) {
      const mean = this.fluxHistory.reduce((a, b) => a + b, 0) / this.fluxHistory.length;
      const variance =
        this.fluxHistory.reduce((a, b) => a + (b - mean) ** 2, 0) / this.fluxHistory.length;
      const threshold = mean + 1.9 * Math.sqrt(variance) + 0.008;
      if (flux > threshold) {
        beat = Math.min(1, 0.35 + bass * 0.9);
        this.refractory = 0.16;
      }
    }
    return { energy, bass, beat };
  }
}
