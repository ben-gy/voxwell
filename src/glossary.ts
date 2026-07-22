// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/** Jargon → plain-English definitions for click-to-define tooltips. */
export const GLOSSARY: Record<string, string> = {
  formant:
    'The resonances of your throat and mouth — the fixed peaks in your voice that make an "ee" sound like an "ee" and make you sound like an adult rather than a child. Move the pitch and leave the formants alone and you sound like the same person singing higher; move both and you sound like a chipmunk.',
  pitch:
    'How high or low the voice sits, measured in semitones. +12 is one octave up (twice the frequency), −12 is one octave down.',
  semitone:
    'One key on a piano. Twelve semitones make an octave, which is a doubling of frequency.',
  'phase vocoder':
    'The technique Voxwell uses to change pitch without changing speed. It chops the sound into overlapping windows, works out the true frequency of every component from how its phase moves between windows, moves those frequencies, and stitches the windows back together.',
  stft:
    'Short-Time Fourier Transform — a running spectrum. The signal is cut into short overlapping slices and each slice is turned into its frequencies, so you can see and edit how the sound changes over time.',
  fft: 'Fast Fourier Transform — the algorithm that turns a slice of sound into the list of frequencies it is made of, and back again.',
  'spectral envelope':
    'The smooth outline of the spectrum, ignoring the individual harmonics. It is basically a picture of where your formants are, and Voxwell uses it to move them independently of the pitch.',
  'ring modulator':
    'Multiplies your voice by a steady tone. The result keeps your rhythm and articulation but loses natural harmonic structure — the classic Dalek/robot sound.',
  audioworklet:
    'A slot in the browser where your own audio code runs on the real-time audio thread, in 128-sample blocks. It is what makes live monitoring possible without the page stuttering.',
  offlineaudiocontext:
    'A Web Audio engine that renders as fast as the CPU allows instead of in real time. Voxwell pushes a dropped file through the exact same chain here, so the preview and the export are identical.',
  pcm: 'Pulse-code modulation: raw uncompressed audio, just a long list of amplitude numbers. It is what a WAV file stores.',
  wav: 'An uncompressed audio file. Bigger than MP3 but lossless — the cleanest possible export.',
  mp3: 'A compact, near-universal compressed format. Voxwell encodes it locally with a JavaScript LAME encoder, so the audio never leaves your device.',
  'dry/wet':
    'How much of the original ("dry") voice is blended with the processed ("wet") one. 100% wet is fully transformed; lower it to keep some of yourself in the mix.',
  latency:
    'The small delay between speaking and hearing yourself. The pitch engine needs 768 samples (about 16 ms at 48 kHz) of sound before it can produce any, which is short enough to monitor comfortably.',
  monitoring:
    'Hearing the processed voice live while you talk. Use headphones — through speakers it feeds back into the microphone and howls.',
  pwa: 'Progressive Web App — once loaded, Voxwell is cached by a service worker and keeps working with the network off. Offline is proof nothing is being uploaded.',
};

let tooltipEl: HTMLElement | null = null;

/** Wire up click-to-define behaviour for any `.glossary-link[data-term]`. */
export function initGlossary(): void {
  document.addEventListener('click', (e) => {
    const target = (e.target as HTMLElement)?.closest('.glossary-link') as HTMLElement | null;
    if (target) {
      e.preventDefault();
      const term = (target.dataset.term || target.textContent || '').toLowerCase().trim();
      const def = GLOSSARY[term];
      if (def) showTooltip(target, def);
      return;
    }
    if (tooltipEl && !(e.target as HTMLElement)?.closest('.glossary-tip')) hideTooltip();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideTooltip();
  });
  window.addEventListener('scroll', hideTooltip, true);
}

function showTooltip(anchor: HTMLElement, text: string): void {
  hideTooltip();
  const tip = document.createElement('div');
  tip.className = 'glossary-tip';
  tip.textContent = text;
  document.body.appendChild(tip);
  const r = anchor.getBoundingClientRect();
  let left = r.left;
  const maxLeft = window.innerWidth - tip.offsetWidth - 12;
  if (left > maxLeft) left = Math.max(12, maxLeft);
  tip.style.top = `${r.bottom + 8}px`;
  tip.style.left = `${left}px`;
  tooltipEl = tip;
}

function hideTooltip(): void {
  tooltipEl?.remove();
  tooltipEl = null;
}
