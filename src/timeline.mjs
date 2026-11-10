import { fmtTime, round } from './util.mjs';

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ' };

function cleanLine(line) {
  return line
    .replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITIES[m])
    .replace(/\s+/g, ' ')
    .trim();
}

function parseTimestamp(s) {
  const m = String(s).trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/);
  if (!m) return null;
  return (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4].padEnd(3, '0')) / 1000;
}

/**
 * Parse WebVTT or SRT into [{ start, end, text }].
 * YouTube auto-captions repeat the previous line in every "rolling" cue and
 * insert 10 ms transition cues; both are collapsed so each line appears once.
 */
export function parseCaptions(text) {
  const blocks = String(text).replace(/^\uFEFF/, '').replace(/\r/g, '').split(/\n{2,}/);
  const raw = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a, b] = lines[i].split('-->');
    const start = parseTimestamp(a);
    const end = parseTimestamp(b);
    if (start === null || end === null) continue;
    raw.push({ start, end, lines: lines.slice(i + 1).map(cleanLine).filter(Boolean) });
  }
  const cues = [];
  const recent = [];
  for (const c of raw) {
    if (c.end - c.start < 0.05) continue;
    for (const line of c.lines) {
      if (recent.includes(line)) continue;
      cues.push({ start: round(c.start), end: round(c.end), text: line });
      recent.push(line);
      if (recent.length > 4) recent.shift();
    }
  }
  return cues;
}

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

/**
 * Two-column A/V script: one row per shot with the narration spoken during it,
 * silence/music-drop markers and links to the style frames captured from it.
 */
export function buildAvTimeline({ meta, pacing, cues, silences = [], chapters = [], styleFrames = [], relDir = '.' }) {
  const lines = [];
  lines.push(`# A/V timeline - ${meta.title || 'video'}`);
  lines.push('');
  if (meta.url) lines.push(`- Source: ${meta.url}`);
  if (meta.channel) lines.push(`- Channel: ${meta.channel}`);
  lines.push(`- Analyzed range: ${fmtTime(pacing.range.start)} - ${fmtTime(pacing.range.end)} (${round(pacing.range.duration, 1)}s)`);
  lines.push(`- Shots: ${pacing.totalShots} | Cuts: ${pacing.totalCuts} (${pacing.hardCuts ?? pacing.totalCuts} hard, ${pacing.softTransitions ?? 0} soft) | Avg shot length: ${pacing.averageShotLength}s | Median: ${pacing.medianShotLength}s | Cuts/min: ${pacing.cutsPerMinute}`);
  lines.push(`- Narration source: ${cues.length ? `${meta.captionsKind || 'captions'} (${cues.length} lines)` : 'none available (visual-only analysis)'}`);
  lines.push('');
  lines.push('Times are absolute positions in the original video. "In" = how the shot begins: `hard` = cut detected between consecutive frames; `soft` = gradual change over ~0.25 s (dissolve, wipe, whip pan or very fast motion).');
  lines.push('');
  lines.push('| Shot | In | Start | Len (s) | Narration / audio during shot | Audio notes | Style frame |');
  lines.push('| ---: | :--- | :--- | ---: | :--- | :--- | :--- |');

  const framesByShot = new Map();
  for (const f of styleFrames) framesByShot.set(f.shot, [...(framesByShot.get(f.shot) || []), f]);
  const chapterStarts = chapters.filter((c) => c.start >= pacing.range.start && c.start < pacing.range.end);
  for (const shot of pacing.shots) {
    for (const ch of chapterStarts.filter((c) => c.start >= shot.start && c.start < shot.end)) {
      lines.push(`|  |  | **${fmtTime(ch.start)}** |  | **Chapter: ${cell(ch.title)}** |  |  |`);
    }
    const said = cues.filter((c) => c.start >= shot.start && c.start < shot.end).map((c) => c.text).join(' ');
    const quiet = silences
      .filter((s) => s.start >= shot.start && s.start < shot.end)
      .map((s) => `silence ${round(s.duration, 2)}s @ ${fmtTime(s.start)}`)
      .join('; ');
    const link = (framesByShot.get(shot.index) || []).map((f) => `[${f.file}](${relDir}/${f.file})`).join('<br>');
    lines.push(`| ${shot.index} | ${shot.enteredBy || ''} | ${fmtTime(shot.start)} | ${shot.length.toFixed(2)} | ${cell(said)} | ${cell(quiet)} | ${link} |`);
  }
  lines.push('');
  return lines.join('\n');
}

/** Approximate share of cuts that land within `tolerance` seconds of a caption line start. */
export function cutsNearNarration(cuts, cues, tolerance = 0.5) {
  if (!cuts.length || !cues.length) return null;
  const n = cuts.filter((c) => cues.some((q) => Math.abs(q.start - c.t) <= tolerance)).length;
  return { tolerance, cuts: cuts.length, nearCaptionStart: n, share: round(n / cuts.length, 3) };
}
