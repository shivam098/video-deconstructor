---
name: video-production-deconstructor
description: Reverse-engineer how any YouTube or local video is made—including Vox and Bloomberg explainers, 2D/2.5D motion graphics, 3D animations, kinetic typography, data visualizations, editorial pacing, sound design sync, and transitions. Use whenever asked to analyze a video's production style, animation techniques, editing rhythm, visual craft, or how to recreate a video.
---

# Video Production & Craft Deconstructor (`video-production-deconstructor`)

Use this skill to deconstruct **how any video was created**—across narrative structure, editorial pacing, audio-visual synchronization, graphic design/layer composition, 2D/2.5D/3D motion mechanics, and sound design—using the local `video-deconstructor` MCP tools or CLI together with the `view` tool.

---

## Core Principle: Never Guess From Metadata Alone

A video's craft lives in the **relationship between time, motion, layer depth, and sound**. Always inspect the generated visual and timeline artifacts in **three structured passes**:

1. **Pass 1 — Macro Editorial, Narrative & Sound Architecture** (`av-timeline.md` + `pacing-metrics.json` + `waveform_spectrum.png` + `1 FPS` overview contact sheets)
2. **Pass 2 — Visual Direction, Typography & Layer Stack** (Full-resolution `style-frames/scene_NNN.jpg`)
3. **Pass 3 — Micro Motion, Camera Rigs & Transition Physics** (`6–15 FPS` high-density contact sheets via `inspect_motion_or_transition`)

---

## Step-by-Step Workflow

### Pass 1: Macro Editorial, Pacing & Audio-Visual Sync

1. **Run Overview Extraction:**
   - Call the MCP tool `deconstruct_video_overview` (or run `node bin/cli.mjs overview "<url-or-path>"`).
2. **Read `pacing-metrics.json` and `av-timeline.md`:**
   - Note the **Average Shot Length (ASL)**, **Cuts Per Minute (CPM)**, and **shot-length distribution**.
   - Study the **2-column A/V Timeline** to see how spoken words trigger visual cuts (e.g., cutting *on* the keyword vs. cutting *0.2s before* the keyword with an audio pre-lap / J-cut).
3. **View `audio-visual-strip/waveform_spectrum.png` and the Overview Contact Sheets (`contact-sheets/sheet_*.jpg`):**
   - Use `view` on `waveform_spectrum.png` to spot **transient SFX spikes** (whooshes, paper foley, bass drops, risers) and **music dropouts/pauses** (e.g., the signature Vox/Johnny Harris 1-second music cut right before the thesis reveal).
   - Use `view` on the `4x4` overview contact sheets to map the **Visual Modality Breakdown**:
     - What percentage is **Archival B-Roll / Footage** vs. **2.5D Paper/Photo Parallax** vs. **Data Visualization / Charts** vs. **Map Flyovers (GeoLayers)** vs. **Full 3D / Character Animation** vs. **Talking Head / A-Roll**?

---

### Pass 2: Visual Direction, Design System & Compositing Layer Stack

Use `view` on the full-resolution `style-frames/scene_*.jpg` (or call `extract_highres_style_frames` at key timestamps) to reverse-engineer the visual design system:

1. **Canvas & Texture Stack (Bottom-to-Top Layer Order):**
   - **Background Layer:** Solid color, paper/cardstock texture, grid/dot matrix, dark gradient, or blurred archival plate?
   - **Midground Elements:** Cutout photos (smooth alpha vs. torn-paper edge vs. thick white sticker stroke), newspaper clippings with animated highlighter strips (multiply blend mode), or 3D geometry?
   - **Foreground / HUD:** Kinetic typography, annotation arrows, callout boxes, lower thirds, or chart labels.
   - **Post-Processing / Adjustment Layers:** Halftone shading, film grain/noise, vignette, subtle camera shake (wiggle expression), chromatic aberration, or glow/bloom.
2. **Color Palette & Contrast:**
   - Identify the exact functional color roles: **Base Canvas**, **Primary Text/Ink**, **Muted Context Layer** (desaturated/low-opacity background elements), and **Hero Accent Color** (e.g., Vox yellow `#FFF200`, Bloomberg terminal amber/cyan/magenta) used to direct the viewer's eye.
