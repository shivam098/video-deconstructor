import { round } from './util.mjs';

const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/**
 * Turn per-frame scene scores into editorial cuts.
 * frames: [{ t, score }] with absolute times; score in [0,1].
 */
export function detectCuts(frames, { threshold = 0.3, minGap = 0.25, start = frames[0]?.t ?? 0 } = {}) {
  const cuts = [];
  for (const f of frames) {
    if (f.score < threshold || f.t - start < minGap) continue;
    const last = cuts[cuts.length - 1];
    if (last && f.t - last.t < minGap) {
      if (f.score > last.score) { last.t = f.t; last.score = f.score; }
      continue;
    }
    cuts.push({ t: f.t, score: f.score });
  }
  return cuts.map((c) => ({ t: round(c.t), score: round(c.score), type: 'hard' }));
}

/**
 * Gradual transitions (dissolves, wipes, whip pans) spread their change over
 * many frames, so consecutive-frame scores stay low. `coarse` holds scene
 * scores between frames `step` seconds apart; a high coarse score with no
 * hard cut nearby marks a soft transition.
 */
export function detectSoftTransitions(coarse, hardCuts, { threshold = 0.35, step = 0.25, minGap = 0.6, start = coarse[0]?.t ?? 0 } = {}) {
  const out = [];
  for (const f of coarse) {
    if (f.score < threshold || f.t - start < step * 1.5) continue;
    const from = f.t - step - 0.15;
    const to = f.t + 0.15;
    if (hardCuts.some((c) => c.t >= from && c.t <= to)) continue;
    const t = f.t - step / 2;
    const last = out[out.length - 1];
    if (last && t - last.t < minGap) {
      if (f.score > last.score) { last.t = t; last.score = f.score; }
      continue;
    }
    out.push({ t, score: f.score });
  }
  return out.map((c) => ({ t: round(c.t), score: round(c.score), type: 'soft' }));
}

export function mergeCuts(hard, soft) {
  return [...hard, ...soft].sort((a, b) => a.t - b.t);
}

const BUCKETS = [
  { key: 'flash (<1.5s)', max: 1.5 },
  { key: 'fast (1.5-3.5s)', max: 3.5 },
  { key: 'standard (3.5-7s)', max: 7 },
  { key: 'long hold (>=7s)', max: Infinity },
];

/** Editorial pacing statistics for the range [start, end] (absolute seconds). */
export function computePacing({ cuts, start, end, chapters = [] }) {
  const duration = Math.max(0.001, end - start);
  const insideCuts = cuts.filter((c) => c.t > start && c.t < end);
  const inside = insideCuts.map((c) => c.t);
  const bounds = [start, ...inside, end];
  const shots = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    shots.push({
      index: i + 1,
      start: round(bounds[i]),
      end: round(bounds[i + 1]),
      length: round(bounds[i + 1] - bounds[i]),
      enteredBy: i === 0 ? 'start' : insideCuts[i - 1].type || 'hard',
    });
  }
  const lengths = shots.map((s) => s.length);
  const distribution = BUCKETS.map((b, i) => {
    const min = i ? BUCKETS[i - 1].max : 0;
    const sel = shots.filter((s) => s.length >= min && s.length < b.max);
    const secs = sel.reduce((a, s) => a + s.length, 0);
    return { bucket: b.key, shots: sel.length, runtimeShare: round(secs / duration, 3) };
  });

  const usable = chapters.filter((c) => c.end > start && c.start < end);
  let segments;
  if (usable.length >= 2) {
    segments = usable.map((c) => ({ label: c.title, start: Math.max(start, c.start), end: Math.min(end, c.end) }));
  } else {
    const size = duration <= 240 ? 30 : Math.ceil(duration / 8);
    segments = [];
    for (let s = start; s < end - 0.5; s += size) segments.push({ label: null, start: s, end: Math.min(end, s + size) });
  }
  segments = segments.map((seg) => {
    const n = inside.filter((t) => t >= seg.start && t < seg.end).length;
    const len = seg.end - seg.start;
    return {
      label: seg.label,
      start: round(seg.start),
      end: round(seg.end),
      cuts: n,
      cutsPerMinute: round(n / (len / 60), 1),
      approxAverageShotLength: round(len / (n + 1), 2),
    };
  });

  const byLength = [...shots].sort((a, b) => b.length - a.length);
  return {
    range: { start: round(start), end: round(end), duration: round(duration) },
    totalCuts: inside.length,
    hardCuts: insideCuts.filter((c) => (c.type || 'hard') === 'hard').length,
    softTransitions: insideCuts.filter((c) => c.type === 'soft').length,
    totalShots: shots.length,
    averageShotLength: round(mean(lengths), 2),
    medianShotLength: round(median(lengths), 2),
    cutsPerMinute: round(inside.length / (duration / 60), 1),
    shotLengthDistribution: distribution,
    pacingBySegment: segments,
    longestShots: byLength.slice(0, 5),
    shortestShots: byLength.slice(-5).reverse(),
    shots,
  };
}

