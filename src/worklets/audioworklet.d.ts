/**
 * Ambient declarations for the AudioWorkletGlobalScope.
 * TypeScript's DOM lib describes `AudioWorkletNode` (main thread) but not the
 * processor side, so the handful of globals the worklet uses are declared here.
 */

declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}

declare function registerProcessor(
  name: string,
  processorCtor: new (options?: unknown) => AudioWorkletProcessor,
): void;

declare const sampleRate: number;
