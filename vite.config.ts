// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
import { defineConfig } from 'vite';

export default defineConfig({
  base: '/',
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  worker: {
    // The voice worklet is emitted through Vite's worker pipeline (`?worker&url`)
    // so its imports are bundled into a single self-contained ES module —
    // AudioWorklet module resolution for bare/relative specifiers is not
    // dependable across browsers, so the emitted file must not import anything.
    format: 'es',
  },
  test: {
    environment: 'jsdom',
    globals: true,
  },
});
