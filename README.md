# Cutline

A private, browser-based video editor. Open the page and start editing — no account, no upload, no watermark. Media is decoded, edited, and encoded on your own device with WebCodecs and WebGL2, and projects are saved in the browser so they survive reloads and work offline after the first visit.

## What you can do

- **Import** video (MP4, MOV, WebM, MKV — H.264, HEVC where the browser supports it, VP8/VP9, AV1), audio (MP3, WAV, M4A/AAC, OGG/Opus, FLAC), images (JPG, PNG, WebP, AVIF, SVG, and animated GIF/WebP/APNG that loop), fonts (TTF/OTF/WOFF), SRT/VTT captions, and `.cutline` project files. Large files are usable within a fraction of a second; copying into local storage, audio analysis and thumbnails continue in the background. Phone footage with rotation metadata, variable frame rates, mixed resolutions and sample rates are handled. Damaged or unsupported files fail with a specific message instead of breaking the project.
- **Edit on a multi-track timeline**: move, trim, split, ripple/overwrite/insert edits, snapping, blade tool, duplicate (⌥/Alt-drag), copy/paste, nudge, freeze frames, markers, in/out range, track lock/hide/mute/volume, detach audio, undo/redo for everything.
- **Smart tools that run on your device**: noise reduction for voice recordings (spectral gating, three strengths), remove pauses (silence detection on the real audio), auto-ducking of music under speech (written as editable volume keyframes), frame-accurate scene detection that splits long recordings at each cut, and automatic captions.
- **Transform and animate**: position, scale, rotation, opacity, crop, flip, fit/fill, rounded corners, blend modes — directly on the canvas or in the inspector. Any numeric property (including effect parameters, color, volume and pan) can be keyframed with easing; text and layers also have in/out animation presets.
- **Text and graphics**: 24 bundled font families plus your own fonts, stroke, shadow, background boxes, letter spacing, wrapping, typewriter and word-by-word reveals, shapes, gradients and color backgrounds, adjustment layers.
- **Effects and color**: exposure/contrast/highlights/shadows/saturation/vibrance/temperature/tint/hue, one-click looks, blur, motion and zoom blur, sharpen, vignette, film grain, glow, RGB split, pixelate, posterize, VHS, border, black & white, sepia, duotone, color overlay, invert, mirror, wave, chroma key and luma key.
- **Transitions**: 18 GPU transitions (dissolves, dips, wipes, pushes, zoom, iris, clock, blur, pixelize, glitch, spin) between clips, with adjustable duration.
- **Audio**: unlimited audio tracks, clip and track volume in dB, pan, fades, keyframed volume, speed changes with pitch preservation, a live meter, scrubbing, and microphone voiceover recording straight onto the timeline.
- **Captions**: caption tracks with shared styling, SRT/VTT import and export, transcript paste, and **automatic captions** generated on your device (Whisper speech recognition, language detection or translation to English, per-word timing with optional karaoke highlighting).
- **Export** MP4 (H.264/AAC), WebM (VP9/Opus), MOV, M4A or WAV at the project size or lower, with quality presets, an in/out range, progress, cancel, and a still-frame PNG export. Exports are rendered by the same compositor and mixer as the preview. Audio stays in sync with the picture: the AAC encoder's start-up delay is measured and written into the file (an MP4 edit list), and WebM declares Opus's codec delay, so players line sound up to within a sample or two.
- **Projects**: autosave, multiple projects, duplicate, rename, crash/reload recovery, protection against editing the same project in two tabs, relinking of offline media, and portable `.cutline` packages with or without media. Project files are treated as untrusted: every field is checked and repaired on open, and if anything in a damaged file can't be recovered you're told how much.

## Privacy

Your media never leaves your device. There is no analytics or tracking. The only network requests after the app loads are the optional, one-time speech-model download from Hugging Face when you use automatic captions (the audio itself stays local). A strict Content-Security-Policy enforces this.

## Browser support

Cutline needs WebCodecs, WebGL 2, OffscreenCanvas, workers and IndexedDB, and shows a clear message when they're missing.

