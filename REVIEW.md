# Voxwell — Build Review

This file exists only to create a reviewable PR. All code is already deployed on `main`.

**Merge this PR to acknowledge the build.** Closing without merging is also fine.

## Links

- **Custom domain:** https://voxwell.benrichardson.dev
- **GitHub Pages:** https://ben-gy.github.io/voxwell/ *(redirects to the custom domain)*

## DNS

Already created by the build (Cloudflare, `benrichardson.dev` zone):

| Type | Name | Target | Proxy |
|------|------|--------|-------|
| CNAME | `voxwell` | `ben-gy.github.io` | DNS only (grey cloud) |

If the TLS certificate has not issued yet, cycle the custom domain:

```bash
gh api repos/ben-gy/voxwell/pages -X PUT -f cname=""
sleep 3
gh api repos/ben-gy/voxwell/pages -X PUT -f cname="voxwell.benrichardson.dev"
```

## What to look at

- **The pitch engine** — `src/dsp/voice-engine.ts`. A phase vocoder with a spectral-envelope
  formant warp, no library. `src/dsp/fft.ts` is the radix-2 FFT it runs on.
- **The chain** — `src/graph.ts`. One builder used by both the realtime mic context and the offline
  file render, which is what guarantees preview == export.
- **Honesty check** — the Privacy modal says plainly that a shifted voice is *not* forensic
  anonymisation. Worth a read to confirm you are happy with that framing.

## Verification note

The automation cannot speak into a microphone, so **no real-device microphone check was possible**.
The engine, the whole effect chain and the export were verified in the browser with synthetic
samples through the identical code path, plus the file-drop path end to end and the
permission-denied fallback. Details in the build log.
