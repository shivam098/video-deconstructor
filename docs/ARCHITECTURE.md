# Technical Architecture — `video-deconstructor`

## 1. Problem Statement

General-purpose multimodal LLMs (such as **Gemini 4 Argon**, Claude Opus, and GPT-6) excel at spatial reasoning, visual design critique, and code/blueprint generation—but coding environments only expose **static file and image inspection tools** (`view`).

If you only extract a few random screenshots from a video, the model is blind to:
1. **Temporal continuity & motion physics:** Camera paths, Z-space parallax, object trajectories, and keyframe easing curves (ease-in, ease-out, overshoot/spring).
2. **Editorial rhythm:** Cut frequency, shot-length progression (accelerating cuts to build tension vs. long holds for comprehension), and match cuts.
3. **Audio-visual choreography:** How spoken words, music swells, risers, whooshes, and tactile foley (paper rustles, camera shutters, keyboard clicks) trigger visual state changes.
4. **Compositing & layer hierarchy:** How background textures (halftone dots, paper grain, vignettes), midground archival assets, and foreground kinetic typography are stacked and blended.

`video-deconstructor` solves this by translating a raw video file or YouTube stream into **five complementary visual and structured-text artifacts** specifically engineered for multimodal LLM context windows.

---

## 2. The Five Deconstruction Artifacts

Every run of `deconstruct_video_overview` creates a deterministic workspace folder (`<output-dir>/<video-id>/`) containing:

### Artifact 1: `manifest.json` & `pacing-metrics.json` (Editorial Telemetry)
Computed via `ffprobe` and `ffmpeg` scene-change filter (`select='gt(scene,0.25)',showinfo`):
- **Video Specs:** Title, channel/uploader, resolution, native frame rate, codec, duration, and chapter markers.
- **Cut List:** Array of every detected editorial cut `{ cutIndex, timestampSec, timestampHMS, sceneScore, shotDurationSec }`.
- **Pacing Summary:**
  - `totalCuts`
  - `averageShotLengthSec` (ASL)
  - `medianShotLengthSec`
  - `cutsPerMinute` (CPM)
  - `shotLengthDistribution`: buckets (`<1.5s fast/montage`, `1.5s–3.5s standard explainer`, `3.5s–7s graphic build`, `>7s deep sequence`)
  - `pacingByChapter`: how cut density changes from the Hook to the Body and Outro.

### Artifact 2: `av-timeline.md` (Two-Column Synced A/V Script)
Merges `yt-dlp` subtitles/auto-captions (`.vtt` / `.json3`) with the `ffmpeg` scene-cut list and chapter markers into a single readable Markdown table:

