import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, PRESETS, findPreset, matchPreset } from '../src/presets';
import { LIMITER_HEADROOM, LIMITER_KNEE, makeDriveCurve, makeLimiterCurve, softLimit } from '../src/graph';
import { computePeaks } from '../src/scope';

describe('presets', () => {
  it('has unique ids and fits the 1–9 keyboard shortcuts', () => {
    const ids = PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(PRESETS.length).toBeGreaterThan(0);
    expect(PRESETS.length).toBeLessThanOrEqual(9);
  });

  it('gives every preset a complete parameter set', () => {
    const keys = Object.keys(DEFAULT_PARAMS).sort();
    for (const preset of PRESETS) {
      expect(Object.keys(preset.params).sort()).toEqual(keys);
      expect(preset.name.length).toBeGreaterThan(0);
      expect(preset.hint.length).toBeGreaterThan(0);
    }
  });

  it('keeps every value inside the range its control exposes', () => {
    for (const p of PRESETS) {
      expect(Math.abs(p.params.pitch)).toBeLessThanOrEqual(18);
      expect(Math.abs(p.params.formant)).toBeLessThanOrEqual(12);
      expect(p.params.ring).toBeGreaterThanOrEqual(0);
      expect(p.params.mix).toBeGreaterThanOrEqual(0);
      expect(p.params.mix).toBeLessThanOrEqual(100);
      expect(p.params.output).toBeLessThanOrEqual(200);
    }
  });

  it('starts from an untouched Natural preset', () => {
    expect(PRESETS[0].id).toBe('natural');
    expect(PRESETS[0].params).toEqual(DEFAULT_PARAMS);
  });

  it('finds presets by id, and nothing by a bad id', () => {
    expect(findPreset('monster')?.name).toBe('Monster');
    expect(findPreset('nope')).toBeUndefined();
  });

  it('matches params back to a preset, and reports null once edited', () => {
    expect(matchPreset(DEFAULT_PARAMS)).toBe('natural');
    expect(matchPreset({ ...DEFAULT_PARAMS, pitch: 3 })).toBeNull();
    const monster = findPreset('monster')!;
    expect(matchPreset(monster.params)).toBe('monster');
  });
});

describe('makeDriveCurve', () => {
  it('is the identity at zero drive', () => {
    const curve = makeDriveCurve(0);
    expect(curve[0]).toBeCloseTo(-1, 6);
    expect(curve[curve.length - 1]).toBeCloseTo(1, 6);
    expect(curve[512]).toBeCloseTo(0.0009775, 4);
  });

  it('stays inside [-1, 1] and rises monotonically at any drive', () => {
    for (const amount of [0, 0.25, 1]) {
      const curve = makeDriveCurve(amount);
      expect(curve.length).toBe(1024);
      for (let i = 1; i < curve.length; i++) {
        expect(curve[i]).toBeGreaterThan(curve[i - 1]);
        expect(Math.abs(curve[i])).toBeLessThanOrEqual(1 + 1e-6);
      }
    }
  });

  it('lifts quiet signals as drive increases', () => {
    const soft = makeDriveCurve(0);
    const hard = makeDriveCurve(1);
    expect(hard[700]).toBeGreaterThan(soft[700]);
  });
});

describe('softLimit', () => {
  it('is exactly transparent below the knee', () => {
    for (const x of [0, 0.1, 0.5, 0.74, -0.5, -0.74]) expect(softLimit(x)).toBe(x);
  });

  it('rides peaks down without ever passing full scale', () => {
    for (const x of [0.9, 1, 1.5, 2, 8, -0.9, -2, -8]) {
      expect(Math.abs(softLimit(x))).toBeLessThanOrEqual(1);
      expect(Math.abs(softLimit(x))).toBeGreaterThan(LIMITER_KNEE);
      expect(Math.sign(softLimit(x))).toBe(Math.sign(x));
    }
  });

  it('is continuous across the knee', () => {
    expect(softLimit(LIMITER_KNEE + 1e-6)).toBeCloseTo(LIMITER_KNEE, 5);
  });
});

describe('makeLimiterCurve', () => {
  it('maps the padded input domain back to the true signal level', () => {
    const curve = makeLimiterCurve();
    const at = (signal: number) => {
      const v = signal / LIMITER_HEADROOM; // the ×0.5 pad in front of the shaper
      const i = Math.round(((v + 1) / 2) * (curve.length - 1));
      return curve[i];
    };
    // The curve has an even sample count, so "zero" lands half a step off.
    expect(Math.abs(at(0))).toBeLessThan(0.002);
    expect(at(0.5)).toBeCloseTo(0.5, 2);
    expect(at(-0.5)).toBeCloseTo(-0.5, 2);
    expect(at(1.5)).toBeGreaterThan(0.9);
    expect(at(1.5)).toBeLessThan(1);
  });

  it('is monotonic and bounded', () => {
    const curve = makeLimiterCurve();
    for (let i = 1; i < curve.length; i++) {
      expect(curve[i]).toBeGreaterThanOrEqual(curve[i - 1]);
      expect(Math.abs(curve[i])).toBeLessThanOrEqual(1);
    }
  });
});

describe('computePeaks', () => {
  it('reduces a buffer to per-column minima and maxima', () => {
    const samples = new Float32Array([1, -1, 0.5, -0.5]);
    const { min, max } = computePeaks(samples, 2);
    expect(max[0]).toBe(1);
    expect(min[0]).toBe(-1);
    expect(max[1]).toBe(0.5);
    expect(min[1]).toBe(-0.5);
  });

  it('returns zeroed columns for an empty buffer', () => {
    const { min, max } = computePeaks(new Float32Array(0), 4);
    expect(Array.from(min)).toEqual([0, 0, 0, 0]);
    expect(Array.from(max)).toEqual([0, 0, 0, 0]);
  });

  it('never leaves a column unfilled when there are more columns than samples', () => {
    const { min, max } = computePeaks(new Float32Array([0.3, -0.2]), 8);
    for (let i = 0; i < 8; i++) {
      expect(Number.isFinite(min[i])).toBe(true);
      expect(Number.isFinite(max[i])).toBe(true);
    }
  });
});