- **Chrome / Edge (desktop)** — primary target; the full test suite runs here. Fastest encoders, HEVC decode on most systems.
- **Safari (WebKit)** — the end-to-end suite also runs in WebKit (`npm run e2e:webkit`), apart from the tests that need persistent file storage or a microphone, which Playwright's WebKit doesn't provide. Exports pick an H.264 profile the encoder can actually produce. In Private Browsing, media and audio are kept in memory for the session and must be re-linked later.
- **Firefox** — implements the required APIs but has not been verified for this release.

Codec support is whatever the browser provides; unsupported codecs are reported at import time. Phones get a compact layout for quick edits; the full editor is designed for laptops and desktops.

## Development

```bash
npm install
npm run dev          # http://localhost:5173
npm run build        # production build in dist/
npm run preview      # serve the production build
npm test             # unit tests (Vitest)
npm run e2e          # end-to-end tests in real Chrome (Playwright)
npm run e2e:webkit   # the same suite in WebKit
```

The end-to-end tests drive the installed Google Chrome, import real media from `tests/fixtures`, edit through the UI, export, and verify the exported files independently with ffmpeg (stream layout, duration, pixel colors at known times, audio levels and pitch, and audio/video sync to within 4 ms). Unit tests include fuzzing of timeline edits and of corrupted project files, and in development every autosave checks that the saved project would reopen unchanged. The auto-caption test downloads the speech model; set `OFFLINE=1` to skip it. Run the suite against a production build with `E2E_BASE=http://localhost:4173 npx playwright test` while `npm run preview -- --port 4173` is running.

## Architecture

```
src/core      Project model, editing operations, keyframes, evaluation, captions, schema/migrations (pure TS, unit-tested)
src/engine    WebGL2 compositor, shaders, text/shape rasterizers, fonts, audio mixer (shared by preview and export)
src/media     Probing, frame-accurate video readers, conformed-PCM access, analysis client, runtime asset registry
src/playback  Preview player: audio-clock playback, latest-wins seeking, pre-roll
src/export    Export options and client; the renderer runs in workers/export.worker.ts
src/ai        On-device speech recognition (Whisper via ONNX Runtime Web) and caption grouping
src/state     Editor store (immer snapshots, gesture-coalesced undo), import pipeline, project lifecycle, actions
src/storage   IndexedDB (projects, thumbnails, waveforms) and OPFS (media and PCM)
src/ui        React UI: library panels, preview, inspector, timeline, dialogs
```

Key design decisions:

- **One rendering path.** `core/evaluate.ts` turns (project, time) into a fully resolved frame description; `engine/compositor.ts` draws it. The preview and the export worker both use these, so what you see is what you export.
- **Audio is "conformed" at import** (like professional NLEs): decoded once to 16-bit PCM in the origin-private file system, which makes seeking instant and lets one deterministic mixer (`engine/audioMixer.ts`) produce identical audio for playback and export — including pitch-preserving time stretching.
- **Frame-accurate decoding** with WebCodecs (via mediabunny), one reader per clip, latest-wins seeks, and bounded frame retention so hardware decoders never stall.
- **Local-first storage**: media is copied into OPFS, projects into IndexedDB, and unreferenced media is garbage-collected. A generated service worker caches the app shell for offline use.

## Deployment

`npm run build` produces a static site in `dist/` that can be hosted anywhere. Security headers (CSP, COOP, framing, permissions) and caching rules are provided for Netlify/Cloudflare Pages (`public/_headers`) and Vercel (`vercel.json`); the CSP is also embedded in `index.html`. The ONNX Runtime files used by auto-captions are self-hosted under `/ort/` and are only downloaded when that feature is used.

## Known limitations

- Codec support is whatever the browser's WebCodecs implementation provides; AVI/WMV/FLV containers and ProRes are not decodable in browsers and are reported as unsupported.
- HDR footage (for example iPhone HLG video) is converted to SDR; exports are SDR (BT.709).
- Exporting very long, high-resolution projects is bounded by the device's encoder speed; the export dialog shows a live estimate, and writing directly to disk is used for large files where the browser supports it.
- Automatic captions run on the CPU (WebAssembly); expect roughly real-time or faster on modern laptops.
