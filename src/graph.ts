/**
 * The signal chain, built identically for a realtime `AudioContext` (live mic)
 * and an `OfflineAudioContext` (a dropped file). Sharing one builder is what
 * guarantees the preview you hear is the file you export.
 *
 *            ┌────────────────────────── dry ──────────────────────────┐
 *   input ───┤                                                          ├─ level ─ limiter ─► out
 *            └─ voice ─ drive ─ ring ─ hp ─ lp ─ wobble ─ wet ─────────┘
 *                                                    └─ echo (feedback) ┘
 *
 * Only the pitch/formant stage is custom; everything after it is native Web
 * Audio, which keeps CPU low enough to monitor live on a phone.
 */

import { VOICE_PROCESSOR } from './dsp/constants';
import type { VoiceParams } from './types';

export interface VoiceChain {
  /** Connect the source node here. */
  input: GainNode;
  /** Connect this to a destination, analyser or recorder. */
  output: AudioNode;
  update(params: VoiceParams, immediate?: boolean): void;
  dispose(): void;
}

/**
 * Soft-clipping transfer curve. At `amount === 0` this is the identity, so the
 * shaper can stay permanently in the chain without colouring a clean voice.
 */
export function makeDriveCurve(amount: number): Float32Array<ArrayBuffer> {
  const n = 1024;
  const k = Math.max(0, amount) * 3;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / (n - 1) - 1;
    curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
  }
  return curve;
}

export const LIMITER_KNEE = 0.75;
/** Headroom the limiter can pull back from before the shaper's own clamp bites. */
export const LIMITER_HEADROOM = 2;

/** Below the knee this is exactly y = x; above it, a smooth ride up towards ±1. */
export function softLimit(x: number, knee = LIMITER_KNEE): number {
  const mag = Math.abs(x);
  if (mag <= knee) return x;
  const over = (mag - knee) / (1 - knee);
  return Math.sign(x) * (knee + (1 - knee) * Math.tanh(over));
}

/**
 * Safety limiter curve for a WaveShaper.
 *
 * A `DynamicsCompressorNode` would be the obvious choice, but Blink applies an
 * internal makeup gain, so "Natural" would come out ~1.7 dB louder than it went
 * in — and by a different amount in other engines. A shaper is deterministic
 * everywhere. The chain feeds it through a ×0.5 gain so the curve's [-1, 1]
 * input domain covers signals up to ±2.
 */
export function makeLimiterCurve(): Float32Array<ArrayBuffer> {
  const n = 2048;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = ((i * 2) / (n - 1) - 1) * LIMITER_HEADROOM;
    curve[i] = softLimit(x);
  }
  return curve;
}

