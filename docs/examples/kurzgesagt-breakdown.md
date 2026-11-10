# Example breakdown: Kurzgesagt, *What Happens When You Die? (Minute by Minute)*, 0:00-2:00

This is an end-to-end example of what an agent produces with `video-deconstructor` and the bundled skill. It was generated in GitHub Copilot (Claude Opus 5.5) using only the MCP tools:

1. `deconstruct_video_overview` on `https://www.youtube.com/watch?v=fEjvSbI_PT4`, 0-120 s (10 s from cache).
2. The agent read `av-timeline.md` and viewed `audio-strip.png`, four storyboard sheets and two style frames.
3. `inspect_motion_or_transition` at 10 fps on 1:01-1:04 and 1:29-1:32 (1.4 s each), plus an earlier zoom of 0:42.5-0:46.

The report is commentary for study purposes; no frames are reproduced. **Measured** = taken from the tool's data (cuts, shot lengths, silences, MAFD motion, caption times). **Observed** = seen in the timestamped frames. **Inferred** = an educated guess about technique or tools.

---

## 1. Summary

| | |
| --- | --- |
| Style archetype | Flat-vector 2D explainer with 2.5D depth effects, preceded by a live-action merch spot |
| Range analyzed | 0:00-2:00 (1080p, 60 fps) |
| Shots / cuts (measured) | 14 shots: 7 hard cuts, 6 soft transitions; 6.5 cuts/min |
| Shot length (measured) | average 8.57 s, median 4.0 s; 81 % of runtime in shots of 7 s or more |
| Two editing regimes (measured) | 0:00-0:08.7: six shots averaging 1.45 s (sponsor spot). 0:08.7-2:00: eight shots averaging about 14 s, all transitions after 0:41 are soft |
| Narration | Uploader subtitles, 42 lines; a calm, continuous voice-over bed |
| Likely toolchain (inferred) | Vector illustration (Illustrator/Affinity) animated in After Effects, with camera moves, masks, blur and glow effects |

The video separates the ad from the story by changing grammar: fast hard cuts and live action for the merch, then long, continuously moving animated "shots" joined by designed transitions, so the story feels like one unbroken journey.

## 2. Structure

| Time | Narration purpose | Visual approach | Sound |
| --- | --- | --- | --- |
| 0:00-0:08.7 | Sponsor: sleep merch | Live-action product shots and a cut-out presenter on motion-graphic bursts; sticker callouts ("Level up your sleep!", "Visit our shop!"), a QR code and a yellow progress bar along the bottom (observed) | VO; the hard cut into the animation (0:08.67) comes mid-way through the sign-off line "And now, snuggle up – the video is starting!" (7.68-11.03 s, measured) |
| 0:08.7-0:33.5 | Cold open: "Your heart beats one last time, jerks a bit and then… nothing" | One 24.8 s shot (measured): a glowing heart fades from hot white-yellow to dim purple, then a focus pull reveals blood cells, then a slow tilt up the body to a face (observed) | Silences of 0.41 s at 0:09.35 and 0.99 s at 0:11.0 (measured); the second is a held beat right before the first story line starts at 0:12.06 |
| 0:33.5-0:49.6 | Thesis: death is a process, not a switch | Character on a pale-yellow stage; at 0:44.1 a chevron-shaped wipe turns him into an x-ray skeleton that collapses into bones (observed, soft transition measured at 44.125 s) | |
| 0:49.6-1:09.6 | "You are a society of 30 trillion cells" | Silhouette filled with confetti-like dots and a "~30 Trillion Cells" pill label; a triptych (Brain Death / Dead Muscles / Necrobiome); a starfield with eyes and a hand-lettered "Dope!" aside, then a hyperspace warp (observed) | |
| 1:09.6-2:00 | Chapter: what it means to die; oxygen and ATP | Molecule-scale scenes on cream backgrounds; a circular reveal into a lung diagram at 1:30.4; a dot-matrix unit chart ("All Your Cells", "80%", footnote "One dot equals ~30 billion cells") at 1:45 (observed) | |

## 3. Visual design system

- **Layer stack (observed):** flat-colour background with a soft radial gradient or vignette; mid-ground vector characters and objects built from rounded shapes; foreground particles (stars, dots, molecules) at several sizes. Some layers carry heavy blur to fake depth of field (for example 0:21, where the whole frame is defocused during a focus pull).
- **Colour roles (observed, approximate):** deep indigo and purple for "inside the body" and night scenes; pale cream or yellow for "stage" scenes; saturated accents (hot pink, cyan, orange, lime) for the subject of each shot. Brightness carries meaning: the heart goes from glowing to dim purple as it stops (0:12-0:19).
- **Typography (observed):** a rounded geometric sans in white, bold, set on solid colour pills (orange, purple, blue) for labels such as "~30 Trillion Cells" and "All Your Cells". Hero numbers like "80%" get a thick contrasting outline (sticker style). Hand-lettered asides ("Dope!") with a small arrow add humour.
- **Data visualisation (observed):** unit charts built from grids of dots, with colour splitting the share (80 % in pink) and a footnote defining the unit.
- **Glow and light (observed):** bloom on the beating heart, the eyes and the orb; light sources are soft and saturated rather than realistic.

## 4. Signature techniques

