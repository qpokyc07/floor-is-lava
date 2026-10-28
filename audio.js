/**
 * Звук на WebAudio: всё синтезируется на месте, никаких файлов.
 * AudioContext создаётся только после первого касания (иначе браузер блокирует).
 */

export class Sfx {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.enabled = true;
    this.noiseBuf = null;
    this.rumble = null;
    this.sizzle = null;
    this.sizzleGain = null;
  }

  init() {
    if (this.ctx) return true;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    try {
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.enabled ? 0.8 : 0;
      this.master.connect(this.ctx.destination);
      this.noiseBuf = this.makeNoise(2);
      return true;
    } catch (e) {
      this.ctx = null;
      return false;
    }
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (this.master) this.master.gain.value = this.enabled ? 0.8 : 0;
  }

  makeNoise(seconds) {
    const sr = this.ctx.sampleRate;
    const buf = this.ctx.createBuffer(1, Math.floor(sr * seconds), sr);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  tone(freq, dur, opts = {}) {
    if (!this.ctx || !this.enabled) return;
    const t0 = this.ctx.currentTime + (opts.delay || 0);
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = opts.type || 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    if (opts.to) osc.frequency.exponentialRampToValueAtTime(Math.max(30, opts.to), t0 + dur);
    const vol = opts.vol == null ? 0.25 : opts.vol;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  noise(dur, opts = {}) {
    if (!this.ctx || !this.enabled) return;
    const t0 = this.ctx.currentTime + (opts.delay || 0);
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = this.ctx.createBiquadFilter();
    f.type = opts.filter || 'bandpass';
    f.frequency.setValueAtTime(opts.freq || 900, t0);
    if (opts.to) f.frequency.exponentialRampToValueAtTime(Math.max(60, opts.to), t0 + dur);
    f.Q.value = opts.q || 0.9;
    const g = this.ctx.createGain();
    const vol = opts.vol == null ? 0.2 : opts.vol;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + (opts.attack || 0.01));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f);
    f.connect(g);
    g.connect(this.master);
    src.start(t0);
    src.stop(t0 + dur + 0.05);
  }

  countdown(step) {
    if (step > 0) this.tone(520 + step * 60, 0.16, { type: 'triangle', vol: 0.22 });
    else this.tone(880, 0.5, { type: 'triangle', vol: 0.3, to: 1320 });
  }

  start() {
    this.tone(110, 0.7, { type: 'sawtooth', vol: 0.16, to: 220 });
    this.noise(0.9, { filter: 'lowpass', freq: 500, to: 160, vol: 0.18 });
    this.startRumble();
  }

  startRumble() {
    if (!this.ctx || this.rumble) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 120;
    const g = this.ctx.createGain();
    g.gain.value = 0.05;
    src.connect(f);
    f.connect(g);
    g.connect(this.master);
    src.start();
    this.rumble = { src, g };

    const s = this.ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    s.loop = true;
    const bf = this.ctx.createBiquadFilter();
    bf.type = 'bandpass';
    bf.frequency.value = 1800;
    bf.Q.value = 1.2;
    const sg = this.ctx.createGain();
    sg.gain.value = 0;
    s.connect(bf);
    bf.connect(sg);
    sg.connect(this.master);
    s.start();
    this.sizzle = s;
    this.sizzleGain = sg;
  }

  stopRumble() {
    try {
      if (this.rumble) { this.rumble.src.stop(); this.rumble.g = null; this.rumble = null; }
      if (this.sizzle) { this.sizzle.stop(); this.sizzle = null; this.sizzleGain = null; }
    } catch (_) { /* noop */ }
  }

  setDanger(level) {
    if (!this.sizzleGain || !this.ctx) return;
    const target = Math.max(0, Math.min(1, level)) * 0.22;
    try {
      this.sizzleGain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.08);
    } catch (_) { /* noop */ }
  }

  jump() {
    this.noise(0.22, { filter: 'bandpass', freq: 320, to: 1500, vol: 0.16, q: 1.1 });
  }

  land() {
    this.tone(90, 0.16, { type: 'sine', vol: 0.16, to: 55 });
  }

  warn() {
    this.tone(1180, 0.14, { type: 'square', vol: 0.1 });
    this.tone(1580, 0.1, { type: 'square', vol: 0.07, delay: 0.11 });
  }

  change() {
    this.tone(150, 0.3, { type: 'sawtooth', vol: 0.2, to: 60 });
    this.noise(0.35, { filter: 'lowpass', freq: 900, to: 200, vol: 0.16 });
  }

  gameOver() {
    this.setDanger(0);
    if (!this.ctx) return;
    this.tone(440, 0.9, { type: 'sawtooth', vol: 0.22, to: 55 });
    this.tone(220, 1.1, { type: 'square', vol: 0.14, to: 40, delay: 0.06 });
    this.noise(1.1, { filter: 'lowpass', freq: 1600, to: 90, vol: 0.25 });
  }

  win() {
    this.tone(660, 0.16, { type: 'triangle', vol: 0.2 });
    this.tone(880, 0.16, { type: 'triangle', vol: 0.2, delay: 0.14 });
    this.tone(1320, 0.4, { type: 'triangle', vol: 0.22, delay: 0.28 });
  }
}
