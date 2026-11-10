import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  run, describeExit, log, parseTime, fmtTime, fileTag, slug, hash8, ensureDir, resetDir, round, isUrl, filterValue,
} from './util.mjs';
import { requireTool, ytDlpEnv, jsRuntimeArgs, findFont, defaultCacheRoot } from './binaries.mjs';
import { detectCuts, detectSoftTransitions, mergeCuts, computePacing, computeActivity, pickStyleFrameTimes } from './metrics.mjs';
import { parseCaptions, buildAvTimeline, cutsNearNarration } from './timeline.mjs';

const require = createRequire(import.meta.url);
export const VERSION = require('../package.json').version;

const FF_BASE = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error'];
const tail = (s, n = 600) => String(s || '').trim().slice(-n);
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const writeJson = (p, v) => fs.writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`);
const rel = (from, to) => path.relative(from, to).split(path.sep).join('/');

function ffVersion(tool) {
  const m = String(tool.version).match(/^n?(\d+)\.(\d+)/);
  return m ? { major: +m[1], minor: +m[2] } : { major: 99, minor: 0 };
}
// -fps_mode exists from FFmpeg 5.1; older builds only know -vsync.
const vfrArgs = (ff) => {
  const { major, minor } = ffVersion(ff);
  return major > 5 || (major === 5 && minor >= 1) ? ['-fps_mode', 'vfr'] : ['-vsync', 'vfr'];
};

/**
 * Pass a filtergraph inline, or via a script file when it is long enough to
 * risk the ~32K Windows command-line limit.
 */
function filterComplexArgs(ff, graph, scratchDir) {
  if (graph.length < 8000) return ['-filter_complex', graph];
  const file = path.join(ensureDir(scratchDir), `filter-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(file, graph);
  return ffVersion(ff).major >= 7 ? ['-/filter_complex', file] : ['-filter_complex_script', file];
}

