// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * VoiceEngine — a streaming phase vocoder with independent pitch and formant
 * control.
 *
 * Why not just resample? Resampling moves pitch and formants together, which is
 * the "sped-up tape" chipmunk sound. Sounding like a *different person* rather
 * than a fast version of yourself needs the two separated:
 *
 *   1. Phase vocoder. Hann-windowed STFT at `overlap`× overlap. For each bin the
 *      true instantaneous frequency is recovered from the phase advance between
 *      consecutive frames; bins are then mapped k → k·p with magnitude
 *      accumulation, synthesis phases are integrated, and the frames are
 *      overlap-added back. p = 2^(semitones/12).
 *   2. Spectral envelope. The input magnitude spectrum is smoothed with a
 *      moving average whose width grows with frequency (O(N) via a prefix sum)
 *      to estimate the vocal-tract envelope — i.e. where the formants sit.
 *   3. Formant warp. After the shift, the spectrum carries envelope E(j/p). To
 *      put formants at scale s instead, every output bin is multiplied by
 *      E(j/s) / E(j/p). s = p → gain is exactly 1 (classic chipmunk, and the
 *      step is skipped); s = 1 → pitch moves and formants stay, which is the
 *      natural-sounding shift; s free → an independent "head size" control.
 *
 * Deliberately free of any Web Audio dependency: the worklet wraps it, and the
 * unit tests drive it directly with synthetic buffers.
 */

import { FFT, hann } from './fft';

export interface VoiceEngineOptions {
  fftSize?: number;
  /** Analysis overlap factor. 4 = 75% overlap. */
  overlap?: number;
}

/** Clamp for the formant gain so a near-silent envelope bin can't explode. */
const FORMANT_GAIN_MIN = 0.06;
const FORMANT_GAIN_MAX = 16;

export const PITCH_MIN_SEMITONES = -18;
export const PITCH_MAX_SEMITONES = 18;
export const FORMANT_MIN_SEMITONES = -12;
export const FORMANT_MAX_SEMITONES = 12;

