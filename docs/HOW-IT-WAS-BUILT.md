# How it was built

This document records how `video-deconstructor` was designed, built and validated, including the problems found along the way. Use it to understand the design decisions or to build something similar.

## 1. Goal

Make any multimodal model (Gemini, Claude, GPT) able to explain **how a video was made**: editing rhythm, how narration drives the picture, the visual design system, how animations and transitions are built, and how sound supports the cut. The tool had to:

- work in coding agents (GitHub Copilot, Claude Code, Cursor, VS Code) where the model can only read text and images, not play video;
- need no paid API keys;
- run on Windows, macOS and Linux;
- be usable as an MCP server, a CLI and a reusable agent skill.

## 2. Key design decisions

| Decision | Why |
| --- | --- |
| **Convert video into images and text, not frames alone.** | A handful of random screenshots loses timing. Timestamped contact sheets show motion as a sequence; the A/V timeline and audio strip carry rhythm and sound, which images can't. |
| **4x4 timestamped contact sheets.** | One image shows 16 consecutive moments, so a model sees motion and pacing in a single view instead of 16 separate calls. Burned-in absolute timestamps let it cite exact moments. |
| **Separate full-resolution style frames.** | Contact-sheet tiles are small (480 px). Typography, textures and lighting need native resolution. |
| **Audio strip with cut markers.** | Shows sound and edit together: where cuts land relative to narration, music drops and hits. |
| **Three-pass workflow (overview, style, zoom).** | Mirrors how an editor studies a film: structure first, then look, then the technique of specific moments. Pass 3 is targeted with `motionHotspots`, so context isn't spent on uniform high-fps sampling of the whole video. |
| **Node.js with zero npm dependencies.** | `npx`/`node` is already present wherever MCP clients run; no install step, no supply-chain surface. The MCP stdio protocol is small enough to implement directly (~100 lines). |
| **One engine, three front-ends.** | `engine.mjs` does all the work; the CLI, MCP server and skill are thin layers, so behaviour is identical everywhere. |
| **Absolute timestamps everywhere.** | Section downloads start at an offset; converting internally means every artifact refers to positions in the original video, which are the times a user sees on YouTube. |
| **Pure functions for analysis.** | Cut detection, pacing, activity, caption parsing and the timeline are pure, so they are unit-tested without ffmpeg. |

## 3. Build steps

1. **Planning.** Defined the artifact set (A/V timeline, pacing metrics, contact sheets, style frames, audio strip) and the three-pass skill.
2. **Engine.** Implemented acquisition via yt-dlp with caching and section downloads, a single ffmpeg analysis pass, metrics, and the renderers.
3. **CLI and MCP server.** Added `doctor`, `overview`, `zoom`, `frames` and `mcp` commands, with four MCP tools mapped onto the same functions.
4. **Tests.** Unit tests for every pure function. Pipeline tests that generate a synthetic 5 s video with ffmpeg (a test pattern, a hard cut, a white card, a 0.5 s wipe to black, a 1 s audio gap and sidecar captions) and check that every artifact and measurement is right. An MCP test drives the server over stdio with JSON-RPC.
5. **Real-world validation.** Ran six YouTube videos across different genres (see [TEST-RESULTS.md](TEST-RESULTS.md)) and inspected the generated images by eye.
6. **Fixes from validation**, described below.

## 4. Problems found and how they were fixed

### Windows: yt-dlp blocked by Application Control

**Symptom:** `yt-dlp.exe - Bad Image ... ucrtbase.dll / python314.dll ... Error status 0xc0e90002`.

**Cause:** `0xC0E90002` is `STATUS_SYSTEM_INTEGRITY_POLICY_VIOLATION`. yt-dlp's Windows build is a PyInstaller bundle that unpacks Python's DLLs into `%TEMP%\_MEIxxxx` at startup. The device's Code Integrity policy (WDAC / Smart App Control) refused to load unsigned DLLs from `%TEMP%`. Event log `Microsoft-Windows-CodeIntegrity/Operational`, events 3033/3077, confirmed it. This affected both the x64 and the ARM64 build, so the architecture was not the cause.