| Time (`MM:SS.ms`) | Audio / Narration | Visual Cut / Scene Event | Shot Length |
| :--- | :--- | :--- | :--- |
| `00:00.00` | *"Why do every airline's route maps look like this?"* | **[CUT #1]** Opening hook (`style-frames/scene_001.jpg`) | `2.4s` |
| `00:02.40` | *"In 1978, the US government..."* | **[CUT #2]** Archival newspaper highlight zoom (`scene_002.jpg`, score `0.48`) | `3.1s` |

This allows the LLM to see **exact word-to-cut choreography** before even opening an image.

### Artifact 3: `contact-sheets/sheet_NNN.jpg` (Timestamped Motion Grids)
Generated via `ffmpeg` filtergraph:
```text
fps=<sample_fps>,scale=480:-1,drawtext=text='%{pts\:hms}':x=8:y=8:fontsize=18:fontcolor=white:box=1:boxcolor=black@0.65,tile=4x4:padding=4:margin=4
```
- Each image shows **16 consecutive frames in a `4x4` grid** with the exact timestamp (`HH:MM:SS.mmm`) burned into the top-left corner of every tile.
- **Why `4x4` grids work for LLMs:** Instead of loading 16 separate tool calls, the model views one `1920x1080` composite image and immediately perceives **frame-to-frame motion deltas**:
  - Camera push-ins, pans, orbits, and 2.5D parallax depth separation.
  - How a chart draws itself over 3 seconds (axes $\rightarrow$ gridlines $\rightarrow$ data curve $\rightarrow$ callout highlight).
  - Keyframe spacing (large spatial jumps followed by tiny increments = ease-out deceleration).

### Artifact 4: `style-frames/scene_NNN.jpg` (Full-Resolution Craft & Layer Frames)
While `4x4` contact sheets compress each tile to `480px` width for motion tracking, `style-frames/` captures **unscaled (`1080p`/`4K`) single frames** at key scene transitions or requested timestamps.
- Enables inspection of:
  - **Typography:** Serif vs. grotesque sans-serif pairings, kerning, stroke outlines, drop shadows.
  - **Textures & Treatments:** Halftone dot patterns, paper creases, film grain, chromatic aberration,CRT scanlines, vignette falloff.
  - **Color System:** Background canvas tones (e.g., Vox warm off-white `#F4F1EA` or Bloomberg dark terminal slate), accent highlight colors, and contrast hierarchy.
  - **3D Rendering:** Material roughness, subsurface scattering, ambient occlusion, volumetric fog, and key/fill/rim lighting setup.

### Artifact 5: `audio-visual-strip/waveform_spectrum.png` (Sound Design Map)
Generated via `ffmpeg`:
- Top half: stereo/mono **amplitude waveform** (`showwavespic=s=1920x240:split_channels=0`) showing narration envelopes, transient SFX spikes (whooshes, hits, clicks), and silence gaps.
- Bottom half: **frequency spectrogram** (`showspectrumpic=s=1920x360:legend=1`) showing sub-bass drops, mid-range voice presence, and high-frequency risers/cymbal swells.

---

## 3. MCP Server Tool Specifications (`src/mcp-server.mjs`)

The MCP server communicates over `stdio` using JSON-RPC 2.0:

### `check_environment`
- **Arguments:** `{}`
- **Returns:** JSON status of `yt-dlp`, `ffmpeg`, and `ffprobe` binaries, versions, and OS-appropriate installation commands if any are missing.

### `deconstruct_video_overview`
- **Arguments:**
  - `source` (`string`, required): YouTube URL or local file path.
  - `output_dir` (`string`, optional): Custom output folder (defaults to `<os.tmpdir()>/video-deconstructor/<id>`).
  - `overview_fps` (`number`, optional, default `1`): Frame sampling rate for overview `4x4` contact sheets.
  - `scene_threshold` (`number`, optional, default `0.28`): `ffmpeg` scene-detection threshold (`0.15`–`0.50`).
  - `max_style_frames` (`number`, optional, default `12`): Maximum full-resolution style frames to extract automatically.
- **Returns:** Paths to `manifest.json`, `pacing-metrics.json`, `av-timeline.md`, `waveform_spectrum.png`, `contact-sheets/*.jpg`, and `style-frames/*.jpg`.

### `inspect_motion_or_transition`
- **Arguments:**
  - `source` (`string`, required): YouTube URL, local file path, or cached video ID.
  - `start_time` (`string` | `number`, required): Start timestamp (`MM:SS.ms` or seconds).
  - `end_time` (`string` | `number`, required): End timestamp (`MM:SS.ms` or seconds).
  - `fps` (`number`, optional, default `8`): High-density sampling rate (`4`–`15` FPS) to capture fast transitions and easing curves.
  - `grid` (`string`, optional, default `"4x4"`): Contact sheet layout (`"4x4"`, `"3x3"`, or `"2x2"`).
- **Returns:** High-FPS timestamped contact sheets and optional individual frames for the target window, plus an audio waveform slice for that exact transition.

### `extract_highres_style_frames`
- **Arguments:**
  - `source` (`string`, required): YouTube URL, local file path, or cached video ID.
  - `timestamps` (`array<string|number>`, required): List of exact timestamps to capture at native resolution.
- **Returns:** File paths to full-resolution `.jpg`/`.png` frames.
