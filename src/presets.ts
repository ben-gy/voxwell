// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/** Named starting points. Every one is just a `VoiceParams`, so nothing is hidden. */

import type { VoiceParams } from './types';

export const DEFAULT_PARAMS: VoiceParams = {
  pitch: 0,
  formant: 0,
  linkFormants: false,
  ring: 0,
  drive: 0,
  radio: false,
  wobbleRate: 0,
  wobbleDepth: 0,
  echoMix: 0,
  echoTime: 220,
  mix: 100,
  output: 100,
};

export interface Preset {
  id: string;
  name: string;
  hint: string;
  params: VoiceParams;
}

function preset(id: string, name: string, hint: string, patch: Partial<VoiceParams>): Preset {
  return { id, name, hint, params: { ...DEFAULT_PARAMS, ...patch } };
}

export const PRESETS: Preset[] = [
  preset('natural', 'Natural', 'Untouched — the chain, doing nothing', {}),
  preset('chipmunk', 'Chipmunk', 'Small and fast', { pitch: 7, linkFormants: true }),
  preset('squeaky', 'Squeaky', 'A whole octave up', { pitch: 12, linkFormants: true }),
  preset('deep', 'Deep', 'Lower, but still a person', { pitch: -5, formant: -3 }),
  preset('monster', 'Monster', 'Under the bed', {
    pitch: -9,
    formant: -6,
    drive: 34,
    wobbleRate: 3.5,
    wobbleDepth: 22,
  }),
  preset('robot', 'Robot', 'Ring modulator, no pitch', { ring: 55, drive: 18, mix: 92 }),
  preset('radio', 'Radio', 'Squeezed through a handset', { radio: true, drive: 46 }),
  preset('alien', 'Alien', 'Metallic and far away', {
    pitch: 4,
    formant: 5,
    ring: 180,
    echoMix: 26,
    echoTime: 140,
  }),
  preset('ghost', 'Ghost', 'Wobbling in a corridor', {
    pitch: -2,
    formant: -1,
    wobbleRate: 5,
    wobbleDepth: 34,
    echoMix: 46,
    echoTime: 320,
  }),
];

export function findPreset(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}

/** Which preset (if any) the current params exactly match — used to light a tile. */
export function matchPreset(params: VoiceParams): string | null {
  for (const p of PRESETS) {
    let same = true;
    for (const key of Object.keys(p.params) as (keyof VoiceParams)[]) {
      if (p.params[key] !== params[key]) {
        same = false;
        break;
      }
    }
    if (same) return p.id;
  }
  return null;
}