export function semitonesToRatio(semitones: number): number {
  return Math.pow(2, semitones / 12);
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export class VoiceEngine {
  readonly fftSize: number;
  readonly hop: number;
  readonly overlap: number;
  /** Samples of delay the engine introduces. Trim this off an offline render. */
  readonly latency: number;

  private readonly fft: FFT;
  private readonly window: Float64Array;
  private readonly half: number;
  /** Overall OLA gain: 1 / (2 · overlap · mean(w²)) with mean(w²) = 3/8 for Hann. */
  private readonly olaScale: number;

  private readonly inFifo: Float64Array;
  private readonly outFifo: Float64Array;
  private readonly accum: Float64Array;
  private readonly lastPhase: Float64Array;
  private readonly sumPhase: Float64Array;
  private readonly anaMagn: Float64Array;
  private readonly anaFreq: Float64Array;
  private readonly synMagn: Float64Array;
  private readonly synFreq: Float64Array;
  private readonly env: Float64Array;
  private readonly prefix: Float64Array;
  private readonly re: Float64Array;
  private readonly im: Float64Array;

  private rover: number;
  private pitchRatio = 1;
  private formantRatio = 1;

  constructor(options: VoiceEngineOptions = {}) {
    const fftSize = options.fftSize ?? 1024;
    const overlap = options.overlap ?? 4;
    if (fftSize < 64 || (fftSize & (fftSize - 1)) !== 0) {
      throw new Error('fftSize must be a power of two ≥ 64');
    }
    if (overlap < 2 || fftSize % overlap !== 0) {
      throw new Error('overlap must be ≥ 2 and divide fftSize');
    }

    this.fftSize = fftSize;
    this.overlap = overlap;
    this.hop = fftSize / overlap;
    this.latency = fftSize - this.hop;
    this.half = fftSize >> 1;

    this.fft = new FFT(fftSize);
    this.window = hann(fftSize);
    this.olaScale = 1 / (2 * overlap * 0.375);

    this.inFifo = new Float64Array(fftSize);
    this.outFifo = new Float64Array(fftSize);
    this.accum = new Float64Array(fftSize + this.hop);
    this.lastPhase = new Float64Array(this.half + 1);
    this.sumPhase = new Float64Array(this.half + 1);
    this.anaMagn = new Float64Array(this.half + 1);
    this.anaFreq = new Float64Array(this.half + 1);
    this.synMagn = new Float64Array(this.half + 1);
    this.synFreq = new Float64Array(this.half + 1);
    this.env = new Float64Array(this.half + 1);
    this.prefix = new Float64Array(this.half + 2);
    this.re = new Float64Array(fftSize);
    this.im = new Float64Array(fftSize);

    this.rover = this.latency;
  }

  /** Pitch shift in semitones. Positive is higher. */
  setPitchSemitones(semitones: number): void {
    this.pitchRatio = semitonesToRatio(
      clamp(semitones, PITCH_MIN_SEMITONES, PITCH_MAX_SEMITONES),
    );
  }

  /**
   * Formant shift in semitones, measured against the *original* voice.
   * Call `linkFormantsToPitch()` instead for the classic chipmunk behaviour.
   */
  setFormantSemitones(semitones: number): void {
    this.formantRatio = semitonesToRatio(
      clamp(semitones, FORMANT_MIN_SEMITONES, FORMANT_MAX_SEMITONES),
    );
  }

  /** Formants ride along with the pitch — resample-like, no envelope correction. */
  linkFormantsToPitch(): void {
    this.formantRatio = this.pitchRatio;
  }

  getPitchRatio(): number {
    return this.pitchRatio;
  }

  getFormantRatio(): number {
    return this.formantRatio;
  }

  /** Drop all history. Use between unrelated inputs, never mid-stream. */
  reset(): void {
    this.inFifo.fill(0);
    this.outFifo.fill(0);
    this.accum.fill(0);
    this.lastPhase.fill(0);
    this.sumPhase.fill(0);
    this.rover = this.latency;
  }

  /**
   * Process a block. `input` and `output` may be any length (including the
   * 128-sample render quantum) and may be the same array.
   */
  process(input: Float32Array, output: Float32Array): void {
    const n = Math.min(input.length, output.length);
    const { inFifo, outFifo, fftSize, latency } = this;
    for (let i = 0; i < n; i++) {
      inFifo[this.rover] = input[i];
      output[i] = outFifo[this.rover - latency];
      this.rover++;
      if (this.rover >= fftSize) {
        this.rover = latency;
        this.frame();
      }
    }
  }

  /** One analysis/synthesis frame over the full `inFifo`. */
  private frame(): void {
    const { fftSize, half, hop, overlap, window, re, im } = this;
    const expected = (2 * Math.PI * hop) / fftSize;
    const twoPi = 2 * Math.PI;

    for (let k = 0; k < fftSize; k++) {
      re[k] = this.inFifo[k] * window[k];
      im[k] = 0;
    }
    this.fft.transform(re, im, false);

    // ── Analysis: magnitude + true frequency (in bin units) ──────────
    for (let k = 0; k <= half; k++) {
      const real = re[k];
      const imag = im[k];
      const magn = 2 * Math.sqrt(real * real + imag * imag);
      const phase = Math.atan2(imag, real);

      let delta = phase - this.lastPhase[k];
      this.lastPhase[k] = phase;
      delta -= k * expected;

      // Wrap the residual into (-π, π] without a loop.
      let qpd = delta / Math.PI;
      qpd = qpd >= 0 ? Math.floor(qpd) + (Math.floor(qpd) & 1) : Math.ceil(qpd) - (Math.ceil(qpd) & 1);
      delta -= Math.PI * qpd;

      this.anaMagn[k] = magn;
      this.anaFreq[k] = k + (overlap * delta) / twoPi;
    }

    // ── Shift bins ───────────────────────────────────────────────────
    this.synMagn.fill(0);
    this.synFreq.fill(0);
    const p = this.pitchRatio;
    for (let k = 0; k <= half; k++) {
      const index = Math.round(k * p);
      if (index < 0 || index > half) continue;
      this.synMagn[index] += this.anaMagn[k];
      this.synFreq[index] = this.anaFreq[k] * p;
    }

    // ── Formant warp ─────────────────────────────────────────────────
    const s = this.formantRatio;
    if (Math.abs(s - p) > 1e-4) {
      this.computeEnvelope();
      for (let j = 0; j <= half; j++) {
        if (this.synMagn[j] === 0) continue;
        const want = this.envAt(j / s);
        const have = this.envAt(j / p);
        const gain = have > 1e-12 ? want / have : 1;
        this.synMagn[j] *= clamp(gain, FORMANT_GAIN_MIN, FORMANT_GAIN_MAX);
      }
    }

    // ── Synthesis ────────────────────────────────────────────────────
    for (let k = 0; k <= half; k++) {
      const magn = this.synMagn[k];
      let delta = this.synFreq[k] - k;
      delta = (twoPi * delta) / overlap;
      delta += k * expected;
      this.sumPhase[k] += delta;
      const phase = this.sumPhase[k];
      re[k] = magn * Math.cos(phase);
      im[k] = magn * Math.sin(phase);
    }
    for (let k = 1; k < half; k++) {
      re[fftSize - k] = re[k];
      im[fftSize - k] = -im[k];
    }
    im[0] = 0;
    im[half] = 0;

    this.fft.transform(re, im, true);

    // ── Overlap-add ──────────────────────────────────────────────────
    for (let k = 0; k < fftSize; k++) {
      this.accum[k] += window[k] * re[k] * this.olaScale;
    }
    for (let k = 0; k < hop; k++) this.outFifo[k] = this.accum[k];
    this.accum.copyWithin(0, hop);
    this.accum.fill(0, fftSize);
    for (let k = 0; k < this.latency; k++) this.inFifo[k] = this.inFifo[k + hop];
  }

  /**
   * Smooth the analysis magnitudes into a spectral envelope. The averaging
   * width grows with bin index, which approximates a constant-Q smoothing —
   * wide enough up top to erase harmonics, tight enough at the bottom to keep
   * the first formant.
   */
  private computeEnvelope(): void {
    const { half, prefix, env, anaMagn } = this;
    prefix[0] = 0;
    for (let i = 0; i <= half; i++) prefix[i + 1] = prefix[i] + anaMagn[i];
    for (let j = 0; j <= half; j++) {
      // Wide enough at the bottom to smooth across the harmonics of a low
      // voice (±5 bins ≈ ±230 Hz at 1024/48k, so ~4 harmonics of a 100 Hz
      // speaker), widening further up where formants are broader anyway.
      const w = Math.min(40, 5 + Math.round(j * 0.08));
      const lo = j - w < 0 ? 0 : j - w;
      const hi = j + w > half ? half : j + w;
      env[j] = (prefix[hi + 1] - prefix[lo]) / (hi - lo + 1) + 1e-9;
    }
  }

  /** Envelope sampled at a fractional bin position, linearly interpolated. */
  private envAt(x: number): number {
    const { half, env } = this;
    if (!(x > 0)) return env[0];
    if (x >= half) return env[half];
    const i = Math.floor(x);
    const f = x - i;
    return env[i] * (1 - f) + env[i + 1] * f;
  }
}