export function buildChain(ctx: BaseAudioContext, params: VoiceParams): VoiceChain {
  // Offline contexts expose `length`; realtime ones do not. Ramps are only
  // meaningful in realtime — offline renders set values outright so a render is
  // deterministic and identical every time.
  const realtime = !('length' in ctx);

  const input = ctx.createGain();
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  const level = ctx.createGain();

  // Safety limiter, last in the chain. Ring modulation plus an echo can push a
  // normal-level voice past full scale, and a clipped export is unrecoverable —
  // whereas a soft ride on the peaks is inaudible. Transparent below 0.75.
  const limiterPad = ctx.createGain();
  limiterPad.gain.value = 1 / LIMITER_HEADROOM;
  const limiter = ctx.createWaveShaper();
  limiter.oversample = '4x';
  limiter.curve = makeLimiterCurve();
  limiterPad.connect(limiter);

  const voice = new AudioWorkletNode(ctx, VOICE_PROCESSOR, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
  });

  const shaper = ctx.createWaveShaper();
  shaper.oversample = '2x';

  // Ring modulator: the carrier is summed into a gain's `gain` param. With the
  // param's own value at 0 the result is a true multiplication (ring), not
  // amplitude modulation; with depth 0 and value 1 it is a plain wire.
  const ring = ctx.createGain();
  const ringOsc = ctx.createOscillator();
  const ringDepth = ctx.createGain();
  ringOsc.type = 'sine';
  ringOsc.connect(ringDepth).connect(ring.gain);

  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  const presence = ctx.createBiquadFilter();
  presence.type = 'peaking';
  presence.frequency.value = 1800;
  presence.Q.value = 0.9;

  // Vibrato: a short delay whose time is modulated by an LFO. Modulating delay
  // is what makes it a pitch wobble rather than a tremolo.
  const wobble = ctx.createDelay(0.05);
  const wobbleOsc = ctx.createOscillator();
  const wobbleDepth = ctx.createGain();
  wobbleOsc.type = 'sine';
  wobbleOsc.connect(wobbleDepth).connect(wobble.delayTime);

  const echoSend = ctx.createGain();
  const echo = ctx.createDelay(1.5);
  const echoFeedback = ctx.createGain();
  echoFeedback.gain.value = 0.32;

  input.connect(dry).connect(level);
  input.connect(voice);
  voice.connect(shaper).connect(ring).connect(hp).connect(lp).connect(presence).connect(wobble);
  wobble.connect(wet).connect(level);
  wet.connect(echoSend).connect(echo);
  echo.connect(echoFeedback).connect(echo);
  echo.connect(level);
  level.connect(limiterPad);

  ringOsc.start(0);
  wobbleOsc.start(0);

  let lastDrive = -1;
  let started = false;

  function set(param: AudioParam, value: number, immediate: boolean): void {
    if (immediate || !realtime) param.value = value;
    else param.setTargetAtTime(value, ctx.currentTime, 0.015);
  }

  function update(next: VoiceParams, immediate = false): void {
    const first = !started;
    started = true;
    const now = first || immediate;

    voice.port.postMessage({
      type: 'params',
      pitch: next.pitch,
      formant: next.formant,
      link: next.linkFormants,
    });

    if (next.drive !== lastDrive) {
      lastDrive = next.drive;
      shaper.curve = makeDriveCurve(next.drive / 100);
    }

    const ringOn = next.ring > 0;
    set(ring.gain, ringOn ? 0 : 1, now);
    set(ringDepth.gain, ringOn ? 1 : 0, now);
    if (ringOn) set(ringOsc.frequency, next.ring, now);

    set(hp.frequency, next.radio ? 380 : 20, now);
    set(lp.frequency, next.radio ? 3200 : 20000, now);
    set(presence.gain, next.radio ? 8 : 0, now);

    const wobbling = next.wobbleRate > 0 && next.wobbleDepth > 0;
    set(wobble.delayTime, 0.006, now);
    set(wobbleOsc.frequency, Math.max(0.01, next.wobbleRate), now);
    set(wobbleDepth.gain, wobbling ? (next.wobbleDepth / 100) * 0.0045 : 0, now);

    set(echoSend.gain, (next.echoMix / 100) * 0.85, now);
    set(echo.delayTime, Math.min(1.4, next.echoTime / 1000), now);

    const wetAmount = next.mix / 100;
    set(wet.gain, wetAmount, now);
    set(dry.gain, 1 - wetAmount, now);
    set(level.gain, next.output / 100, now);
  }

  update(params, true);

  function dispose(): void {
    try {
      ringOsc.stop();
      wobbleOsc.stop();
    } catch {
      /* already stopped */
    }
    for (const node of [
      input,
      dry,
      wet,
      level,
      limiterPad,
      limiter,
      voice,
      shaper,
      ring,
      ringOsc,
      ringDepth,
      hp,
      lp,
      presence,
      wobble,
      wobbleOsc,
      wobbleDepth,
      echoSend,
      echo,
      echoFeedback,
    ]) {
      try {
        node.disconnect();
      } catch {
        /* already detached */
      }
    }
  }

  return { input, output: limiter, update, dispose };
}
