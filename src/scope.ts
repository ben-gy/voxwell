// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * The display: a live oscilloscope while the microphone is open, and a static
 * peak waveform with a playhead once there is a rendered clip.
 *
 * Driven by `setInterval`, deliberately not `requestAnimationFrame` — rAF never
 * fires in a hidden or backgrounded tab, and nothing about the tool's audio
 * should be coupled to whether the visuals happen to be animating.
 */

type Mode = 'idle' | 'live' | 'clip';

const TICK_MS = 33;

export class Scope {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly observer: ResizeObserver | null;

  private mode: Mode = 'idle';
  private analyser: AnalyserNode | null = null;
  private timeData: Float32Array<ArrayBuffer> = new Float32Array(2048);
  private peaks: { min: Float32Array; max: Float32Array } | null = null;
  private samples: Float32Array | null = null;
  private playhead = -1;
  private timer: number | null = null;
  private cssWidth = 0;
  private cssHeight = 0;

  private colors = {
    grid: '#1e1e2a',
    wave: '#b26bff',
    waveSoft: 'rgba(178, 107, 255, 0.22)',
    playhead: '#ffffff',
    idle: '#3a3a4a',
  };

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is unavailable in this browser.');
    this.ctx = ctx;

    const styles = getComputedStyle(document.documentElement);
    const read = (name: string, fallback: string) =>
      styles.getPropertyValue(name).trim() || fallback;
    this.colors.grid = read('--border-subtle', this.colors.grid);
    this.colors.wave = read('--accent', this.colors.wave);
    this.colors.waveSoft = read('--accent-dim', this.colors.waveSoft);
    this.colors.idle = read('--text-muted', this.colors.idle);

    this.observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            this.resize();
            this.draw();
          });
    this.observer?.observe(canvas);
    this.resize();
    this.draw();
  }

  private resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = this.canvas.clientWidth || 640;
    const h = this.canvas.clientHeight || 180;
    this.cssWidth = w;
    this.cssHeight = h;
    const pw = Math.max(1, Math.round(w * dpr));
    const ph = Math.max(1, Math.round(h * dpr));
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw;
      this.canvas.height = ph;
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.samples) this.peaks = null;
  }

  /** Live oscilloscope from an analyser. */
  attachAnalyser(analyser: AnalyserNode | null): void {
    this.analyser = analyser;
    if (analyser) {
      this.timeData = new Float32Array(analyser.fftSize);
      this.mode = 'live';
      this.samples = null;
      this.peaks = null;
      this.start();
    } else if (this.mode === 'live') {
      this.mode = 'idle';
      this.stop();
      this.draw();
    }
  }

  /** Static waveform of a finished clip. */
  showClip(samples: Float32Array | null): void {
    this.analyser = null;
    this.samples = samples;
    this.peaks = null;
    this.playhead = -1;
    this.mode = samples ? 'clip' : 'idle';
    this.stop();
    this.draw();
  }

  setPlayhead(ratio: number): void {
    this.playhead = ratio;
    if (this.mode === 'clip') this.draw();
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = window.setInterval(() => this.draw(), TICK_MS);
  }

  stop(): void {
    if (this.timer === null) return;
    window.clearInterval(this.timer);
    this.timer = null;
  }

  dispose(): void {
    this.stop();
    this.observer?.disconnect();
  }

  private draw(): void {
    const { ctx } = this;
    const w = this.cssWidth;
    const h = this.cssHeight;
    if (w <= 0 || h <= 0) return;
    const mid = h / 2;

    ctx.clearRect(0, 0, w, h);

    ctx.strokeStyle = this.colors.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, Math.round(mid) + 0.5);
    ctx.lineTo(w, Math.round(mid) + 0.5);
    ctx.stroke();

    if (this.mode === 'live' && this.analyser) {
      this.analyser.getFloatTimeDomainData(this.timeData);
      ctx.strokeStyle = this.colors.wave;
      ctx.lineWidth = 2;
      ctx.beginPath();
      const n = this.timeData.length;
      for (let x = 0; x < w; x++) {
        const i = Math.floor((x / w) * n);
        const y = mid - this.timeData[i] * mid * 0.92;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      return;
    }

    if (this.mode === 'clip' && this.samples) {
      if (!this.peaks) this.peaks = computePeaks(this.samples, Math.max(1, Math.floor(w)));
      const { min, max } = this.peaks;
      ctx.fillStyle = this.colors.wave;
      for (let x = 0; x < min.length; x++) {
        const top = mid - max[x] * mid * 0.92;
        const bottom = mid - min[x] * mid * 0.92;
        ctx.fillRect(x, top, 1, Math.max(1, bottom - top));
      }
      if (this.playhead >= 0 && this.playhead <= 1) {
        const x = Math.round(this.playhead * w) + 0.5;
        ctx.strokeStyle = this.colors.playhead;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
      return;
    }

    ctx.strokeStyle = this.colors.idle;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let x = 0; x < w; x++) {
      const y = mid + Math.sin(x / 26) * 1.5;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
}

/** Column-wise min/max peaks. Exported for tests. */
export function computePeaks(
  samples: Float32Array,
  columns: number,
): { min: Float32Array; max: Float32Array } {
  const min = new Float32Array(columns);
  const max = new Float32Array(columns);
  if (samples.length === 0) return { min, max };
  const per = samples.length / columns;
  for (let c = 0; c < columns; c++) {
    const start = Math.floor(c * per);
    const end = Math.min(samples.length, Math.max(start + 1, Math.floor((c + 1) * per)));
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = start; i < end; i++) {
      const v = samples[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    min[c] = lo === Infinity ? 0 : lo;
    max[c] = hi === -Infinity ? 0 : hi;
  }
  return { min, max };
}
