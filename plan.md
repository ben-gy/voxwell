# Tool Plan: Voxwell

## Overview
- **Name:** Voxwell
- **Repo name:** voxwell
- **Tagline:** Change your voice in your browser — pitch, formant and effects, recorded and exported without an upload.

## Problem It Solves
Someone wants to change how their voice sounds and send the result to a person: a parent making a
"monster" voice note for a kid, someone prepping a prank for a group chat, a podcaster masking a
contributor's identity, a streamer auditioning a character voice, a person who needs to stay
anonymous in a voice message about something sensitive.

They search "voice changer online" and find a wall of sites that want the recording **uploaded** to a
server before they'll process it, half of which then watermark the output, gate the download behind a
sign-up, or keep the file. That is a bad trade for the anonymity case in particular — the whole point
was that nobody else should have the recording. And the *good* offline options (Audacity, a DAW) are
a 200 MB install and a 20-minute learning curve for something that should take ten seconds.

## Why This Must Be Client-Side
- **Privacy.** A voice recording is biometric. For the "I need to be unidentifiable" use case,
  uploading the original to a stranger's server defeats the entire exercise. Here the un-shifted
  audio never exists anywhere but in the tab.
- **Real-time interactivity.** You have to *hear* the effect while you talk to dial it in. A
  round-trip to a server makes live monitoring impossible; an `AudioWorklet` makes it ~16 ms.
- **No-account friction.** No sign-up, no watermark, no export credits.
- **Offline.** Once loaded it keeps working with the network off — the strongest possible proof that
  nothing is being uploaded.

## Browser APIs / Libraries Used
| API / Library | What it does for us | Fallback if unsupported |
|---------------|----------------------|-------------------------|
| `AudioWorklet` (custom processor) | Hand-written phase-vocoder pitch shifter + cepstral-style formant warping, running on the audio render thread | Hard requirement; a clear unsupported-browser message |
| `getUserMedia` (audio) | Live microphone input, requested from inside a tap | Denied/absent → the file-drop path, which is a first-class workflow |
| Web Audio native nodes | Ring modulator (`GainNode` audio-rate gain), `WaveShaperNode` drive, `BiquadFilterNode` radio band, `DelayNode` vibrato + echo, dry/wet `GainNode`s | N/A — universally supported |
| `OfflineAudioContext` | Renders a dropped file through the *identical* graph, far faster than real time, deterministically | N/A |
| Recorder `AudioWorkletProcessor` | Captures the processed signal as raw Float32 PCM (not a lossy container) | N/A |
| `AnalyserNode` + Canvas 2D | Live scope + input level meter so you can see you are not clipping | Meter hidden |
| Web Workers | WAV / MP3 encoding off the main thread | N/A |
| `@breezystack/lamejs` | MP3 encoding, locally, for a small shareable file | WAV always available |
| Web Share API (level 2, files) | Send the clip straight to Messages/WhatsApp on a phone | Download button |
| `MediaStreamTrack.stop()` | Kills the OS mic indicator the instant you stop | N/A |
| Service Worker | Offline app shell | Works online-only |

## Workflow (input → process → output)
1. **Input:** tap *Use microphone* (permission requested inside the tap) **or** drop/pick an audio
   file. Both land in the same editor.
2. **Process:** choose a preset (Chipmunk, Deep, Robot, Radio, Monster, Alien, Ghost, Giant…) or move
   the Pitch / Formant / Ring-mod / Drive / Wobble / Echo / Mix controls. Live mic monitors through
   headphones in real time; a dropped file re-renders offline on every change so the preview is
   always what you'll export.
3. **Output:** hit record (mic) or export (file) → a `.wav` or `.mp3` you can play back, download,
   share via the native share sheet, or copy.

## Non-Goals
- No cloud voice cloning / neural voice conversion — that needs a model and a GPU budget, and the
  ethics of a one-click clone are not something this tool wants to be part of.
- No multi-track editing, no timeline. Voxwell is one voice, one chain, one clip.
- No stereo processing — this is a voice tool; input is downmixed to mono and exported mono.
- No account, no cloud sync, ever.

## Target Audience
Anyone who wants their voice to sound like someone (or something) else and wants the result as a file
they can send. Emotional context: a dad on the sofa on a Saturday, phone in hand, trying to make his
seven-year-old laugh with a monster voice before bedtime — and, at the other end, someone recording a
message about a workplace problem who genuinely cannot have their voice recognised and cannot risk
the raw audio sitting in a stranger's S3 bucket. Both need it to work in ten seconds and neither
should have to trust anybody.

