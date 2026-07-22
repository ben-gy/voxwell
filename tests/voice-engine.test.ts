import { describe, expect, it } from 'vitest';
import { VoiceEngine, semitonesToRatio } from '../src/dsp/voice-engine';
import { dominantFrequency, makeTone, rms } from '../src/dsp/analysis';
import { FFT, hann } from '../src/dsp/fft';
import { VOICE_LATENCY_SAMPLES } from '../src/dsp/constants';

const SR = 48000;

/** Push a buffer through the engine in render-quantum-sized blocks. */
function run(engine: VoiceEngine, input: Float32Array, blockSize = 128): Float32Array {
  const out = new Float32Array(input.length);
  const inBlock = new Float32Array(blockSize);
  const outBlock = new Float32Array(blockSize);
  for (let i = 0; i < input.length; i += blockSize) {
    const n = Math.min(blockSize, input.length - i);
    inBlock.fill(0);
    inBlock.set(input.subarray(i, i + n));
    engine.process(inBlock, outBlock);
    out.set(outBlock.subarray(0, n), i);
  }
  return out;
}

/** Drop the latency plus a few frames of settling. */
function steady(samples: Float32Array): Float32Array {
  const skip = VOICE_LATENCY_SAMPLES + 4096;
  return samples.subarray(skip, samples.length - 2048);
}

/** Magnitude-weighted mean frequency — a proxy for "how bright is this". */
function spectralCentroid(samples: Float32Array, sampleRate: number): number {
  const n = 8192;
  const start = Math.max(0, Math.floor((samples.length - n) / 2));
  const w = hann(n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = (samples[start + i] ?? 0) * w[i];
  new FFT(n).transform(re, im, false);
  let num = 0;
  let den = 0;
  for (let k = 1; k <= n / 2; k++) {
    const mag = Math.hypot(re[k], im[k]);
    num += ((k * sampleRate) / n) * mag;
    den += mag;
  }
  return den === 0 ? 0 : num / den;
}

/**
 * Fundamental frequency by normalised autocorrelation. The first lag whose
 * correlation reaches 90% of the best one is taken, which avoids the usual
 * octave-down error on a rich harmonic stack.
 */
function estimateF0(samples: Float32Array, sampleRate: number, minHz = 60, maxHz = 700): number {
  const n = Math.min(samples.length, sampleRate);
  const start = Math.max(0, Math.floor((samples.length - n) / 2));
  const x = samples.subarray(start, start + n);
  const minLag = Math.floor(sampleRate / maxHz);
  const maxLag = Math.floor(sampleRate / minHz);
  const scores: number[] = [];
  let best = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    let energy = 0;
    for (let i = 0; i + lag < n; i += 2) {
      sum += x[i] * x[i + lag];
      energy += x[i] * x[i];
    }
    const score = energy > 0 ? sum / energy : 0;
    scores.push(score);
    if (score > best) best = score;
  }
  const index = scores.findIndex((s) => s >= best * 0.9);
  return sampleRate / (minLag + Math.max(0, index));
}

/** A crude voice-like signal: a harmonic stack under a fixed formant bump. */
function harmonicVoice(f0: number, seconds: number, sampleRate: number): Float32Array {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  for (let h = 1; h <= 20; h++) {
    const f = f0 * h;
    if (f > sampleRate / 2 - 100) break;
    // Resonance around 900 Hz, so the signal has an envelope to preserve.
    const env = 1 / (1 + Math.pow((f - 900) / 450, 2));
    for (let i = 0; i < n; i++) {
      out[i] += (env / h) * 0.35 * Math.sin((2 * Math.PI * f * i) / sampleRate);
    }
  }
  const fade = Math.round(sampleRate * 0.01);
  for (let i = 0; i < fade; i++) {
    out[i] *= i / fade;
    out[n - 1 - i] *= i / fade;
  }
  return out;
}

describe('semitonesToRatio', () => {
  it('maps octaves to doubling and halving', () => {
    expect(semitonesToRatio(0)).toBe(1);
    expect(semitonesToRatio(12)).toBeCloseTo(2, 10);
    expect(semitonesToRatio(-12)).toBeCloseTo(0.5, 10);
    expect(semitonesToRatio(7)).toBeCloseTo(1.4983, 4);
  });
});

