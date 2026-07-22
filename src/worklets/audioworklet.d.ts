// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
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
