// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * Radix-2 in-place complex FFT.
 *
 * Hand-written rather than pulled from npm for two reasons: the voice worklet
 * has to be a single self-contained ES module (AudioWorklet module resolution
 * is not dependable), and this is 60 lines that we can test exactly against a
 * naive DFT.
 *
 * Convention: the forward transform uses e^(-2πikn/N); the inverse uses the
 * conjugate twiddles and divides by N, so `inverse(forward(x)) === x`.
 */
export class FFT {
  readonly size: number;
  private readonly cos: Float64Array;
  private readonly sin: Float64Array;
  private readonly rev: Uint32Array;

  constructor(size: number) {
    if (size < 2 || (size & (size - 1)) !== 0) {
      throw new Error(`FFT size must be a power of two ≥ 2, got ${size}`);
    }
    this.size = size;

    const half = size >> 1;
    this.cos = new Float64Array(half);
    this.sin = new Float64Array(half);
    for (let i = 0; i < half; i++) {
      const a = (-2 * Math.PI * i) / size;
      this.cos[i] = Math.cos(a);
      this.sin[i] = Math.sin(a);
    }

    const bits = Math.round(Math.log2(size));
    this.rev = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r = (r << 1) | ((i >> b) & 1);
      this.rev[i] = r;
    }
  }

  /** Transform `re`/`im` in place. Both arrays must be exactly `size` long. */
  transform(re: Float64Array, im: Float64Array, inverse = false): void {
    const n = this.size;
    if (re.length !== n || im.length !== n) {
      throw new Error(`FFT buffers must be ${n} long`);
    }

    for (let i = 0; i < n; i++) {
      const j = this.rev[i];
      if (j > i) {
        const tr = re[i];
        re[i] = re[j];
        re[j] = tr;
        const ti = im[i];
        im[i] = im[j];
        im[j] = ti;
      }
    }

    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let j = 0; j < half; j++) {
          const k = j * step;
          const wr = this.cos[k];
          const wi = inverse ? -this.sin[k] : this.sin[k];
          const a = i + j;
          const b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }

    if (inverse) {
      for (let i = 0; i < n; i++) {
        re[i] /= n;
        im[i] /= n;
      }
    }
  }
}

/** Periodic Hann window of length `n`. Used for both analysis and synthesis. */
export function hann(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}
