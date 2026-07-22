/** Shared types for the whole app. */

/** Every knob in the signal chain. One flat object so it is trivial to diff, persist and test. */
export interface VoiceParams {
  /** Pitch shift, semitones. */
  pitch: number;
  /** Formant shift, semitones, relative to the original voice. Ignored when `linkFormants`. */
  formant: number;
  /** Formants ride along with pitch — the classic sped-up-tape character. */
  linkFormants: boolean;
  /** Ring modulator carrier in Hz. 0 disables it. */
  ring: number;
  /** Waveshaper drive, 0–100. */
  drive: number;
  /** Telephone/radio bandpass. */
  radio: boolean;
  /** Vibrato LFO rate in Hz. 0 disables it. */
  wobbleRate: number;
  /** Vibrato depth, 0–100. */
  wobbleDepth: number;
  /** Echo send level, 0–100. 0 disables the echo entirely. */
  echoMix: number;
  /** Echo delay time in ms. */
  echoTime: number;
  /** Wet/dry balance, 0–100 (100 = fully processed). */
  mix: number;
  /** Output level, 0–200 (%). */
  output: number;
}

export type OutputFormat = 'wav' | 'mp3';

export type SourceKind = 'mic' | 'file';

export interface RenderedClip {
  samples: Float32Array;
  sampleRate: number;
}

export interface EncodeRequest {
  format: OutputFormat;
  samples: Float32Array;
  sampleRate: number;
  bitrate: number;
}

export type EncodeResponse =
  | { type: 'progress'; value: number }
  | { type: 'done'; buffer: ArrayBuffer; mime: string }
  | { type: 'error'; message: string };
