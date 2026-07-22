// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * Web Audio plumbing: worklet loading, microphone acquisition, file decoding
 * and offline rendering. Everything that touches the browser's audio stack
 * lives here so `main.ts` stays a state machine.
 */

// Vite bundles the worklet and its imports into a single self-contained ES
// module and hands back its URL. It must stay import-free once emitted —
// AudioWorklet module resolution is not dependable across browsers.
import workletUrl from './worklets/voice-worklet.ts?worker&url';

import { buildChain } from './graph';
import { VOICE_LATENCY_SAMPLES } from './dsp/constants';
import type { VoiceParams } from './types';

const workletLoaded = new WeakSet<BaseAudioContext>();

export function audioSupported(): boolean {
  return (
    typeof AudioWorkletNode !== 'undefined' &&
    typeof OfflineAudioContext !== 'undefined' &&
    typeof AudioContext !== 'undefined'
  );
}

export async function ensureWorklet(ctx: BaseAudioContext): Promise<void> {
  if (workletLoaded.has(ctx)) return;
  await ctx.audioWorklet.addModule(workletUrl);
  workletLoaded.add(ctx);
}

export class MicrophoneError extends Error {
  readonly reason: 'denied' | 'missing' | 'insecure' | 'unknown';
  constructor(reason: MicrophoneError['reason'], message: string) {
    super(message);
    this.name = 'MicrophoneError';
    this.reason = reason;
  }
}

/**
 * Request the microphone. MUST be called from inside a user gesture — Safari
 * and every mobile browser reject it otherwise, and iOS will not even show the
 * prompt.
 *
 * The usual voice-call processing is turned off: echo cancellation and noise
 * suppression fight the effects and gate the tail of every phrase, and AGC
 * makes the level jump around mid-recording.
 */
export async function startMicrophone(): Promise<MediaStream> {
  if (!window.isSecureContext) {
    throw new MicrophoneError(
      'insecure',
      'The microphone needs a secure connection (https). Open the site over https and try again.',
    );
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new MicrophoneError('missing', 'This browser has no microphone API.');
  }
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: false,
    });
  } catch (err) {
    const name = (err as DOMException)?.name ?? '';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      throw new MicrophoneError(
        'denied',
        'Microphone access was blocked. You can still drop in an audio file — that path does everything the live one does.',
      );
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      throw new MicrophoneError(
        'missing',
        'No microphone was found. Drop in an audio file instead.',
      );
    }
    throw new MicrophoneError('unknown', `The microphone could not be opened (${name || 'unknown error'}).`);
  }
}

/** Stop every track so the OS recording indicator goes out. */
export function stopStream(stream: MediaStream | null): void {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      /* already stopped */
    }
  }
}

/** True once every track of the stream has ended. Used by the test hook. */
export function streamFullyStopped(stream: MediaStream | null): boolean {
  if (!stream) return true;
  return stream.getTracks().every((t) => t.readyState === 'ended');
}

export interface DecodedAudio {
  samples: Float32Array;
  sampleRate: number;
  duration: number;
}

/** Average every channel into one. Voxwell is a voice tool; mono throughout. */
export function downmix(buffer: AudioBuffer): Float32Array {
  const channels = buffer.numberOfChannels;
  const out = new Float32Array(buffer.length);
  if (channels === 0) return out;
  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] += data[i];
  }
  if (channels > 1) for (let i = 0; i < out.length; i++) out[i] /= channels;
  return out;
}

const DECODE_RATE = 48000;

export async function decodeAudioFile(file: File): Promise<DecodedAudio> {
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength === 0) throw new Error('That file is empty.');
  const ctx = new OfflineAudioContext(1, 1, DECODE_RATE);
  let buffer: AudioBuffer;
  try {
    buffer = await ctx.decodeAudioData(bytes);
  } catch {
    throw new Error(
      `Your browser could not decode “${file.name}”. Try an MP3, M4A, WAV or OGG file.`,
    );
  }
  return {
    samples: downmix(buffer),
    sampleRate: buffer.sampleRate,
    duration: buffer.duration,
  };
}

/** Extra tail so an echo is not cut off mid-repeat. */
export function tailSamples(params: VoiceParams, sampleRate: number): number {
  const seconds = params.echoMix > 0 ? Math.min(2.5, params.echoTime / 1000 + 1.4) : 0.05;
  return Math.round(seconds * sampleRate);
}

/**
 * Render `samples` through the chain offline, then trim the engine's latency so
 * the result lines up with the original.
 */
export async function renderOffline(
  samples: Float32Array,
  sampleRate: number,
  params: VoiceParams,
): Promise<Float32Array> {
  const tail = tailSamples(params, sampleRate);
  const total = samples.length + VOICE_LATENCY_SAMPLES + tail;
  const ctx = new OfflineAudioContext(1, total, sampleRate);
  await ensureWorklet(ctx);

  const buffer = ctx.createBuffer(1, samples.length, sampleRate);
  buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);

  const source = ctx.createBufferSource();
  source.buffer = buffer;

  const chain = buildChain(ctx, params);
  source.connect(chain.input);
  chain.output.connect(ctx.destination);
  source.start(0);

  const rendered = await ctx.startRendering();
  chain.dispose();

  const data = rendered.getChannelData(0);
  return data.slice(VOICE_LATENCY_SAMPLES);
}

/** Peak absolute sample value — used for the clip warning and the meter. */
export function peakLevel(samples: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] < 0 ? -samples[i] : samples[i];
    if (v > peak) peak = v;
  }
  return peak;
}

/** Concatenate recorded chunks into one contiguous buffer. */
export function joinChunks(chunks: Float32Array[]): Float32Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
