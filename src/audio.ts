// Small synthesized sound effects. Nothing plays until the first click.
export type Sfx = 'click' | 'build' | 'zone' | 'bulldoze' | 'error' | 'alert' | 'coin' | 'fanfare' | 'terrain';

export class Audio {
  enabled = true;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private last = new Map<Sfx, number>();

  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    try {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.35;
      this.master.connect(this.ctx.destination);
    } catch {
      this.ctx = null;
    }
  }

  play(s: Sfx): void {
    if (!this.enabled || !this.ctx || !this.master) return;
    const now = this.ctx.currentTime;
    const prev = this.last.get(s) ?? -1;
    if (now - prev < (s === 'terrain' ? 0.12 : 0.05)) return;
    this.last.set(s, now);
    switch (s) {
      case 'click': return this.tone(880, 0.04, 'square', 0.08);
      case 'build': this.tone(220, 0.09, 'triangle', 0.35); return this.noise(0.06, 900, 0.18);
      case 'zone': this.tone(523, 0.08, 'sine', 0.25); return this.tone(784, 0.12, 'sine', 0.2, 0.06);
      case 'bulldoze': return this.noise(0.28, 400, 0.4);
      case 'error': return this.tone(140, 0.18, 'sawtooth', 0.2);
      case 'terrain': return this.noise(0.08, 250, 0.12);
      case 'coin': this.tone(988, 0.08, 'square', 0.15); return this.tone(1319, 0.2, 'square', 0.15, 0.08);
      case 'fanfare': {
        [523, 659, 784, 1047].forEach((f, k) => this.tone(f, 0.18, 'triangle', 0.25, k * 0.11));
        return;
      }
      case 'alert': {
        const o = this.ctx.createOscillator();
        const g = this.ctx.createGain();
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(600, now);
        o.frequency.linearRampToValueAtTime(900, now + 0.35);
        o.frequency.linearRampToValueAtTime(600, now + 0.7);
        g.gain.setValueAtTime(0.0001, now);
        g.gain.exponentialRampToValueAtTime(0.12, now + 0.05);
        g.gain.exponentialRampToValueAtTime(0.0001, now + 0.75);
        o.connect(g).connect(this.master);
        o.start(now);
        o.stop(now + 0.8);
      }
    }
  }

  private tone(freq: number, dur: number, type: OscillatorType, vol: number, delay = 0): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master!);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  private noise(dur: number, cutoff: number, vol: number): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const len = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = cutoff;
    const g = ctx.createGain();
    g.gain.value = vol;
    src.connect(f).connect(g).connect(this.master!);
    src.start(t);
  }
}
