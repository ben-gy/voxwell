import { describe, expect, it } from 'vitest';
import { FFT, hann } from '../src/dsp/fft';

/** Reference O(n²) DFT to check the fast one against. */
function naiveDft(re: Float64Array, im: Float64Array): { re: Float64Array; im: Float64Array } {
  const n = re.length;
  const outRe = new Float64Array(n);
  const outIm = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    for (let t = 0; t < n; t++) {
      const a = (-2 * Math.PI * k * t) / n;
      outRe[k] += re[t] * Math.cos(a) - im[t] * Math.sin(a);
      outIm[k] += re[t] * Math.sin(a) + im[t] * Math.cos(a);
    }
  }
  return { re: outRe, im: outIm };
}

describe('FFT', () => {
  it('rejects sizes that are not a power of two', () => {
    expect(() => new FFT(100)).toThrow(/power of two/);
    expect(() => new FFT(1)).toThrow(/power of two/);
  });

  it('rejects buffers of the wrong length', () => {
    const fft = new FFT(8);
    expect(() => fft.transform(new Float64Array(4), new Float64Array(4))).toThrow(/8 long/);
  });

  it('matches a naive DFT on random data', () => {
    const n = 32;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      re[i] = Math.sin(i * 1.7) * 0.8 + Math.cos(i * 0.31);
      im[i] = Math.cos(i * 2.3) * 0.4;
    }
    const expected = naiveDft(re, im);
    new FFT(n).transform(re, im, false);
    for (let k = 0; k < n; k++) {
      expect(re[k]).toBeCloseTo(expected.re[k], 8);
      expect(im[k]).toBeCloseTo(expected.im[k], 8);
    }
  });

  it('puts a pure tone in exactly one bin pair', () => {
    const n = 64;
    const bin = 5;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = Math.cos((2 * Math.PI * bin * i) / n);
    new FFT(n).transform(re, im, false);
    const mag = (k: number) => Math.hypot(re[k], im[k]);
    expect(mag(bin)).toBeCloseTo(n / 2, 6);
    expect(mag(n - bin)).toBeCloseTo(n / 2, 6);
    expect(mag(bin + 1)).toBeLessThan(1e-9);
  });

  it('round-trips through the inverse transform', () => {
    const n = 128;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    const original = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      re[i] = Math.sin(i / 3) + 0.25 * Math.sin(i / 11);
      original[i] = re[i];
    }
    const fft = new FFT(n);
    fft.transform(re, im, false);
    fft.transform(re, im, true);
    for (let i = 0; i < n; i++) {
      expect(re[i]).toBeCloseTo(original[i], 10);
      expect(im[i]).toBeCloseTo(0, 10);
    }
  });

  it('handles an all-zero buffer without producing NaN', () => {
    const n = 16;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    new FFT(n).transform(re, im, false);
    expect(Array.from(re).every(Number.isFinite)).toBe(true);
    expect(Array.from(im).every(Number.isFinite)).toBe(true);
  });
});

describe('hann', () => {
  it('starts at zero and peaks in the middle', () => {
    const w = hann(8);
    expect(w[0]).toBeCloseTo(0, 12);
    expect(w[4]).toBeCloseTo(1, 12);
  });

  it('has mean square 3/8, which is what the overlap-add scaling assumes', () => {
    const n = 1024;
    const w = hann(n);
    let sum = 0;
    for (let i = 0; i < n; i++) sum += w[i] * w[i];
    expect(sum / n).toBeCloseTo(0.375, 6);
  });
});