1. **Long "one-take" camera journeys (measured + observed).** Shots of 13-30 s (0:55.9-1:09.6, 1:09.6-1:30.4, 1:30.4-2:00) keep the camera moving through one continuous illustrated world. *Inferred build:* After Effects 3D camera or null-driven position/scale moves over large layered artboards, with eased keyframes.
2. **Focus pull as a scene change (observed, 0:20-0:23).** Instead of cutting, the frame goes fully out of focus and resolves on a new subject (blood cells). *Inferred build:* camera depth of field or animated Gaussian/lens blur on stacked layers.
3. **Chevron wipe with a meaning change (observed, 0:44.1-0:45.1; soft transition measured at 44.125 s).** A chevron-shaped panel sweeps right to left; behind its edge the character is shown as a skeleton, which then collapses. The wipe works as an "x-ray" reveal, not just a transition. *Inferred build:* a track matte, with the skeleton version of the character revealed under a moving shape layer.
4. **Hyperspace warp into a close-up (measured + observed, 1:01-1:04).** Star particles stretch into radial streaks while motion accelerates steadily. Measured MAFD rises 0.23 → 0.39 → 0.60 → 1.12 → 1.50 % per 0.2 s from 1:01.0 to 1:03.2 (an ease-in). The eyes balloon and blur, and the frame settles on a close-up of the character behind a glowing purple orb by 1:03.9; motion falls back to about 0.4 %. The eyes blink at about 1:01.6-1:01.8. *Inferred build:* a particle field (e.g. Trapcode Particular, or a 3D layer grid) flown through with an exponentially accelerating camera, radial/zoom motion blur, and a defocused cross-over into the next scene.
5. **Circular reveal on the word (measured + observed, 1:30.2-1:30.6).** A circle opens from a point to almost full frame in about 0.3 s; MAFD peaks at 1.96 % at 1:30.4 and decays by 1:30.8 (fast ease-out). The soft transition is measured at 90.375 s and the next narration line starts at 90.48 s, so the picture changes about 0.1 s before the voice. *Inferred build:* an ellipse mask (or shape-layer matte) with a scale keyframe using a strong ease-out, about 18-20 frames at 60 fps.
6. **Brightness as narration (observed, 0:12-0:19).** The heart's glow and colour drain from white-yellow to purple as the narration describes the heart stopping, so a colour change stands in for an action.

## 5. Sound

- Under the story, the voice-over is continuous. The measured silences all sit in the hand-over from ad to story: 0.37 s at 0:08.26, 0.41 s at 0:09.35 and 0.99 s at 0:11.0, the last one a held beat just before "Your heart beats one last time" at 0:12.06. Picture changes first (the cut at 0:08.67), then the sound clears, then the story's voice begins.
- The spectrogram shows a steady, broadband music and VO bed for the rest of the section, with no isolated sound-effect spikes strong enough to stand out at this scale. A zoom with the audio strip would be needed to study individual whooshes.

## 6. Recreation recipe (After Effects)

1. **Illustrate in layers.** Build each world as a large vector artboard (background gradient, mid-ground shapes, foreground particles) and import it with layers kept separate.
2. **Camera journeys.** Make the layers 3D at different Z depths, add a camera with depth of field on, and animate position over 10-30 s with Easy Ease (or a 60-80 % influence curve) so moves start and land gently.
3. **Focus pull.** Keyframe camera Focus Distance from the old subject's depth to a blur-out, then to the new subject's depth over about 1 s.
4. **Chevron x-ray wipe.** Duplicate the character and swap in a skeleton version. Draw a chevron shape layer, use it as the track matte for the skeleton and a solid purple panel, and move it right to left over about 1 s. Animate the bones falling with slight overshoot after the edge passes.
5. **Hyperspace warp.** Fill a 3D space with small coloured particles. Move the camera forward with exponentially increasing speed over about 2 s (ease-in with high influence), add Directional/Radial Blur or CC Radial Fast Blur, and scale the hero elements past the lens while blurring into the next scene.
6. **Circular reveal.** On the incoming scene, add an Ellipse mask (or a matte layer) and scale it from 0 % to over 100 % in about 18-20 frames at 60 fps with a strong ease-out. Place it so it starts about 0.1 s before the narration line it illustrates.
7. **Labels and numbers.** Use a rounded geometric sans, white bold on a solid pill; give hero numbers a thick contrasting stroke. Pop labels in with a quick scale overshoot (for example 0 → 105 → 100 % over 8-10 frames).
8. **Glow.** Add Glow (or a duplicated blurred layer in Add mode) to light sources such as the heart, eyes and orbs, and animate its intensity and colour to show state changes.

## Reproduce this analysis

```bash
node bin/cli.mjs overview "https://www.youtube.com/watch?v=fEjvSbI_PT4" --start 0 --end 120
node bin/cli.mjs zoom "https://www.youtube.com/watch?v=fEjvSbI_PT4" --start 61 --end 64 --fps 10
node bin/cli.mjs zoom "https://www.youtube.com/watch?v=fEjvSbI_PT4" --start 89 --end 92 --fps 10
node bin/cli.mjs zoom "https://www.youtube.com/watch?v=fEjvSbI_PT4" --start 42.5 --end 46 --fps 10
```

Then ask your agent: *"Using the video-production-deconstructor skill, break down how this was made."*
