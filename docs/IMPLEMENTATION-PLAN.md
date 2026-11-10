# Implementation & Verification Plan — `video-deconstructor`

## Objective
Deliver a zero-API-key, cross-platform open-source toolkit (**Node.js ESM CLI + MCP Server + Agent Skill**) that enables **Gemini 4 Argon** (and any multimodal LLM in GitHub Copilot, Claude, Cursor, or VS Code) to deconstruct how any video is produced.

---

## Phase 1: Repository & Documentation Foundation (Current)
- [x] Define the 5-artifact video deconstruction architecture (`docs/ARCHITECTURE.md`).
- [x] Author the 3-Pass Video Production Deconstructor Skill (`skills/video-production-deconstructor/SKILL.md`).
- [x] Document installation, CLI usage, and MCP configuration (`README.md`).
- [x] Publish repository to `github.com/shivam098/video-deconstructor`.

---

## Phase 2: System Prerequisites Setup
Install open-source media binaries via platform package managers:
- **Windows:** `winget install yt-dlp.yt-dlp Gyan.FFmpeg`
- **macOS:** `brew install yt-dlp ffmpeg`
- **Linux:** `sudo apt install yt-dlp ffmpeg`

---

## Phase 3: Cross-Platform Extraction Engine (`src/`)
1. **`src/engine.mjs` — Binary Discovery & Media Acquisition:**
   - Cross-platform resolution of `yt-dlp`, `ffmpeg`, and `ffprobe` (`PATH` lookup + common Windows `WinGet\Links` / `Program Files` and macOS `/opt/homebrew/bin` fallback paths).
   - Smart video caching in `<tmpdir>/video-deconstructor/<video-id>/` so follow-up motion zooms (`inspect_motion_or_transition`) run instantaneously against the cached `.mp4` without re-downloading.
   - Subtitle/auto-caption retrieval (`--write-subs --write-auto-subs --sub-Format vtt/json3 --dump-single-json`).
2. **`src/metrics.mjs` — Editorial Cut & Pacing Analyzer:**
   - Runs `ffmpeg` scene detection (`select='gt(scene,threshold)',showinfo`) to extract every cut timestamp and scene-change score.
   - Computes Average Shot Length (ASL), Median Shot Length, Cuts Per Minute (CPM), and shot-length distribution buckets.
3. **`src/timeline.mjs` — Two-Column A/V Script Generator:**
   - Parses WebVTT/SRT captions, deduplicates rolling auto-caption lines, and merges them chronologically with detected visual cuts and chapter markers into `av-timeline.md`.
4. **`src/engine.mjs` — Visual & Audio Artifact Renderers:**
   - **Overview & High-FPS Motion Contact Sheets:** `fps=<N>,scale=480:-1,drawtext=pts,tile=4x4`.
   - **Full-Res Style Frames:** Unscaled keyframes at scene cuts or user-specified timestamps.
   - **Audio Waveform & Spectrogram Strip:** `showwavespic` + `showspectrumpic` composite image (`waveform_spectrum.png`).

---

## Phase 4: Dual Interface (`bin/cli.mjs` & `src/mcp-server.mjs`)
1. **CLI Commands (`bin/cli.mjs`):**
   - `doctor` — Checks `yt-dlp`, `ffmpeg`, and `ffprobe` installation.
   - `overview <url-or-path>` — Runs full Pass 1 & Pass 2 extraction.
   - `zoom <url-or-path> --start <t1> --end <t2> --fps <n>` — Runs Pass 3 high-FPS transition/motion zoom.
   - `frames <url-or-path> --timestamps <t1,t2,...>` — Extracts full-res style frames.
   - `mcp` — Starts the `stdio` JSON-RPC 2.0 MCP server.
2. **Plugin Manifest (`plugin.json`):**
   - Bundles the `video-production-deconstructor` skill and MCP server definition for one-step installation.

---

## Phase 5: Local Copilot Registration & End-to-End Verification
1. Register `"video-deconstructor"` in `~/.copilot/mcp-config.json`.
2. Link `skills/video-production-deconstructor` into `~/.copilot/skills/`.
3. Run automated smoke tests (`node --test test/smoke.test.mjs`) using a synthetic multi-scene test video generated via `ffmpeg` (`testsrc2` + `sine` audio) and verify all 5 output artifacts + MCP tool calls.