async function ffmpeg(ff, args, what, timeoutMs = 0) {
  const r = await run(ff.cmd, [...ff.prefix, ...args], { timeoutMs });
  if (r.code !== 0) throw new Error(`ffmpeg ${what} failed (${describeExit(r)}): ${tail(r.stderr)}`);
  return r;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

// ---------------------------------------------------------------- acquisition

export function youtubeId(url) {
  const m = String(url).match(/(?:youtu\.be\/|[?&]v=|\/shorts\/|\/embed\/|\/live\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

function pickInfo(info) {
  return {
    id: info.id,
    title: info.title,
    channel: info.channel || info.uploader || null,
    url: info.webpage_url || info.original_url || null,
    extractor: info.extractor_key || info.extractor || null,
    duration: info.duration ?? null,
    uploadDate: info.upload_date || null,
    width: info.width ?? null,
    height: info.height ?? null,
    fps: info.fps ?? null,
    viewCount: info.view_count ?? null,
    categories: info.categories || [],
    tags: (info.tags || []).slice(0, 20),
    description: (info.description || '').slice(0, 2000),
    chapters: (info.chapters || []).map((c) => ({ start: c.start_time, end: c.end_time, title: c.title })),
    hasUploaderEnglishSubs: Object.keys(info.subtitles || {}).some((k) => /^en\b/i.test(k)),
  };
}

const CAPTION_PREFERENCE = ['en', 'en-US', 'en-GB', 'en-orig'];

function findCaptionFile(dir, base) {
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.startsWith(`${base}.`) && /\.(vtt|srt)$/i.test(f)); } catch { return null; }
  for (const lang of CAPTION_PREFERENCE) {
    const hit = files.find((f) => f.toLowerCase() === `${base}.${lang.toLowerCase()}.vtt` || f.toLowerCase() === `${base}.${lang.toLowerCase()}.srt`);
    if (hit) return hit;
  }
  return files[0] || null;
}

async function ytDlp(args, timeoutMs) {
  const yt = await requireTool('yt-dlp');
  return run(yt.cmd, [...yt.prefix, ...jsRuntimeArgs(), '--no-warnings', ...args], { env: ytDlpEnv(), timeoutMs });
}

async function acquireUrl(url, { start, end, maxHeight, cacheRoot }) {
  const mediaRoot = ensureDir(path.join(cacheRoot, 'media'));
  const indexFile = path.join(mediaRoot, 'url-index.json');
  const ytId = youtubeId(url);
  let key = ytId ? `youtube-${ytId}` : (readJson(indexFile) || {})[url] || null;
  let mediaDir = key && path.join(mediaRoot, key);
  let state = mediaDir && readJson(path.join(mediaDir, 'source.json'));
  let pendingInfo = null;

  if (!state) {
    log('fetching metadata:', url);
    const r = await ytDlp(['--dump-single-json', '--no-playlist', '--skip-download', url], 300000);
    if (r.code !== 0) throw new Error(`yt-dlp could not read ${url} (${describeExit(r)}): ${tail(r.stderr)}`);
    pendingInfo = pickInfo(JSON.parse(r.stdout));
    key = `${slug(pendingInfo.extractor || 'web', 16)}-${String(pendingInfo.id).replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 64)}`;
    mediaDir = ensureDir(path.join(mediaRoot, key));
    if (!ytId) {
      const index = readJson(indexFile) || {};
      index[url] = key;
      writeJson(indexFile, index);
    }
    state = readJson(path.join(mediaDir, 'source.json'));
  }

  if (!state) {
    const info = pendingInfo;
    state = { url, info, downloads: [], captions: null };
    log('fetching captions');
    const c = await ytDlp([
      '--skip-download', '--no-playlist', '--write-subs', '--write-auto-subs',
      '--sub-langs', CAPTION_PREFERENCE.join(','), '--sub-format', 'vtt/srt/best',
      '-o', path.join(mediaDir, 'captions.%(ext)s'), url,
    ], 300000);
    const file = findCaptionFile(mediaDir, 'captions');
    if (file) {
      const lang = file.split('.').slice(-2, -1)[0];
      const uploader = info.hasUploaderEnglishSubs && lang !== 'en-orig';
      state.captions = { file, lang, kind: uploader ? 'uploader subtitles' : 'YouTube auto-captions' };
    } else {
      log(`no English captions available${c.code !== 0 ? ` (${describeExit(c)}: ${tail(c.stderr, 160)})` : ''}`);
    }
    writeJson(path.join(mediaDir, 'source.json'), state);
  }

  const S = start ?? 0;
  const E = end ?? Infinity;
  let dl = state.downloads.find((d) => fs.existsSync(path.join(mediaDir, d.file))
    && (d.start ?? 0) <= S + 0.01 && (d.end ?? Infinity) >= E - 0.01);

  if (!dl) {
    const ff = await requireTool('ffmpeg');
    const section = start !== undefined || end !== undefined;
    const dS = section ? Math.max(0, S - 1) : null;
    const dE = section && Number.isFinite(E) ? E + 1 : null;
    const base = section ? `section_${fileTag(dS)}_${dE === null ? 'end' : fileTag(dE)}` : 'full';
    const h = maxHeight;
    const format = `bv*[height<=${h}][vcodec^=avc1]+ba[ext=m4a]/bv*[height<=${h}]+ba/b[height<=${h}]/bv*+ba/b`;
    log(`downloading ${section ? `section ${fmtTime(dS)}-${dE === null ? 'end' : fmtTime(dE)}` : 'full video'} (<=${h}p)`);
    const r = await ytDlp([
      '--no-playlist', '--no-progress', '-f', format, '--merge-output-format', 'mp4',
      '--ffmpeg-location', ff.cmd, '-o', path.join(mediaDir, `${base}.%(ext)s`),
      ...(section ? ['--download-sections', `*${dS}-${dE === null ? 'inf' : dE}`, '--force-keyframes-at-cuts'] : []),
      state.url,
    ], 3 * 3600 * 1000);
    const file = fs.readdirSync(mediaDir).find((f) => f.startsWith(`${base}.`) && !/\.(json|vtt|srt|part|ytdl|txt|temp|tmp)$/i.test(f));
    if (r.code !== 0 || !file) throw new Error(`yt-dlp download failed (${describeExit(r)}): ${tail(r.stderr)}`);
    dl = { file, start: dS, end: dE };
    state.downloads = state.downloads.filter((d) => d.file !== file).concat(dl);
    writeJson(path.join(mediaDir, 'source.json'), state);
  } else {
    log('using cached media:', path.join(mediaDir, dl.file));
  }

  return {
    key,
    videoPath: path.join(mediaDir, dl.file),
    offset: dl.start ?? 0,
    meta: { ...state.info, url: state.info.url || state.url },
    chapters: state.info.chapters || [],
    captionsPath: state.captions ? path.join(mediaDir, state.captions.file) : null,
    captionsKind: state.captions?.kind || null,
  };
}

function acquireLocal(file, captionsOverride) {
  const abs = path.resolve(file);
  let st;
  try { st = fs.statSync(abs); } catch { throw new Error(`File not found: ${abs}`); }
  if (!st.isFile()) throw new Error(`Not a file: ${abs}`);
  const { dir, name } = path.parse(abs);
  let captionsPath = captionsOverride ? path.resolve(captionsOverride) : null;
  if (!captionsPath) {
    const side = fs.readdirSync(dir).find((f) => (f.startsWith(`${name}.`)) && /\.(vtt|srt)$/i.test(f));
    if (side) captionsPath = path.join(dir, side);
  }
  return {
    key: `local-${slug(name, 40)}-${hash8(`${abs}|${st.size}|${st.mtimeMs}`)}`,
    videoPath: abs,
    offset: 0,
    meta: { title: path.basename(abs), channel: null, url: null, path: abs },
    chapters: [],
    captionsPath,
    captionsKind: captionsPath ? `sidecar file ${path.basename(captionsPath)}` : null,
  };
}

async function acquire(source, opts) {
  if (!source) throw new Error('source is required (YouTube/web URL or local video path)');
  return isUrl(source) ? acquireUrl(source.trim(), opts) : acquireLocal(source, opts.captions);
}

export async function probeMedia(file) {
  const fp = await requireTool('ffprobe');
  const r = await run(fp.cmd, [...fp.prefix, '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { timeoutMs: 120000 });
  if (r.code !== 0) throw new Error(`ffprobe failed (${describeExit(r)}): ${tail(r.stderr)}`);
  const j = JSON.parse(r.stdout);
  const v = (j.streams || []).find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  if (!v) throw new Error(`No video stream in ${file}`);
  const a = (j.streams || []).find((s) => s.codec_type === 'audio');
  const rate = (v.avg_frame_rate && v.avg_frame_rate !== '0/0' ? v.avg_frame_rate : v.r_frame_rate) || '0/1';
  const [n, d] = rate.split('/').map(Number);
  return {
    duration: parseFloat(j.format?.duration || v.duration || '0'),
    width: v.width,
    height: v.height,
    fps: d ? round(n / d, 3) : null,
    videoCodec: v.codec_name,
    hasAudio: Boolean(a),
    audioCodec: a?.codec_name || null,
  };
}

// ------------------------------------------------------------------ analysis

/**
 * One decode pass with ffmpeg's `scdet` filter on two branches:
 *   fine   - every frame: scene score (hard cuts) and MAFD (motion per frame)
 *   coarse - frames 0.25 s apart: scene score (gradual transitions) and MAFD
 *            (frame-rate independent motion), plus silence detection on audio.
 * MAFD = mean absolute frame difference in percent of full scale; the scene
 * score is min(MAFD, |MAFD - previous MAFD|), which only spikes when the
 * amount of change itself changes (a cut), not during steady motion.
 */
async function analyzeSignal(file, { localStart, dur, absStart, hasAudio }) {
  const ff = await requireTool('ffmpeg');
  const fc = '[0:v:0]scale=256:-2,split=2[x][y];[x]scdet=threshold=100,metadata@fine=print[v1];'
    + '[y]fps=4,scdet=threshold=100,metadata@coarse=print[v2]'
    + (hasAudio ? ';[0:a:0]silencedetect=n=-35dB:d=0.35[a]' : '');
  const r = await run(ff.cmd, [
    ...ff.prefix, '-hide_banner', '-nostdin', '-nostats', '-loglevel', 'info',
    '-ss', localStart.toFixed(3), '-t', dur.toFixed(3), '-i', file,
    '-filter_complex', fc, '-map', '[v1]', '-map', '[v2]', ...(hasAudio ? ['-map', '[a]'] : []), '-f', 'null', '-',
  ]);
  if (r.code !== 0) throw new Error(`ffmpeg scene analysis failed (${describeExit(r)}): ${tail(r.stderr)}`);
  const series = { fine: [], coarse: [] };
  const silences = [];
  let open = null;
  for (const line of r.stderr.split(/\r?\n/)) {
    let m;
    const inst = line.includes('metadata@coarse') ? 'coarse' : line.includes('metadata@fine') ? 'fine' : null;
    if (inst) {
      const list = series[inst];
      if ((m = line.match(/pts_time:\s*(-?[\d.]+)/))) list.push({ t: absStart + parseFloat(m[1]), score: 0, mafd: 0 });
      else if ((m = line.match(/lavfi\.scd\.mafd=([\d.]+)/)) && list.length) list[list.length - 1].mafd = parseFloat(m[1]);
      else if ((m = line.match(/lavfi\.scd\.score=([\d.]+)/)) && list.length) {
        // scdet reports percent of full scale; select's `scene` (which the
        // thresholds are calibrated on) uses the 8-bit scale / 100, clipped to 1.
        list[list.length - 1].score = Math.min(1, (parseFloat(m[1]) * 2.56) / 100);
      }
    } else if ((m = line.match(/silence_start:\s*(-?[\d.]+)/))) open = Math.max(0, parseFloat(m[1]));
    else if ((m = line.match(/silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/))) {
      const e = parseFloat(m[1]);
      const s = open ?? e - parseFloat(m[2]);
      silences.push({ start: round(absStart + s), end: round(absStart + e), duration: round(e - s) });
      open = null;
    }
  }
  if (open !== null) silences.push({ start: round(absStart + open), end: round(absStart + dur), duration: round(dur - open) });
  return { frames: series.fine, coarse: series.coarse, silences };
}

function findCuts(signal, start, threshold, softThreshold) {
  const hard = detectCuts(signal.frames, { threshold, start });
  const soft = softThreshold > 0 ? detectSoftTransitions(signal.coarse, hard, { threshold: softThreshold, start }) : [];
  return { hard, cuts: mergeCuts(hard, soft) };
}

// ------------------------------------------------------------------ rendering

function fontOpt() {
  const font = findFont();
  return font ? `fontfile=${filterValue(font)}:` : '';
}

async function renderContactSheets({ file, localStart, dur, absStart, fps, cols, rows, tileWidth, outDir }) {
  const ff = await requireTool('ffmpeg');
  resetDir(outDir);
  const size = Math.max(14, Math.round(tileWidth / 20));
  const vf = [
    `fps=${fps}`,
    `scale=${tileWidth}:-2`,
    `drawtext=${fontOpt()}text='%{pts\\:hms\\:${absStart.toFixed(3)}}':x=6:y=6:fontsize=${size}:fontcolor=white:box=1:boxcolor=black@0.7:boxborderw=4`,
    `tile=${cols}x${rows}:padding=4:margin=4:color=0x1a1a1a`,
  ].join(',');
  await ffmpeg(ff, [
    ...FF_BASE, '-ss', localStart.toFixed(3), '-t', dur.toFixed(3), '-i', file, '-an', '-sn',
    '-vf', vf, ...vfrArgs(ff), '-q:v', '3', '-start_number', '1', path.join(outDir, 'sheet_%03d.jpg'),
  ], 'contact sheets');
  const per = cols * rows;
  const totalFrames = Math.max(1, Math.ceil(dur * fps - 1e-6));
  return fs.readdirSync(outDir).filter((f) => /^sheet_\d+\.jpg$/.test(f)).sort().map((f, k) => {
    const first = k * per;
    const last = Math.min(totalFrames, (k + 1) * per) - 1;
    return {
      file: path.join(outDir, f),
      start: round(absStart + first / fps),
      end: round(absStart + Math.max(first, last) / fps),
      frames: Math.max(1, last - first + 1),
    };
  });
}

async function extractFrames({ file, offset, items, outDir, format = 'jpg', prefix = 'style' }) {
  const ff = await requireTool('ffmpeg');
  ensureDir(outDir);
  return mapLimit(items, 4, async (item, i) => {
    const name = `${prefix}_${String(i + 1).padStart(2, '0')}_${fileTag(item.t)}.${format}`;
    const out = path.join(outDir, name);
    await ffmpeg(ff, [
      ...FF_BASE, '-ss', Math.max(0, item.t - offset).toFixed(3), '-i', file, '-an', '-sn',
      '-frames:v', '1', ...(format === 'jpg' ? ['-q:v', '2'] : []), '-update', '1', out,
    ], `frame @ ${fmtTime(item.t)}`);
    return { ...item, file: name, path: out, time: fmtTime(item.t) };
  });
}

export async function renderAudioStrip({ file, localStart, dur, absStart, cuts = [], silences = [], outFile, width = 1920 }) {
  const ff = await requireTool('ffmpeg');
  const W = width;
  const font = fontOpt();
  const xAt = (t) => Math.max(0, Math.min(W - 2, Math.round(((t - absStart) / dur) * (W - 1))));
  const label = (text, x, y, size = 16) => `drawtext=${font}text=${filterValue(text)}:x=${x}:y=${y}:fontsize=${size}:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=3`;

  // Every cut is drawn: markers are merged per pixel column (red wins over
  // orange), then adjacent columns of the same colour become one box.
  const columns = new Map();
  for (const c of cuts) {
    const x = xAt(c.t);
    if (columns.get(x) !== 'red') columns.set(x, c.type === 'soft' ? 'orange' : 'red');
  }
  const runs = [];
  for (const x of [...columns.keys()].sort((a, b) => a - b)) {
    const color = columns.get(x);
    const last = runs[runs.length - 1];
    if (last && last.color === color && x <= last.x + last.w) last.w = x + 2 - last.x;
    else runs.push({ x, w: 2, color });
  }
  const marks = runs.map((r) => `drawbox=x=${r.x}:y=0:w=${r.w}:h=ih:color=${r.color}@0.85:t=fill`);
  const bands = [];
  for (const s of silences) {
    const x0 = xAt(s.start);
    const x1 = Math.max(x0 + 2, xAt(s.end));
    const last = bands[bands.length - 1];
    if (last && x0 <= last.x1) last.x1 = Math.max(last.x1, x1);
    else bands.push({ x0, x1 });
  }
  const quiet = bands.map((b) => `drawbox=x=${b.x0}:y=0:w=${b.x1 - b.x0}:h=ih:color=yellow@0.25:t=fill`);
  const wave = ['aformat=channel_layouts=mono', `showwavespic=s=${W}x220:colors=0x5EC8F8`, 'format=rgb24', ...quiet, ...marks,
    label('waveform | red = hard cut | orange = soft transition | yellow = silence', 6, 6)].join(',');
  const spec = [`showspectrumpic=s=${W}x300:legend=0:scale=log`, 'format=rgb24', label('spectrogram (low frequencies at bottom)', 6, 6)].join(',');
  const ticks = 10;
  const showMs = dur < 30;
  const ruler = [`color=c=0x111111:s=${W}x34:d=1`, 'format=rgb24'];
  for (let i = 0; i <= ticks; i++) {
    const x = Math.round((i / ticks) * (W - 1));
    const text = fmtTime(absStart + (dur * i) / ticks, { ms: showMs });
    ruler.push(`drawbox=x=${Math.min(x, W - 2)}:y=0:w=2:h=8:color=white@0.9:t=fill`);
    ruler.push(label(text, i === 0 ? '4' : i === ticks ? 'w-tw-4' : `${x}-tw/2`, 11, 15));
  }
  const fc = `[0:a:0]asplit=2[a1][a2];[a1]${wave}[w];[a2]${spec}[s];${ruler.join(',')}[r];[w][s][r]vstack=inputs=3[out]`;
  const fcArgs = filterComplexArgs(ff, fc, path.dirname(outFile));
  try {
    await ffmpeg(ff, [
      ...FF_BASE, '-ss', localStart.toFixed(3), '-t', dur.toFixed(3), '-i', file,
      ...fcArgs, '-map', '[out]', '-frames:v', '1', '-update', '1', outFile,
    ], 'audio strip');
  } finally {
    if (fcArgs[0] !== '-filter_complex') fs.rmSync(fcArgs[1], { force: true });
  }
  return outFile;
}

// ------------------------------------------------------------------ pipelines

function resolveRange(media, probe, start, end) {
  const fileStart = media.offset;
  const fileEnd = media.offset + probe.duration;
  const A = Math.max(fileStart, start ?? fileStart);
  const B = Math.min(fileEnd, end ?? fileEnd);
  if (B - A < 0.5) throw new Error(`Requested range ${fmtTime(A)}-${fmtTime(B)} is empty or outside the media (${fmtTime(fileStart)}-${fmtTime(fileEnd)}).`);
  return { A, B, localStart: A - media.offset, dur: B - A };
}

function parseGrid(grid = '4x4') {
  const m = String(grid).match(/^(\d+)x(\d+)$/i);
  if (!m || +m[1] < 1 || +m[2] < 1 || +m[1] * +m[2] > 64) throw new Error(`Invalid grid "${grid}" (use e.g. 4x4, 3x3, 2x2)`);
  return { cols: +m[1], rows: +m[2] };
}

function runDirFor(media, { outputDir, outputBase }) {
  if (outputDir) return ensureDir(path.resolve(outputDir));
  const base = outputBase || process.env.VD_OUTPUT_DIR || path.join(defaultCacheRoot(), 'runs');
  return ensureDir(path.join(path.resolve(base), media.key));
}

function loadCaptions(media, A, B) {
  if (!media.captionsPath) return [];
  try {
    return parseCaptions(fs.readFileSync(media.captionsPath, 'utf8')).filter((c) => c.start >= A - 0.5 && c.start < B);
  } catch (e) {
    log('could not parse captions:', e.message);
    return [];
  }
}

/**
 * Pass 1 + 2 extraction: editorial cuts, pacing, A/V script, storyboard
 * contact sheets, full-resolution style frames and the audio strip.
 */
export async function overview(source, opts = {}) {
  const started = Date.now();
  const cacheRoot = defaultCacheRoot();
  const start = parseTime(opts.start);
  const end = parseTime(opts.end);
  const maxHeight = opts.maxHeight ?? 1080;
  const threshold = opts.sceneThreshold ?? 0.3;
  const softThreshold = opts.softThreshold ?? 0.35;
  const maxSheets = opts.maxSheets ?? 12;
  const maxStyleFrames = opts.maxStyleFrames ?? 12;
  const { cols, rows } = parseGrid(opts.grid);
  const tileWidth = opts.tileWidth ?? 480;

  await requireTool('ffmpeg');
  await requireTool('ffprobe');
  const media = await acquire(source, { start, end, maxHeight, cacheRoot, captions: opts.captions });
  const probe = await probeMedia(media.videoPath);
  const { A, B, localStart, dur } = resolveRange(media, probe, start, end);
  const runDir = runDirFor(media, opts);
  log(`analyzing ${fmtTime(A)}-${fmtTime(B)} -> ${runDir}`);

  const signal = await analyzeSignal(media.videoPath, { localStart, dur, absStart: A, hasAudio: probe.hasAudio });
  const { cuts } = findCuts(signal, A, threshold, softThreshold);
  const pacing = computePacing({ cuts, start: A, end: B, chapters: media.chapters });
  const activity = computeActivity(signal.coarse, cuts, { start: A, end: B });
  const cues = loadCaptions(media, A, B);

  const styleDir = resetDir(path.join(runDir, 'style-frames'));
  const styleFrames = await extractFrames({
    file: media.videoPath, offset: media.offset, items: pickStyleFrameTimes(pacing.shots, maxStyleFrames), outDir: styleDir,
  });

  const per = cols * rows;
  const autoFps = Math.min(1, (maxSheets * per) / dur);
  const fps = round(opts.overviewFps ? Number(opts.overviewFps) : Math.max(0.02, autoFps), 3);
  const sheets = await renderContactSheets({
    file: media.videoPath, localStart, dur, absStart: A, fps, cols, rows, tileWidth, outDir: path.join(runDir, 'contact-sheets'),
  });

  let audioStrip = null;
  if (probe.hasAudio) {
    audioStrip = await renderAudioStrip({
      file: media.videoPath, localStart, dur, absStart: A, cuts, silences: signal.silences, outFile: path.join(runDir, 'audio-strip.png'),
    });
  }

  const narrationSync = cutsNearNarration(cuts, cues);
  const metrics = {
    ...pacing,
    cuts,
    sceneThreshold: threshold,
    softTransitionThreshold: softThreshold,
    narrationSync: narrationSync && { ...narrationSync, note: 'Share of cuts within 0.5s of a caption line start (approximate; caption timing is coarse).' },
    silences: signal.silences,
    visualActivity: activity,
  };
  writeJson(path.join(runDir, 'pacing-metrics.json'), metrics);

  const timeline = buildAvTimeline({
    meta: { ...media.meta, captionsKind: media.captionsKind },
    pacing, cues, silences: signal.silences, chapters: media.chapters, styleFrames, relDir: 'style-frames',
  });
  fs.writeFileSync(path.join(runDir, 'av-timeline.md'), timeline);
  if (cues.length) writeJson(path.join(runDir, 'captions.json'), cues);

  const manifest = {
    tool: `video-deconstructor ${VERSION}`,
    generatedAt: new Date().toISOString(),
    elapsedSec: round((Date.now() - started) / 1000, 1),
    source: {
      input: source,
      key: media.key,
      title: media.meta.title,
      channel: media.meta.channel,
      url: media.meta.url,
      uploadDate: media.meta.uploadDate || null,
      chapters: media.chapters,
      description: media.meta.description || undefined,
      tags: media.meta.tags || undefined,
    },
    media: { path: media.videoPath, offset: media.offset, ...probe },
    range: { start: round(A), end: round(B), duration: round(dur), startTime: fmtTime(A), endTime: fmtTime(B) },
    settings: { sceneThreshold: threshold, softTransitionThreshold: softThreshold, overviewFps: fps, grid: `${cols}x${rows}`, tileWidth, maxHeight },
    summary: {
      shots: pacing.totalShots,
      cuts: pacing.totalCuts,
      hardCuts: pacing.hardCuts,
      softTransitions: pacing.softTransitions,
      averageShotLength: pacing.averageShotLength,
      medianShotLength: pacing.medianShotLength,
      cutsPerMinute: pacing.cutsPerMinute,
      captionLines: cues.length,
      captionsKind: media.captionsKind,
      silences: signal.silences.length,
      lowMotionShare: activity.lowMotionShare,
      motionHotspots: activity.motionHotspots,
    },
    artifacts: {
      runDir,
      avTimeline: path.join(runDir, 'av-timeline.md'),
      pacingMetrics: path.join(runDir, 'pacing-metrics.json'),
      captions: cues.length ? path.join(runDir, 'captions.json') : null,
      audioStrip,
      contactSheets: sheets.map((s) => ({ ...s, startTime: fmtTime(s.start), endTime: fmtTime(s.end) })),
      styleFrames: styleFrames.map((f) => ({ path: f.path, t: f.t, time: f.time, shot: f.shot })),
    },
    nextSteps: [
      'Pass 1: read av-timeline.md and pacing-metrics.json, then view audio-strip.png and the contact sheets in order.',
      'Pass 2: view style-frames/* at full resolution for typography, palette, textures and layer stack.',
      ...activity.motionHotspots.map((h) => `Pass 3 candidate: inspect_motion_or_transition start=${fmtTime(h.start)} end=${fmtTime(h.end)} (activity ${h.activity})`),
    ],
  };
  writeJson(path.join(runDir, 'manifest.json'), manifest);
  log(`done in ${manifest.elapsedSec}s: ${pacing.totalShots} shots, ${sheets.length} sheets, ${styleFrames.length} style frames`);
  return manifest;
}

/** Pass 3: high-FPS contact sheets + audio strip for a short window. */
export async function zoom(source, opts = {}) {
  const started = Date.now();
  const start = parseTime(opts.start);
  const end = parseTime(opts.end);
  if (start === undefined || end === undefined || end <= start) throw new Error('zoom requires start < end');
  const { cols, rows } = parseGrid(opts.grid);
  const tileWidth = opts.tileWidth ?? 640;
  const maxFrames = opts.maxFrames ?? 96;
  let fps = Number(opts.fps ?? 8);
  if (!(fps > 0 && fps <= 60)) throw new Error('fps must be between 0 and 60');

  await requireTool('ffmpeg');
  await requireTool('ffprobe');
  const media = await acquire(source, { start, end, maxHeight: opts.maxHeight ?? 1080, cacheRoot: defaultCacheRoot(), captions: opts.captions });
  const probe = await probeMedia(media.videoPath);
  const { A, B, localStart, dur } = resolveRange(media, probe, start, end);
  let fpsAdjusted = false;
  if (dur * fps > maxFrames) { fps = round(maxFrames / dur, 3); fpsAdjusted = true; }

  const outDir = path.join(runDirFor(media, opts), 'zoom', `${fileTag(A)}_${fileTag(B)}_${fps}fps`);
  resetDir(outDir);
  const signal = await analyzeSignal(media.videoPath, { localStart, dur, absStart: A, hasAudio: probe.hasAudio });
  const { cuts } = findCuts(signal, A, opts.sceneThreshold ?? 0.3, opts.softThreshold ?? 0.35);
  const sheets = await renderContactSheets({ file: media.videoPath, localStart, dur, absStart: A, fps, cols, rows, tileWidth, outDir });
  const audioStrip = probe.hasAudio
    ? await renderAudioStrip({ file: media.videoPath, localStart, dur, absStart: A, cuts, silences: signal.silences, outFile: path.join(outDir, 'audio-strip.png') })
    : null;
  const cues = loadCaptions(media, A, B);
  const motion = signal.frames.map((f) => ({ t: round(f.t, 3), mafd: round(f.mafd, 3), score: round(f.score, 4) }));

  const result = {
    tool: `video-deconstructor ${VERSION}`,
    elapsedSec: round((Date.now() - started) / 1000, 1),
    source: { input: source, key: media.key, title: media.meta.title, url: media.meta.url },
    range: { start: round(A), end: round(B), duration: round(dur), startTime: fmtTime(A), endTime: fmtTime(B) },
    fps,
    fpsAdjusted: fpsAdjusted ? `reduced to keep <= ${maxFrames} frames; narrow the window or raise maxFrames for more` : false,
    frameInterval: `${round(1000 / fps, 1)} ms between tiles`,
    nativeFps: probe.fps,
    cuts,
    silences: signal.silences,
    narration: cues,
    motionCurve: {
      note: 'Per frame at native rate. mafd = mean absolute difference from the previous frame in % (how much moved: a rising then falling curve is ease-in/out, a decaying curve is ease-out). score = scene-change score (spikes = cuts or flashes).',
      frames: motion,
    },
    artifacts: {
      dir: outDir,
      contactSheets: sheets.map((s) => ({ ...s, startTime: fmtTime(s.start), endTime: fmtTime(s.end) })),
      audioStrip,
    },
  };
  writeJson(path.join(outDir, 'zoom.json'), result);
  const { motionCurve, ...summary } = result;
  return { ...summary, motionCurve: { note: motionCurve.note, frames: motion.length, file: path.join(outDir, 'zoom.json') } };
}

/** Full-resolution frames at exact timestamps. */
export async function frames(source, opts = {}) {
  const times = (Array.isArray(opts.timestamps) ? opts.timestamps : String(opts.timestamps || '').split(','))
    .map((t) => (typeof t === 'string' ? t.trim() : t)).filter((t) => t !== '').map(parseTime);
  if (!times.length) throw new Error('timestamps are required (e.g. ["00:05", "1:02.5", 75])');
  const format = opts.format === 'png' ? 'png' : 'jpg';
  await requireTool('ffmpeg');
  await requireTool('ffprobe');
  const lo = Math.min(...times);
  const hi = Math.max(...times);
  const media = await acquire(source, { start: lo, end: hi + 0.5, maxHeight: opts.maxHeight ?? 1080, cacheRoot: defaultCacheRoot(), captions: opts.captions });
  const probe = await probeMedia(media.videoPath);
  const outDir = ensureDir(path.join(runDirFor(media, opts), 'frames'));
  const fileEnd = media.offset + probe.duration;
  const bad = times.filter((t) => t < media.offset || t > fileEnd);
  if (bad.length) throw new Error(`Timestamps outside media range ${fmtTime(media.offset)}-${fmtTime(fileEnd)}: ${bad.map((t) => fmtTime(t)).join(', ')}`);
  const out = await extractFrames({ file: media.videoPath, offset: media.offset, items: times.map((t) => ({ t })), outDir, format, prefix: 'frame' });
  return {
    source: { input: source, key: media.key, title: media.meta.title, url: media.meta.url },
    resolution: `${probe.width}x${probe.height}`,
    frames: out.map((f) => ({ t: f.t, time: f.time, path: f.path })),
  };
}
