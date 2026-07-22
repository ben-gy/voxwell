/**
 * The audio render thread half of Voxwell.
 *
 * Two processors live in one module because `addModule()` is a network fetch
 * and there is no reason to do it twice:
 *
 *   - `voxwell-voice`    wraps VoiceEngine (pitch + formant).
 *   - `voxwell-recorder` captures the processed signal as raw Float32 PCM and
 *     posts it to the main thread. Raw rather than an encoded container so the
 *     exported WAV is bit-exact and the MP3 path starts from clean samples.
 *
 * Everything this file imports is bundled into it by Vite's worker pipeline —
 * the emitted module must have no imports of its own, because AudioWorklet
 * module resolution is not dependable across browsers.
 */

import { VoiceEngine } from '../dsp/voice-engine';
import { FFT_SIZE, OVERLAP, RECORDER_PROCESSOR, VOICE_PROCESSOR } from '../dsp/constants';

interface VoiceMessage {
  type: 'params' | 'reset';
  pitch?: number;
  formant?: number;
  link?: boolean;
}

class VoiceProcessor extends AudioWorkletProcessor {
  private readonly engine = new VoiceEngine({ fftSize: FFT_SIZE, overlap: OVERLAP });
  private silence = new Float32Array(128);

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<VoiceMessage>) => {
      const data = event.data;
      if (!data) return;
      if (data.type === 'reset') {
        this.engine.reset();
        return;
      }
      if (data.type === 'params') {
        this.engine.setPitchSemitones(data.pitch ?? 0);
        if (data.link) this.engine.linkFormantsToPitch();
        else this.engine.setFormantSemitones(data.formant ?? 0);
      }
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const out = output[0];

    const input = inputs[0];
    let src = input && input.length > 0 ? input[0] : undefined;
    // A disconnected or silent input still has to be clocked through, or the
    // engine's tail never drains.
    if (!src || src.length !== out.length) {
      if (this.silence.length !== out.length) this.silence = new Float32Array(out.length);
      src = this.silence;
    }

    this.engine.process(src, out);
    for (let c = 1; c < output.length; c++) output[c].set(out);
    return true;
  }
}

const CHUNK = 8192;

class RecorderProcessor extends AudioWorkletProcessor {
  private recording = false;
  private buffer = new Float32Array(CHUNK);
  private fill = 0;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<{ type: 'start' | 'stop' }>) => {
      const type = event.data?.type;
      if (type === 'start') {
        this.fill = 0;
        this.recording = true;
      } else if (type === 'stop') {
        this.recording = false;
        this.flush();
        this.port.postMessage({ type: 'done' });
      }
    };
  }

  process(inputs: Float32Array[][]): boolean {
    const src = inputs[0]?.[0];
    if (this.recording && src) {
      for (let i = 0; i < src.length; i++) {
        this.buffer[this.fill++] = src[i];
        if (this.fill === this.buffer.length) this.flush();
      }
    }
    return true;
  }

  private flush(): void {
    if (this.fill === 0) return;
    const chunk = this.buffer.slice(0, this.fill);
    this.fill = 0;
    this.port.postMessage({ type: 'chunk', chunk }, [chunk.buffer]);
  }
}

registerProcessor(VOICE_PROCESSOR, VoiceProcessor);
registerProcessor(RECORDER_PROCESSOR, RecorderProcessor);
