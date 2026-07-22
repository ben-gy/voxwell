# voxwell

**Change your voice in your browser — pitch, formants and effects, exported as a file. Nothing is uploaded.**

Live: https://voxwell.benrichardson.dev

---

## what it is

Voxwell is a voice changer that runs entirely in a browser tab. Speak into your microphone, or drop
in a recording, and shift the pitch and the formants until you sound like someone (or something)
else — then walk away with a WAV or MP3 you can send to a person.

Search for "voice changer online" and you mostly find sites that want the recording **uploaded**
before they will touch it, then watermark the result or gate the download behind a sign-up. For the
one use case where this matters most — needing to be unidentifiable — uploading the original to a
stranger's server defeats the entire exercise. Voxwell has no upload endpoint. The unshifted audio
never exists anywhere except in the tab, and nothing is retained at all until you press record.

The interesting half is that pitch and formants move **independently**. A plain resample moves both
together, which is the sped-up-tape chipmunk sound. Leaving the formants where they are while the
pitch moves is what makes it sound like a different *person* rather than a fast version of you.

## how it works

```
  mic ─┐
       ├─► voice worklet ─ drive ─ ring ─ hp ─ lp ─ wobble ─┬─ wet ─┐
 file ─┘   (pitch/formant)                                  │       ├─ level ─ limiter ─► out
       └──────────────────── dry ─────────────────────────────────┘        │
                                                     echo (feedback) ──────┘
```

The pitch/formant stage is a hand-written phase vocoder running in an `AudioWorklet` on the audio
render thread:

1. **STFT.** 1024-point Hann-windowed frames at 4× overlap (hop 256), through a radix-2 FFT written
   for this tool.
2. **True frequency per bin.** The phase advance between consecutive frames, minus the advance a bin
   would have had at its nominal frequency, wrapped into (−π, π], gives each partial's real
   frequency — far more precise than the bin grid.
3. **Shift.** Bins are mapped `k → round(k·p)` with magnitude accumulation and frequency scaled by
   `p = 2^(semitones/12)`; synthesis phases are integrated per bin and the frames are windowed and
   overlap-added back. Duration is untouched — this is a pitch shift, not a resample.
4. **Spectral envelope.** The input magnitudes are smoothed by a moving average whose width grows
   with frequency (O(N) via a prefix sum) — an estimate of the vocal-tract envelope, i.e. where the
   formants are.
5. **Formant warp.** The shifted spectrum carries envelope `E(j/p)`. To place formants at scale `s`,
   each bin is multiplied by `E(j/s) / E(j/p)`, clamped. With `s = p` the gain is exactly 1 and the
   step is skipped (classic chipmunk); with `s = 1` the pitch moves and the formants stay.

Everything after that is native Web Audio: a ring modulator (an oscillator summed into a gain's
`gain` param, so it is a true multiplication rather than tremolo), a soft-clip drive, a 380–3200 Hz
telephone band, an LFO-modulated delay for vibrato, a feedback delay for echo, a dry/wet blend, and
a soft-limiter WaveShaper that is exactly transparent below 0.75 and rides peaks smoothly up to full
scale — so a hot preset can never hard-clip the export.

A dropped file is rendered through the **identical** graph in an `OfflineAudioContext`, far faster
than real time, and the engine's 768-sample latency is trimmed off the front. That is why the
preview you hear is byte-for-byte the file you export.

Recording captures raw Float32 PCM from a second worklet processor — not a lossy container — so the
WAV is exact and the MP3 starts from clean samples.

## browser APIs used

- **AudioWorklet** — the pitch/formant engine and the PCM recorder, on the audio render thread
- **getUserMedia** — live microphone, requested only from inside a tap, never on load
- **Web Audio nodes** — `GainNode` ring modulator, `WaveShaperNode` drive and limiter,
  `BiquadFilterNode` radio band, `DelayNode` vibrato and echo
- **OfflineAudioContext** — deterministic, faster-than-real-time rendering of dropped files
- **AnalyserNode + Canvas 2D** — live scope and input level meter
- **Web Workers** — WAV/MP3 encoding off the main thread
- **Web Share API (level 2)** — hand the clip straight to a chat app on a phone
- **MediaStreamTrack.stop()** — release the mic (and extinguish the OS indicator) on stop, navigation
  or tab hide
- **Service Worker** — offline app shell

## security / privacy model

**Protected**

- The microphone stream is processed frame by frame and discarded. Nothing is kept unless you press
  record, and nothing is uploaded — there is no upload endpoint in the code.
- Dropped files are read straight into the tab. Neither they nor the exported clip leave the device.
- The mic track is stopped the moment you stop, leave the page or hide the tab.
- Monitoring is off until you switch it on.
- No account, no cookies for your data, no third-party fonts. Works fully offline once loaded.

**Not protected**

- **A shifted voice is not anonymity.** It defeats a casual listener recognising you; it does not
  defeat a determined analyst. Speech content, accent, cadence, vocabulary and background noise all
  survive the shift, and pitch shifting is reversible. If your safety depends on not being
  identified, do not rely on this alone.
- The exported clip is an ordinary, unencrypted audio file.
- Whether a given file decodes depends on your browser's built-in codecs.

**Trust model**

- The static site bundle (hash-pinned by the GitHub Pages deploy) and the TLS chain to GitHub Pages.
- Your browser's Web Audio implementation and native audio decoders.
- A Cloudflare Web Analytics beacon (anonymous, cookie-less page views — your voice is never sent).
- Feedback you choose to send goes to feedback.benrichardson.dev, and only when you press Send.

## stack

- Vite 6 + vanilla TypeScript
- `@breezystack/lamejs` for MP3 — everything else (FFT, phase vocoder, envelope estimator, WAV
  writer) is written for this tool
- Vitest for unit tests — 70 cases, including asserting that a 440 Hz tone comes out at 880 Hz at
  +12 semitones and at 220 Hz at −12
- GitHub Pages for hosting, deployed via GitHub Actions

No cookies, no fingerprinting, no third-party fonts. Anonymous, cookie-less page-view counts via
Cloudflare Web Analytics — no personal data, no cross-site tracking.

## local development

```bash
npm install
npm run dev      # vite dev server on :5173
npm test         # run vitest suite
npm run build    # produce dist/ for deploy
npm run preview  # serve dist/ locally
```

The voice worklet is emitted through Vite's worker pipeline (`?worker&url`) so it lands as a single
self-contained ES module. That matters: AudioWorklet module resolution for relative imports is not
dependable across browsers, and the emitted file must therefore have no imports of its own.

## license

[GNU Affero General Public License v3.0 or later](./LICENSE), with an attribution
requirement added under section 7(b) — see
[ADDITIONAL-TERMS.md](./ADDITIONAL-TERMS.md).

In short: you may run, modify, redistribute and even sell this, but if you
distribute it — or run a modified version where other people can reach it — you
have to publish your source under the same licence and keep the attribution. A
separate commercial licence without those obligations is available on request:
<hi@ben.gy>.

Third-party components keep their own licences — see
[THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md).
