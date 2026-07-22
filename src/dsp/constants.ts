/**
 * Shared between the main thread and the audio render thread.
 *
 * Kept in its own module (rather than read off a VoiceEngine instance) so the
 * main thread can know the engine's latency without allocating one.
 */
export const FFT_SIZE = 1024;
export const OVERLAP = 4;
export const HOP = FFT_SIZE / OVERLAP;

/**
 * Samples of delay the voice engine introduces. An offline render is padded by
 * this much and then trimmed, so a processed file lines up with the original.
 */
export const VOICE_LATENCY_SAMPLES = FFT_SIZE - HOP;

export const VOICE_PROCESSOR = 'voxwell-voice';
export const RECORDER_PROCESSOR = 'voxwell-recorder';