**Fix:** the tool runs yt-dlp with `TMP`/`TEMP` pointed at `<cache>/runtime-tmp`, outside `%TEMP%`. Tests on this machine confirmed yt-dlp then starts normally. If a stricter policy also blocks that folder, install yt-dlp as a Python package (`pip install yt-dlp`); the tool falls back to `python -m yt_dlp`.

### Windows ARM64: crashing ffmpeg nightly first on PATH

**Symptom:** `ffmpeg -version` exited with `0xC0000005` (access violation) and printed nothing.

**Cause:** `winget install yt-dlp.yt-dlp` pulls in `yt-dlp.FFmpeg`, a nightly ARM64 build that crashed on start on this device. It was the first `ffmpeg` on `PATH`.

**Fix:** installed the stable `Gyan.FFmpeg` build and made binary discovery **run every candidate** before choosing it. Broken builds are skipped and reported by `doctor`:

```text
OK   ffmpeg 9.0.2-full_build-www.gyan.dev  (...Gyan.FFmpeg...\ffmpeg.exe)
     skipped ...yt-dlp.FFmpeg...\ffmpeg-N-127043-...-winarm64-gpl\bin\ffmpeg.exe: exit 0xC0000005
```

The tool also searches well-known install folders, because MCP clients often launch servers with a stale `PATH` right after an install.

### Gradual transitions were invisible to cut detection

**Symptom:** a diamond-shaped wipe in the Vox video (about 28.6-29.6 s) was not detected as a cut.

**Cause:** scene-change scoring compares consecutive frames. A wipe changes the image a little on every frame, so no single frame crosses the threshold.

**Fix:** a second analysis branch compares frames **0.25 s apart**. In the Vox video the wipe scores 0.46 on that branch. Changes above `soft_threshold` (0.35) with no hard cut nearby are reported as **soft transitions** and marked orange on the audio strip.

### Motion was reported as "static" for smooth animation

**Symptom:** Kurzgesagt (constantly moving animation) reported 76 % static; 3Blue1Brown reported 90 %.

**Cause:** ffmpeg's scene score is `min(MAFD, |MAFD - previous MAFD|)`. It reacts to a *change in the amount of change*, so steady motion scores near zero. It is right for cut detection and wrong for measuring motion. Per-frame values also shrink at 60 fps.

**Fix:** switched both analysis branches to ffmpeg's `scdet` filter, which also emits **MAFD** (mean absolute frame difference). Visual activity is now MAFD between frames 0.25 s apart, independent of frame rate. Calibration across the test videos (median MAFD %): 3Blue1Brown 0.05, Kurzgesagt 2.1, *Spring* 2.2, Bloomberg 3.0, Vox 4.7. The metric was renamed `lowMotionShare`, because small elements moving on a plain background (3Blue1Brown) legitimately measure as low motion. `scdet` scores are converted to the `select` scale (x 2.56 / 100) so the cut thresholds keep their meaning.

The zoom tool's per-frame motion curve now uses MAFD too. A rising-then-falling curve reads directly as ease-in/out.

### One-shot videos got a single style frame

**Symptom:** 3Blue1Brown's first two minutes contain no cuts (Manim morphs one continuous canvas), so only one style frame was captured.

**Fix:** style-frame sampling now adds extra frames inside long shots, at least 4 s apart, up to `max_style_frames`.

### Smaller fixes

- The cache key lower-cased YouTube IDs, which are case-sensitive. The original case is now kept.
- The test video's `xfade` needed matching time bases (`fps=25,settb=1/25`) on both inputs.
- A synthetic bars-to-red wipe scored too low to stand in for real transitions; the fixture now uses a high-contrast white-to-black wipe.

### Fixes from code review

An independent review pass before publishing found four issues, all fixed and covered by tests or live runs:

- **Non-YouTube URLs never used the cache.** Each call re-fetched metadata and reset the recorded downloads. The tool now keeps `media/url-index.json` and reuses an existing `source.json`. Verified with a direct-file URL (Blender's *Big Buck Bunny* trailer): the second call reused the cached file.
- **The audio strip drew only the first 200 cuts and 50 silences**, which would have shown later parts of long, fast-cut videos as cut-free. Every marker is now drawn, merged per pixel column. Graphs over 8,000 characters go through a script file to stay under the Windows command-line limit; a test draws 700 cuts and 300 silences.
- **`-fps_mode` was used on ffmpeg 5.0**, which only gained it in 5.1. The version check now includes the minor version.
- **ARCHITECTURE.md still described the earlier `select`-based analysis.** It now documents `scdet`, the score conversion and the MAFD units.

The same live test also showed that single-file sources keep their own container (here `.ogg`), so downloaded files are now matched by name, not by a fixed list of extensions.

## 5. Known limitations

- **Section downloads re-encode.** Accurate section boundaries need `--force-keyframes-at-cuts`, which re-encodes the clip. A 2-minute 1080p section took about 3-4 minutes on the test machine (Windows on ARM running x64 ffmpeg under emulation). For short videos, a full download (no `--start`/`--end`) is faster.
- **Cut detection is heuristic.** Very fast motion can register as a soft transition, and long dissolves can be missed. Thresholds are adjustable (`scene_threshold`, `soft_threshold`).
- **Captions:** English uploader subtitles are preferred, then YouTube auto-captions, then a local Whisper transcript (if a model is installed).
- **Gemini** is only as good as Google's sampling (1 fps by default) and is not a measurement; the local cut and pacing data stays the reference. It sends media to Google.
- **Tool attribution is inference.** The skill tells the model to label software and technique guesses as inferences.

## 6. Optional add-ons (added after the first release)

**Whisper.** While checking options, `ffmpeg -filters` showed that this machine's ffmpeg 9 already includes the `whisper` filter (whisper.cpp), so local transcription needed no new binary, only a model file. A first run with `tiny.en` transcribed 30 s in 3.3 s but misheard "school-to-prison pipeline" as "school-depressant pipelines". The default became `base.en`, which transcribed 60 s in 5.4 s and closely matched the uploader's subtitles. Caption parsing gained a `rolling: false` mode so Whisper's legitimately repeated lines aren't dropped by the YouTube rolling-caption de-duplication. The Whisper `language` value is validated because it is interpolated into the filter string.

**Gemini.** Google's current API is the Interactions API (`/v1beta/interactions`) with typed inputs. YouTube URLs are in preview at no charge, with a free-tier cap of 8 hours of YouTube video per day. The client is dependency-free, using `fetch` and streaming uploads. It was tested against a mock server that checks headers, upload size, polling and request bodies, because no key was available during development. On the free tier, Google may use submitted content, so the tool is opt-in, the MCP tool description says so, and the skill tells agents to ask first.

**npx from GitHub.** Publishing to the public npm registry was not possible from the build machine (the corporate network routes npm to an internal feed and blocks `registry.npmjs.org`). `npx github:shivam098/video-deconstructor` was verified instead and documented.

**Second code review.** A review of the add-ons found five issues, all fixed and covered by tests:
1. A Whisper failure in `auto` mode aborted the whole overview. It now adds a note instead, and only `always` fails.
2. ffmpeg filter values dropped apostrophes, which broke paths such as `/Users/o'neil`. Values now use ffmpeg's two-level escaping instead of quoting; labels on sheets and strips were re-checked by eye.
3. The Gemini MP4-conversion cache was keyed only by file name, and partial files could be reused. It is now keyed by path, size and mtime, and written atomically.
4. `zoom` could pick a newer transcript that only partly covered the window. It now prefers full coverage, then the largest overlap.
5. Gemini results for YouTube links were saved to a shared folder instead of the video's run folder.

## 7. Possible extensions

- Colour palette extraction (k-means on style frames) into `pacing-metrics.json`.
- OCR of on-screen text to recover titles, labels and chart annotations.
- Faster section downloads (stream copy, then trim by measured offset).
- Publishing to the npm registry.
