/**
 * Measurement helpers. Used by the unit tests to assert that the engine really
 * did move the pitch, and by the in-page test hook that drives the browser
 * dry-run with synthetic samples (the automation cannot speak into a mic).
 */

import { FFT, hann } from './fft';

/** Root-mean-square level of a buffer. */
export function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

/**
 * Frequency of the strongest spectral peak, in Hz, with parabolic interpolation
 * between bins so the estimate is accurate to well under one bin.
 *
 * Analyses a window taken from the middle of the buffer, which skips any
 * fade-in and the engine's settling frames.
 */
export function dominantFrequency(
  samples: Float32Array,
  sampleRate: number,
  fftSize = 8192,
): number {
  if (samples.length < 64 || sampleRate <= 0) return 0;
  const n = Math.min(fftSize, 1 << Math.floor(Math.log2(samples.length)));
  if (n < 64) return 0;

  const start = Math.max(0, Math.floor((samples.length - n) / 2));
  const window = hann(n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = samples[start + i] * window[i];

  new FFT(n).transform(re, im, false);

  const half = n >> 1;
  const mag = new Float64Array(half + 1);
  for (let k = 0; k <= half; k++) mag[k] = Math.hypot(re[k], im[k]);

  let peak = 1;
  for (let k = 2; k < half; k++) if (mag[k] > mag[peak]) peak = k;

  const a = mag[peak - 1];
  const b = mag[peak];
  const c = mag[peak + 1] ?? 0;
  const denom = a - 2 * b + c;
  const delta = denom === 0 ? 0 : (0.5 * (a - c)) / denom;

  return ((peak + delta) * sampleRate) / n;
}

/** A windowed sine, for tests and the in-page synthetic driver. */
export function makeTone(
  frequency: number,
  seconds: number,
  sampleRate: number,
  amplitude = 0.5,
): Float32Array {
  const n = Math.max(1, Math.round(seconds * sampleRate));
  const out = new Float32Array(n);
  const fade = Math.min(Math.round(sampleRate * 0.01), Math.floor(n / 2));
  for (let i = 0; i < n; i++) {
    let gain = amplitude;
    if (i < fade) gain *= i / fade;
    else if (i > n - fade) gain *= (n - i) / fade;
    out[i] = gain * Math.sin((2 * Math.PI * frequency * i) / sampleRate);
  }
  return out;
}
