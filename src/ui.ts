// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Ben Richardson — https://benrichardson.dev
// Additional terms under AGPL-3.0 section 7(b) apply; see ADDITIONAL-TERMS.md.
/**
 * UI chrome — modal content, modal management and transient toasts.
 * Modal bodies live here and are injected lazily; `main.ts` wires the openers.
 */

interface ModalDef {
  title: string;
  body: string;
}

/** A glossary-linked term. `label` is shown; `term` keys into GLOSSARY. */
function g(label: string, term = label): string {
  return `<span class="glossary-link" data-term="${term.toLowerCase()}" role="button" tabindex="0">${label}</span>`;
}

const MODALS: Record<string, ModalDef> = {
  how: {
    title: 'How Voxwell works',
    body: `
      <ol class="steps">
        <li><strong>Sound comes in.</strong> Either live from your microphone — asked for only when you tap the button, never on load — or from a file you drop in. Neither is uploaded: there is no upload endpoint in the code.</li>
        <li><strong>An ${g('AudioWorklet')} takes it apart.</strong> Your own code runs on the browser's real-time audio thread, cutting the sound into overlapping 1024-sample windows and turning each into its frequencies with an ${g('FFT', 'fft')}.</li>
        <li><strong>A ${g('phase vocoder')} moves the pitch.</strong> The true frequency of every component is recovered from how its phase advanced since the last window, all of them are multiplied by 2^(semitones/12), and the windows are stitched back together — so the pitch changes but the speed does not.</li>
        <li><strong>The ${g('spectral envelope')} decides who you sound like.</strong> Your ${g('formant', 'formant')}s — the resonances of your throat and mouth — are measured separately and can be left where they are (you, higher) or dragged along with the pitch (a chipmunk). That is the difference between a different <em>person</em> and a sped-up tape.</li>
        <li><strong>Character effects finish the job.</strong> A ${g('ring modulator')}, a soft-clip drive, a telephone band, a vibrato and an echo — all ordinary Web Audio nodes, all local.</li>
        <li><strong>You leave with a file.</strong> The processed signal is captured as raw ${g('PCM')} and written to a ${g('WAV')} or ${g('MP3')} right here. Download it, or send it straight to a chat with the share button.</li>
      </ol>
      <p class="modal-note">A dropped file is rendered through the identical chain in an ${g('OfflineAudioContext')}, so what you preview is exactly what you export. Loaded once, Voxwell keeps working offline as a ${g('PWA')} — the strongest proof there is no server involved.</p>
    `,
  },
  threat: {
    title: 'Privacy &amp; threat model',
    body: `
      <div class="tm">
        <section>
          <h4 class="tm-good">Protected</h4>
          <ul>
            <li>The microphone stream is processed frame by frame on the audio thread and thrown away. <strong>Nothing is kept unless you press record</strong>, and nothing is ever uploaded — there is no upload endpoint anywhere in the code.</li>
            <li>Dropped files are read straight into the tab. They are not sent anywhere, and neither is the clip you export.</li>
            <li>The microphone track is stopped the moment you stop recording, leave the page or hide the tab — your operating system's microphone indicator goes out.</li>
            <li>${g('Monitoring')} is off until you switch it on, so nothing is played back into a room by surprise.</li>
            <li>No account, no cookies for your data, no third-party fonts. Once loaded the tool runs fully offline.</li>
          </ul>
        </section>
        <section>
          <h4 class="tm-warn">Not protected</h4>
          <ul>
            <li><strong>A shifted voice is not anonymity.</strong> It defeats a casual listener recognising you. It does not defeat a determined analyst: speech content, accent, cadence, vocabulary and background noise all survive the shift, and pitch shifting is reversible. If your safety depends on not being identified, do not rely on this tool alone.</li>
            <li>The exported clip is an ordinary, unencrypted audio file. Once you send it, it is out of your hands.</li>
            <li>Whether a particular file decodes at all depends on your browser's built-in codecs — an honest error is shown when one can't be read.</li>
          </ul>
        </section>
        <section>
          <h4 class="tm-info">Trust surface</h4>
          <ul>
            <li>The static site bundle (hash-pinned by the GitHub Pages deploy) and the TLS chain between you and GitHub Pages.</li>
            <li>Your browser's Web Audio implementation and its native audio decoders.</li>
            <li>A Cloudflare Web Analytics beacon records anonymous page views — no cookies, no fingerprinting, no cross-site tracking; your voice is never sent to it.</li>
            <li>Feedback you choose to send (and an email address, only if you supply one) is sent to feedback.benrichardson.dev. Nothing is sent unless you open the feedback form and press Send; your recordings never are.</li>
          </ul>
        </section>
      </div>
    `,
  },
  about: {
    title: 'About Voxwell',
    body: `
      <p>Voxwell is a free, in-browser voice changer. Speak into it or drop in a recording, move the pitch and formants until you sound like someone else, and walk away with a WAV or MP3 — without installing anything, creating an account, or uploading a single byte.</p>
      <p>The pitch engine is not a library: it is a phase vocoder with formant correction written for this tool and running in an AudioWorklet on the audio thread. That is why it can be both live and local.</p>
      <ul class="about-links">
        <li><a href="https://benrichardson.dev/" target="_blank" rel="noopener">benrichardson.dev</a> — who made this</li>
        <li><a href="https://lab.benrichardson.dev" target="_blank" rel="noopener">lab.benrichardson.dev</a> — the full directory of tools &amp; sites</li>
        <li><a href="https://github.com/ben-gy/voxwell" target="_blank" rel="noopener">Source on GitHub</a> — read exactly what it does</li>
      </ul>
      <p class="modal-note">No cookies for your data · no fingerprinting · no third-party fonts · anonymous, cookie-less page-view counts via Cloudflare Web Analytics.</p>
    `,
  },
};

let overlay: HTMLElement | null = null;

export function initModals(): void {
  overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <div class="modal-head">
        <h3 id="modal-title"></h3>
        <button class="modal-close" type="button" aria-label="Close">&times;</button>
      </div>
      <div class="modal-body"></div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || (e.target as HTMLElement).closest('.modal-close')) closeModal();
  });
}

export function openModal(id: keyof typeof MODALS | string): void {
  const def = MODALS[id];
  if (!def || !overlay) return;
  (overlay.querySelector('#modal-title') as HTMLElement).innerHTML = def.title;
  (overlay.querySelector('.modal-body') as HTMLElement).innerHTML = def.body;
  overlay.hidden = false;
  (overlay.querySelector('.modal-close') as HTMLElement)?.focus();
}

export function closeModal(): void {
  if (overlay) overlay.hidden = true;
}

export function isModalOpen(): boolean {
  return !!overlay && !overlay.hidden;
}

let toastTimer: number | null = null;
export function toast(message: string, kind: 'info' | 'ok' | 'err' = 'info'): void {
  let el = document.querySelector('.toast') as HTMLElement | null;
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.dataset.kind = kind;
  el.classList.add('show');
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el?.classList.remove('show'), 3200);
}