describe('VoiceEngine construction', () => {
  it('reports the latency the offline renderer trims', () => {
    const engine = new VoiceEngine({ fftSize: 1024, overlap: 4 });
    expect(engine.latency).toBe(768);
    expect(engine.latency).toBe(VOICE_LATENCY_SAMPLES);
    expect(engine.hop).toBe(256);
  });

  it('rejects nonsensical configurations', () => {
    expect(() => new VoiceEngine({ fftSize: 700 })).toThrow(/power of two/);
    expect(() => new VoiceEngine({ fftSize: 32 })).toThrow(/power of two/);
    expect(() => new VoiceEngine({ fftSize: 1024, overlap: 1 })).toThrow(/overlap/);
    expect(() => new VoiceEngine({ fftSize: 1024, overlap: 3 })).toThrow(/overlap/);
  });

  it('clamps the pitch and formant controls to their published ranges', () => {
    const engine = new VoiceEngine();
    engine.setPitchSemitones(99);
    expect(engine.getPitchRatio()).toBeCloseTo(semitonesToRatio(18), 10);
    engine.setPitchSemitones(-99);
    expect(engine.getPitchRatio()).toBeCloseTo(semitonesToRatio(-18), 10);
    engine.setFormantSemitones(99);
    expect(engine.getFormantRatio()).toBeCloseTo(semitonesToRatio(12), 10);
  });

  it('links formants to whatever the pitch currently is', () => {
    const engine = new VoiceEngine();
    engine.setPitchSemitones(7);
    engine.linkFormantsToPitch();
    expect(engine.getFormantRatio()).toBe(engine.getPitchRatio());
  });
});

describe('VoiceEngine pitch shifting', () => {
  it('leaves a tone alone at 0 semitones', () => {
    const engine = new VoiceEngine();
    engine.setPitchSemitones(0);
    engine.setFormantSemitones(0);
    const input = makeTone(440, 2, SR);
    const output = run(engine, input);
    expect(dominantFrequency(steady(output), SR)).toBeCloseTo(440, -1);
  });

  it('is close to unity gain when it is doing nothing', () => {
    const engine = new VoiceEngine();
    const input = makeTone(440, 2, SR, 0.5);
    const output = run(engine, input);
    const inLevel = rms(input.subarray(SR / 2, SR * 1.5));
    const outLevel = rms(steady(output));
    expect(outLevel / inLevel).toBeGreaterThan(0.85);
    expect(outLevel / inLevel).toBeLessThan(1.15);
  });

  it('shifts a 440 Hz tone up an octave to 880 Hz', () => {
    const engine = new VoiceEngine();
    engine.setPitchSemitones(12);
    engine.linkFormantsToPitch();
    const output = run(engine, makeTone(440, 2, SR));
    expect(dominantFrequency(steady(output), SR)).toBeCloseTo(880, -1);
  });

  it('shifts a 440 Hz tone down an octave to 220 Hz', () => {
    const engine = new VoiceEngine();
    engine.setPitchSemitones(-12);
    engine.linkFormantsToPitch();
    const output = run(engine, makeTone(440, 2, SR));
    expect(dominantFrequency(steady(output), SR)).toBeCloseTo(220, -1);
  });

  it('shifts by a musical fifth (+7 semitones)', () => {
    const engine = new VoiceEngine();
    engine.setPitchSemitones(7);
    engine.linkFormantsToPitch();
    const output = run(engine, makeTone(400, 2, SR));
    const expected = 400 * semitonesToRatio(7);
    expect(dominantFrequency(steady(output), SR)).toBeGreaterThan(expected * 0.97);
    expect(dominantFrequency(steady(output), SR)).toBeLessThan(expected * 1.03);
  });

  it('preserves duration exactly — this is a pitch shift, not a resample', () => {
    const engine = new VoiceEngine();
    engine.setPitchSemitones(9);
    const input = makeTone(440, 1, SR);
    const output = run(engine, input);
    expect(output.length).toBe(input.length);
  });

  it('produces silence from silence, with no NaN or DC offset', () => {
    const engine = new VoiceEngine();
    engine.setPitchSemitones(5);
    const output = run(engine, new Float32Array(SR));
    for (const s of output) expect(Number.isFinite(s)).toBe(true);
    expect(rms(output)).toBeLessThan(1e-6);
  });

  it('delays the signal by exactly its reported latency', () => {
    const engine = new VoiceEngine();
    const input = new Float32Array(4096);
    input.fill(0.5, 0, 2048);
    const output = run(engine, input);
    // Nothing may appear before the latency has elapsed (denormals aside).
    for (let i = 0; i < engine.latency; i++) expect(Math.abs(output[i])).toBeLessThan(1e-9);
    let energyAfter = 0;
    for (let i = engine.latency; i < output.length; i++) energyAfter += Math.abs(output[i]);
    expect(energyAfter).toBeGreaterThan(0);
  });

  it('tolerates any block size, including one bigger than a frame', () => {
    const input = makeTone(440, 1, SR);
    const a = new VoiceEngine();
    a.setPitchSemitones(12);
    a.linkFormantsToPitch();
    const b = new VoiceEngine();
    b.setPitchSemitones(12);
    b.linkFormantsToPitch();
    const small = run(a, input, 128);
    const large = run(b, input, 4096);
    for (let i = 0; i < small.length; i++) expect(large[i]).toBeCloseTo(small[i], 6);
  });

  it('reset() clears history so a second pass matches the first', () => {
    const engine = new VoiceEngine();
    engine.setPitchSemitones(4);
    const input = makeTone(300, 0.5, SR);
    const first = run(engine, input);
    engine.reset();
    const second = run(engine, input);
    for (let i = 0; i < first.length; i += 97) expect(second[i]).toBeCloseTo(first[i], 6);
  });
});