/**
 * Visual activity from the coarse series (frames `step` seconds apart), so the
 * value does not depend on the video's frame rate. Uses MAFD (% of pixels'
 * full-scale change). Samples spanning a cut or soft transition are excluded:
 * what remains is motion *inside* shots.
 */
export function computeActivity(coarse, cuts, { start, end, step = 0.25, window = 3, top = 5, lowBelow = 0.3 } = {}) {
  const secs = Math.max(1, Math.ceil(end - start));
  const sums = new Array(secs).fill(0);
  const counts = new Array(secs).fill(0);
  for (const f of coarse) {
    if (f.t - start < step / 2) continue;
    if (cuts.some((c) => c.t > f.t - step - 0.05 && c.t <= f.t + 0.05)) continue;
    const i = Math.min(secs - 1, Math.max(0, Math.floor(f.t - start - 1e-9)));
    sums[i] += f.mafd; counts[i] += 1;
  }
  const perSecond = sums.map((s, i) => (counts[i] ? s / counts[i] : null));
  const filled = perSecond.map((v, i) => v ?? perSecond[i - 1] ?? perSecond.find((x) => x !== null) ?? 0);
  const windows = [];
  for (let i = 0; i + window <= secs; i++) {
    windows.push({ i, value: mean(filled.slice(i, i + window)) });
  }
  windows.sort((a, b) => b.value - a.value);
  const picked = [];
  for (const w of windows) {
    if (picked.length >= top || w.value <= lowBelow) break;
    if (picked.some((p) => Math.abs(p.i - w.i) < window)) continue;
    picked.push(w);
  }
  return {
    note: `Per second: mean absolute difference (% of full scale) between frames ${step}s apart, excluding samples that span a cut. `
      + `<${lowBelow} = (near) still frame or small elements moving on a plain background; ~1-5 = moderate motion; >10 = fast motion or camera moves.`,
    overallMean: round(mean(filled), 3),
    perSecond: filled.map((v) => round(v, 3)),
    motionHotspots: picked
      .sort((a, b) => a.i - b.i)
      .map((w) => ({ start: round(start + w.i, 2), end: round(Math.min(end, start + w.i + window), 2), activity: round(w.value, 3) })),
    lowMotionShare: round(filled.filter((v) => v < lowBelow).length / secs, 3),
  };
}

/**
 * Pick representative style-frame timestamps. With many shots, take the
 * midpoints of evenly spread shots. With few long shots (one-take animation,
 * 3Blue1Brown-style canvases) spread extra samples inside the longest shots,
 * never closer than `minSpacing` seconds.
 */
export function pickStyleFrameTimes(shots, max, { minSpacing = 4 } = {}) {
  if (max <= 0 || !shots.length) return [];
  let pool = shots.filter((s) => s.length >= 0.6);
  if (!pool.length) pool = shots;
  if (pool.length >= max) {
    const out = [];
    for (let k = 0; k < max; k++) {
      const s = pool[Math.round((k * (pool.length - 1)) / (max - 1 || 1))];
      if (!out.some((o) => o.shot === s.index)) out.push({ shot: s.index, t: round(s.start + s.length / 2) });
    }
    return out;
  }
  const counts = new Map(pool.map((s) => [s.index, 1]));
  let remaining = max - pool.length;
  while (remaining > 0) {
    let best = null;
    for (const s of pool) {
      const gap = s.length / (counts.get(s.index) + 1);
      if (gap >= minSpacing && (!best || gap > best.gap)) best = { s, gap };
    }
    if (!best) break;
    counts.set(best.s.index, counts.get(best.s.index) + 1);
    remaining -= 1;
  }
  return pool.flatMap((s) => {
    const n = counts.get(s.index);
    return Array.from({ length: n }, (_, k) => ({ shot: s.index, t: round(s.start + (s.length * (k + 0.5)) / n) }));
  });
}
