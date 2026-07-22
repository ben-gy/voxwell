import { describe, expect, it } from 'vitest';
import { dominantFrequency, makeTone, rms } from '../src/dsp/analysis';

describe('makeTone', () => {
  it('produces the requested length and stays within the amplitude', () => {
    const tone = makeTone(440, 0.5, 48000, 0.4);
    expect(tone.length).toBe(24000);
    for (const s of tone) expect(Math.abs(s)).toBeLessThanOrEqual(0.4 + 1e-6);
  });

  it('fades in and out so there is no click at either end', () => {
    const tone = makeTone(440, 0.5, 48000);
    expect(Math.abs(tone[0])).toBeLessThan(0.01);
    expect(Math.abs(tone[tone.length - 1])).toBeLessThan(0.01);
  });
});

describe('rms', () => {
  it('is zero for silence and 1/√2 of the amplitude for a sine', () => {
    expect(rms(new Float32Array(128))).toBe(0);
    const tone = makeTone(1000, 1, 48000, 1);
    expect(rms(tone)).toBeCloseTo(Math.SQRT1_2, 1);
  });

  it('handles an empty buffer', () => {
    expect(rms(new Float32Array(0))).toBe(0);
  });
});

describe('dominantFrequency', () => {
  it('finds a pure tone to within a fraction of a percent', () => {
    for (const f of [220, 440, 1000, 3000]) {
      const tone = makeTone(f, 1, 48000);
      expect(dominantFrequency(tone, 48000)).toBeCloseTo(f, -1);
    }
  });

  it('picks the loudest of two tones', () => {
    const sr = 48000;
    const quiet = makeTone(300, 1, sr, 0.1);
    const loud = makeTone(1200, 1, sr, 0.8);
    const mixed = new Float32Array(quiet.length);
    for (let i = 0; i < mixed.length; i++) mixed[i] = quiet[i] + loud[i];
    expect(dominantFrequency(mixed, sr)).toBeGreaterThan(1150);
    expect(dominantFrequency(mixed, sr)).toBeLessThan(1250);
  });

  it('returns 0 for input too short to analyse', () => {
    expect(dominantFrequency(new Float32Array(8), 48000)).toBe(0);
    expect(dominantFrequency(makeTone(440, 1, 48000), 0)).toBe(0);
  });
});
