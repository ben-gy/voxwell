/// <reference lib="webworker" />
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * Encoder worker — turns the rendered PCM into a WAV or MP3 file off the main
 * thread. WAV is hand-rolled and instant; MP3 goes through the pure-JS LAME
 * encoder (no WASM, so no cross-origin-isolation headers are needed).
 */

import type { EncodeRequest, EncodeResponse } from './types';
import { encodeWav, toPcm16 } from './wav';

const post = (msg: EncodeResponse, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(msg, transfer);

self.onmessage = async (event: MessageEvent<EncodeRequest>) => {
  const req = event.data;
  if (!req) return;
  try {
    if (req.format === 'wav') {
      const buffer = encodeWav(req.samples, req.sampleRate);
      post({ type: 'progress', value: 1 });
      post({ type: 'done', buffer, mime: 'audio/wav' }, [buffer]);
      return;
    }
    const buffer = await encodeMp3(req.samples, req.sampleRate, req.bitrate);
    post({ type: 'done', buffer, mime: 'audio/mpeg' }, [buffer]);
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : 'Encoding failed.' });
  }
};

interface Mp3EncoderLike {
  encodeBuffer(left: Int16Array, right?: Int16Array): Int8Array;
  flush(): Int8Array;
}

async function encodeMp3(
  samples: Float32Array,
  sampleRate: number,
  bitrate: number,
): Promise<ArrayBuffer> {
  const mod = (await import('@breezystack/lamejs')) as unknown as Record<string, unknown>;
  const lame = ((mod as { default?: unknown }).default ?? mod) as Record<string, unknown>;
  const Mp3Encoder = (lame.Mp3Encoder ?? mod.Mp3Encoder) as
    | (new (channels: number, sampleRate: number, kbps: number) => Mp3EncoderLike)
    | undefined;
  if (!Mp3Encoder) throw new Error('The MP3 encoder could not be loaded — try WAV instead.');

  const pcm = toPcm16(samples);
  const encoder = new Mp3Encoder(1, sampleRate, bitrate);
  const BLOCK = 1152; // one MPEG frame
  const parts: Uint8Array[] = [];
  let size = 0;
  let lastPost = 0;

  for (let i = 0; i < pcm.length; i += BLOCK) {
    const chunk = encoder.encodeBuffer(pcm.subarray(i, i + BLOCK));
    if (chunk.length > 0) {
      parts.push(new Uint8Array(chunk));
      size += chunk.length;
    }
    const value = pcm.length > 0 ? i / pcm.length : 1;
    if (value - lastPost >= 0.04) {
      lastPost = value;
      post({ type: 'progress', value });
    }
  }

  const tail = encoder.flush();
  if (tail.length > 0) {
    parts.push(new Uint8Array(tail));
    size += tail.length;
  }
  post({ type: 'progress', value: 1 });

  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out.buffer;
}