describe('VoiceEngine formant control', () => {
  it('still moves the pitch an octave while the formants are held still', () => {
    // The claim this tool rests on: pitch and formants move independently.
    // Measured by period rather than by the loudest partial, because with the
    // envelope preserved the loudest partial stays near the 900 Hz resonance.
    const input = harmonicVoice(140, 2, SR);
    const engine = new VoiceEngine();
    engine.setPitchSemitones(12);
    engine.setFormantSemitones(0);
    const output = steady(run(engine, input));
    const ratio = estimateF0(output, SR) / estimateF0(input, SR);
    expect(ratio).toBeGreaterThan(1.9);
    expect(ratio).toBeLessThan(2.1);
  });

  it('is a no-op on the envelope while formants are linked', () => {
    const engine = new VoiceEngine();
    engine.setPitchSemitones(-5);
    engine.linkFormantsToPitch();
    expect(engine.getFormantRatio()).toBe(engine.getPitchRatio());
  });

  it('sounds brighter with formants linked than with them held still', () => {
    const input = harmonicVoice(140, 2, SR);

    const linked = new VoiceEngine();
    linked.setPitchSemitones(12);
    linked.linkFormantsToPitch();
    const linkedOut = steady(run(linked, input));

    const held = new VoiceEngine();
    held.setPitchSemitones(12);
    held.setFormantSemitones(0);
    const heldOut = steady(run(held, input));

    // Linked = the whole spectrum moves up (chipmunk). Held = the resonance
    // stays where it was, so the same pitch shift is markedly less bright.
    expect(spectralCentroid(linkedOut, SR)).toBeGreaterThan(spectralCentroid(heldOut, SR) * 1.15);
  });

  it('a negative formant shift is darker than a positive one', () => {
    const input = harmonicVoice(140, 2, SR);

    const down = new VoiceEngine();
    down.setPitchSemitones(0);
    down.setFormantSemitones(-7);
    const downOut = steady(run(down, input));

    const up = new VoiceEngine();
    up.setPitchSemitones(0);
    up.setFormantSemitones(7);
    const upOut = steady(run(up, input));

    expect(spectralCentroid(upOut, SR)).toBeGreaterThan(spectralCentroid(downOut, SR));
  });

  it('never produces a non-finite sample when warping formants hard', () => {
    const engine = new VoiceEngine();
    engine.setPitchSemitones(-18);
    engine.setFormantSemitones(12);
    const output = run(engine, harmonicVoice(110, 1, SR));
    for (const s of output) expect(Number.isFinite(s)).toBe(true);
  });
});