## Style Direction
**Tone:** playful but capable — a piece of studio gear that isn't intimidating.
**Colour palette:** near-black with a vivid electric-violet accent. Dark because this is a
creative/audio tool where the waveform and scope are the bright thing on screen; violet because it
reads as "audio/synth" without the tired green-terminal cliché, and it sits distinctly apart from the
amber of the sibling audio tool (Clipwell).
**UI density:** balanced — big obvious record button and preset tiles, compact parameter rows.
**Dark/light theme:** dark.
**Reference tools for feel:** Ableton's device racks (compact labelled parameter rows), Squoosh (a
single, honest input→output workflow with no chrome in the way).

## Technical Architecture
- **Stack:** Vanilla TypeScript + Vite. No React — this is one screen with one state machine.
- **Key libraries:** `@breezystack/lamejs` (MP3). Everything else is hand-written: the FFT, the phase
  vocoder, the spectral-envelope estimator, the WAV writer.
- **Worker strategy:** an `AudioWorklet` for the voice engine (audio render thread) and a second
  processor in the same module for PCM capture; a dedicated Web Worker for WAV/MP3 encoding.
- **Storage:** `localStorage` for the last-used preset and settings only. Never audio.

### The interesting bit — how the pitch/formant shifter works
A straight resample changes pitch *and* formants together (that's the chipmunk sound). Sounding like
a *different person* rather than a sped-up tape needs the two separated, so:

1. **Phase vocoder.** 1024-point Hann-windowed STFT at 4× overlap. Per bin, the true instantaneous
   frequency is recovered from the phase advance between frames; bins are mapped `k → k·p` with
   magnitude accumulation and the analysis frequency scaled by `p`; synthesis phases are integrated
   and overlap-added back. `p = 2^(semitones/12)`.
2. **Spectral envelope.** The input magnitude spectrum is smoothed with a log-width moving average
   (O(N) via a prefix sum) to estimate the vocal-tract envelope — where the formants are.
3. **Formant warp.** The pitch-shifted spectrum has envelope `E(j/p)`. To place formants at scale
   `s`, each output bin is multiplied by `E(j/s) / E(j/p)` (clamped). `s = p` → the classic chipmunk
   (formants ride along, gain is exactly 1 and the step is skipped); `s = 1` → pitch moves, formants
   stay, which is the natural-sounding shift; `s` free → an independent "bigger/smaller head" knob.

The engine is a plain TypeScript class with a `process(input, output)` method and no Web Audio
dependency, so the whole thing is unit-testable in Node: push a 440 Hz sine in, assert the dominant
output frequency is 880 Hz at +12 semitones.

## Privacy & Trust Model
**Protected**
- The microphone stream is processed frame-by-frame in the audio thread and discarded. Nothing is
  retained unless you press record.
- No recording, no dropped file, no exported clip is ever uploaded. There is no upload endpoint in
  the code.
- The mic track is stopped (`track.stop()`) the moment you stop, leaving the tool, or hiding the tab
  — the OS microphone indicator goes out.
- Monitoring is off until you turn it on, so nothing is played back into a room by surprise.
- Works fully offline once loaded.

**Not protected**
- The exported clip is an ordinary unencrypted audio file. Once you send it, it's out of your hands.
- Pitch-shifting is **not** anonymisation in a forensic sense. It defeats a casual listener
  recognising you; it does not defeat a determined analyst, and speech content, accent, cadence and
  background noise all survive.
- Whether a dropped file decodes depends on your browser's codecs.

**Trust surface**
- The static site bundle (hash-pinned by the GitHub Pages deploy) and the TLS chain to GitHub Pages.
- Your browser's Web Audio implementation and native decoders.
- A Cloudflare Web Analytics beacon (anonymous page views, cookie-less).
- Feedback you choose to send goes to feedback.benrichardson.dev, and only when you press Send.

## UX Required Surfaces
- Dual input surface: a big *Use microphone* button (permission on tap) plus a drag/drop/tap file
  zone, side by side — neither is a consolation prize.
- Determinate progress on export/render, with a live elapsed/level readout while recording.
- Event log drawer with an in-drawer `×` and Escape-to-close.
- How-It-Works modal (the vocoder explained in 5 steps).
- Privacy modal (Protected / Not protected / Trust surface), opened from a header button labelled
  "Privacy", including the honest "this is not forensic anonymisation" caveat.
- About modal with benrichardson.dev + lab.benrichardson.dev.
- Output: playback, download, Web Share, copy.
- Keyboard: Space = record/stop, Enter = export, Escape = close, 1–8 = presets.
- Sticky footer with attribution + feedback widget.