3. **Typography & Data-Viz Craft:**
   - Identify font classifications (condensed grotesque headline, editorial serif quote, monospace data/timestamp label).
   - How is complexity managed in charts? (Progressive disclosure: dimming historical lines while highlighting a single series; direct line labels instead of cluttered legends).

---

### Pass 3: Micro Motion, Camera Rigs & Transition Physics

Select **2 to 4 signature transitions or complex animations** from Pass 1 and call `inspect_motion_or_transition` (or `node bin/cli.mjs zoom`) with `fps: 8` to `12` over a `2–6 second` window. Then `view` the high-FPS contact sheet and analyze:

1. **Camera Rig & Spatial Mechanics:**
   - **2D Flat Pan/Zoom:** Uniform scaling of all elements together.
   - **2.5D Multiplane Parallax (After Effects 3D Layers):** Foreground cutouts move faster across the frame than the background canvas as the virtual camera dollys/trucks or orbits (`Z-depth` separation + shallow depth-of-field blur).
   - **True 3D Scene (Blender / Cinema 4D / Unreal):** Perspective foreshortening on 3D meshes, dynamic shadow casting, shader/lighting changes, or procedural geometry nodes.
   - **Map Engine (GeoLayers 3 / Mapbox):** 3D terrain pitch/bearing rotation, animated country borders (trim paths), extruded prism bars, and route line draw-ons.
2. **Keyframe Timing & Easing Curves:**
   - Measure frame-by-frame displacement across the `4x4` timestamped tiles:
     - **Snappy Posterized / Stop-Motion Feel:** Held on 2s or 3s (`8–12 FPS` effective rate, `posterizeTime(12)` expression) common in Vox/collage styles.
     - **Smooth Exponential Ease-Out:** Fast initial burst over 3–4 frames followed by a long, gentle settle over 10–15 frames (`cubic-bezier(0.16, 1, 0.3, 1)` / `85%` influence in AE Graph Editor).
     - **Spring / Overshoot:** Element scales past `100%` to `~106%` before settling back.
3. **Transition Mechanics:**
   - **Match Cut (Graphic / Shape / Text):** An object or word stays anchored at the same screen coordinates while the surrounding scene morphs or cuts around it.
   - **Mask / Matte Wipe:** Foreground object or ink/paper tear crosses the lens to reveal the next scene.
   - **Camera Whip / Zoom-Through:** Camera punches into a detail (e.g., a newspaper headline or map city) which becomes the canvas for the next scene.

---

## Required Output Structure ("How It Was Made" Production Blueprint)

Present your findings in this structured format:

1. **Executive Production Summary:**
   - Style archetype (e.g., *Vox-style 2.5D Archival Collage*, *Bloomberg Data-Driven Motion Essay*, *Kurzgesagt Vector/2.5D Animation*, *3D Technical Explainer*).
   - Pacing metrics (ASL, Cuts/Min, Visual Modality mix).
   - Likely production toolchain (e.g., *After Effects + GeoLayers 3 + Illustrator*, *Blender + DaVinci Resolve*, *Manim / Remotion*).
2. **Narrative & Editorial Architecture (2-Column A/V Breakdown):**
   - Table of major story beats showing **Timestamp | Narration Hook/Cue | Visual Strategy | Sound Design Cue**.
3. **Visual Design System & Layer Stack:**
   - Layer-by-layer compositing order (Background $\rightarrow$ Midground $\rightarrow$ Foreground $\rightarrow$ Texture/Adjustment layers), color palette roles, and typography system.
4. **Signature Motion & Transition Deconstructions (with Timestamps):**
   - Frame-by-frame breakdown of the best transitions/animations: camera rig, keyframe timing, easing curves, and how sound effects sell the motion.
5. **Step-by-Step Recreation Recipe:**
   - Concrete instructions (layer properties, expressions like `posterizeTime(12)` or `wiggle(1.5, 4)`, trim paths, blend modes, or code equivalents) so the user can recreate the exact look and feel.
