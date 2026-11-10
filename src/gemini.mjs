import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { log, ensureDir, round, isUrl, fmtTime, parseTime, run, describeExit, slug, hash8 } from './util.mjs';
import { requireTool, defaultCacheRoot } from './binaries.mjs';

const youtubeKey = (url) => {
  const m = String(url).match(/(?:youtu\.be\/|[?&]v=|\/shorts\/|\/embed\/|\/live\/)([A-Za-z0-9_-]{11})/);
  return m ? `youtube-${m[1]}` : null;
};

export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';

export const DEFAULT_GEMINI_PROMPT = `You are a senior video editor, motion designer and sound designer. Deconstruct how this video was made.
Cite every observation with MM:SS timestamps. Separate what you directly observe from what you infer (for example which software was used), and label inferences.

1. Summary: style archetype, overall pacing, dominant visual modes (A-roll, B-roll, archival, 2D/2.5D animation, 3D, maps, charts, kinetic type, screen recordings) and their rough share.
2. Structure: hook, sections, turns and payoff, with timestamps, what the narration does and what the visuals do in each.
3. Editing: cut rhythm and how it changes, how cuts relate to narration and music, transitions used.
4. Visual design system: layer stack, colour roles, typography, textures, graphic devices, lighting/rendering for 3D.
5. Motion: 3-6 signature animations or camera moves, frame-by-frame, with likely keyframing and easing.
6. Sound: music, sound effects, silences and how they support the picture.
7. Recreation recipe: concrete steps in named tools (After Effects, Blender, DaVinci Resolve, Premiere, Manim, Motion Canvas, Remotion...) to reproduce the look and feel.`;

const SUPPORTED_MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mpeg': 'video/mpeg', '.mpg': 'video/mpg', '.mov': 'video/mov',
  '.avi': 'video/avi', '.flv': 'video/x-flv', '.webm': 'video/webm', '.wmv': 'video/wmv', '.3gp': 'video/3gpp',
};
const FREE_TIER_UPLOAD_LIMIT = 2 * 1024 ** 3;

const baseUrl = () => (process.env.VD_GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
export const geminiKeyConfigured = () => Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
const isYouTube = (s) => /^https?:\/\/(www\.|m\.|music\.)?(youtube\.com|youtu\.be)\//i.test(String(s));

function apiKey() {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key) {
    throw new Error('GEMINI_API_KEY is not set. Create a free key at https://aistudio.google.com/apikey and set it as an environment variable '
      + '(or in the "env" block of your MCP server config).');
  }
  return key;
}

async function api(method, url, { body, headers = {}, raw = false } = {}) {
  const res = await fetch(url, {
    method,
    headers: { 'x-goog-api-key': apiKey(), ...(body && !raw ? { 'content-type': 'application/json' } : {}), ...headers },
    body: raw ? body : body ? JSON.stringify(body) : undefined,
    ...(raw && body instanceof ReadableStream ? { duplex: 'half' } : {}),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
  if (!res.ok) {
    const msg = json?.error?.message || text.slice(0, 300) || res.statusText;
    const hint = res.status === 429 ? ' (rate limit or free-tier quota reached; see https://aistudio.google.com/rate-limit)'
      : res.status === 400 && /api key/i.test(msg) ? ' (check GEMINI_API_KEY)' : '';
    throw new Error(`Gemini API ${method} ${new URL(url).pathname} failed: HTTP ${res.status} ${msg}${hint}`);
  }
  return { json, headers: res.headers };
}

/** Gemini only accepts common containers; transcode anything else to H.264/AAC MP4 first. */
async function ensureSupportedContainer(file) {
  const ext = path.extname(file).toLowerCase();
  if (SUPPORTED_MIME[ext]) return { file, mime: SUPPORTED_MIME[ext] };
  const ff = await requireTool('ffmpeg');
  const abs = path.resolve(file);
  const st = fs.statSync(abs);
  const out = path.join(ensureDir(path.join(defaultCacheRoot(), 'gemini-uploads')),
    `${slug(path.parse(abs).name, 40)}-${hash8(`${abs}|${st.size}|${st.mtimeMs}`)}.mp4`);
  if (!fs.existsSync(out)) {
    log(`converting ${path.basename(file)} to MP4 for Gemini`);
    const part = `${out}.part.mp4`;
    const r = await run(ff.cmd, [...ff.prefix, '-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-i', abs,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', part]);
    if (r.code !== 0) {
      fs.rmSync(part, { force: true });
      throw new Error(`Conversion to MP4 failed (${describeExit(r)}): ${r.stderr.trim().slice(-300)}`);
    }
    fs.renameSync(part, out);
  }
  return { file: out, mime: 'video/mp4' };
}

/** Upload a local file with the resumable Files API and wait until it is ACTIVE. */
export async function uploadToGemini(file, { pollMs = 5000, maxWaitSec = 900 } = {}) {
  const { file: upFile, mime } = await ensureSupportedContainer(file);
  const size = fs.statSync(upFile).size;
  if (size > FREE_TIER_UPLOAD_LIMIT) log('warning: file is larger than the free-tier upload limit (2 GB)');
  log(`uploading ${path.basename(upFile)} (${round(size / 1048576, 1)} MB) to Gemini Files API`);
  const start = await api('POST', `${baseUrl()}/upload/v1beta/files`, {
    headers: {
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(size),
      'X-Goog-Upload-Header-Content-Type': mime,
    },
    body: { file: { display_name: path.basename(upFile) } },
  });
  const uploadUrl = start.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new Error('Gemini Files API did not return an upload URL.');
  const done = await api('POST', uploadUrl, {
    raw: true,
    headers: { 'Content-Length': String(size), 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' },
    body: Readable.toWeb(fs.createReadStream(upFile)),
  });
  let info = done.json?.file;
  if (!info?.name) throw new Error('Gemini Files API returned no file name.');
  const deadline = Date.now() + maxWaitSec * 1000;
  while (info.state !== 'ACTIVE') {
    if (info.state === 'FAILED') throw new Error(`Gemini could not process the uploaded video: ${JSON.stringify(info.error || {})}`);
    if (Date.now() > deadline) throw new Error('Timed out waiting for Gemini to process the uploaded video.');
    await new Promise((r) => setTimeout(r, pollMs));
    info = (await api('GET', `${baseUrl()}/v1beta/${info.name}`)).json;
  }
  return { name: info.name, uri: info.uri, mimeType: info.mimeType || mime };
}

/** Pull the model's text out of an Interactions API response. */
export function interactionText(data) {
  if (!data) return '';
  if (typeof data.output_text === 'string') return data.output_text;
  const fromSteps = (data.steps || [])
    .filter((s) => s.type === 'model_output')
    .flatMap((s) => (s.content || []).filter((c) => c.type === 'text').map((c) => c.text));
  if (fromSteps.length) return fromSteps.join('\n');
  const fromOutputs = (data.outputs || []).filter((o) => o.type === 'text' && o.text).map((o) => o.text);
  if (fromOutputs.length) return fromOutputs.join('\n');
  return (data.candidates?.[0]?.content?.parts || []).map((p) => p.text).filter(Boolean).join('\n');
}

/**
 * Send a video to Gemini with a prompt. YouTube URLs are passed through
 * directly; local files (and other URLs, downloaded via `acquireFile`) are
 * uploaded with the Files API.
 */
export async function geminiAnalyze(source, opts = {}) {
  apiKey();
  const started = Date.now();
  const model = opts.model || process.env.VD_GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  const prompt = opts.prompt?.trim() || DEFAULT_GEMINI_PROMPT;
  const mode = opts.processing === 'agentic' ? 'agentic' : 'static';
  const start = parseTime(opts.start);
  const end = parseTime(opts.end);
  const fps = opts.fps === undefined ? undefined : Number(opts.fps);
  if (mode === 'agentic' && (start !== undefined || end !== undefined || fps !== undefined)) {
    throw new Error('start/end/fps are only supported with processing "static".');
  }

  let video;
  let key;
  if (isYouTube(source)) {
    video = { type: 'video', uri: source.trim() };
    key = youtubeKey(source);
  } else {
    let file = source;
    if (isUrl(source)) {
      if (!opts.acquireFile) throw new Error('Non-YouTube URLs must be downloaded first.');
      ({ file, key } = await opts.acquireFile(source));
    } else {
      file = path.resolve(source);
      if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);
      const st = fs.statSync(file);
      key = `local-${slug(path.parse(file).name, 40)}-${hash8(`${file}|${st.size}|${st.mtimeMs}`)}`;
    }
    const up = await uploadToGemini(file, { pollMs: opts.pollMs, maxWaitSec: opts.maxWaitSec });
    video = { type: 'video', uri: up.uri, mime_type: up.mimeType };
  }
  if (mode === 'agentic') video.processing = 'agentic';
  else if (start !== undefined || end !== undefined || fps !== undefined) {
    video.processing = {
      type: 'static',
      ...(start !== undefined ? { start_offset: `${start}s` } : {}),
      ...(end !== undefined ? { end_offset: `${end}s` } : {}),
      ...(fps !== undefined ? { fps } : {}),
    };
  }

  const body = { model, input: [video, { type: 'text', text: prompt }], ...(mode === 'agentic' ? { background: true } : {}) };
  log(`asking ${model} (${mode})`);
  let data = (await api('POST', `${baseUrl()}/v1beta/interactions`, { body })).json;
  const deadline = Date.now() + (opts.maxWaitSec ?? 900) * 1000;
  while (data && ['in_progress', 'queued', 'pending', 'running'].includes(String(data.status).toLowerCase()) && data.id) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for Gemini interaction ${data.id}.`);
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 5000));
    data = (await api('GET', `${baseUrl()}/v1beta/interactions/${data.id}`)).json;
  }
  if (data?.status && /fail|error|cancel/i.test(data.status)) throw new Error(`Gemini interaction ${data.status}: ${JSON.stringify(data.error || {})}`);
  const text = interactionText(data);
  if (!text) throw new Error('Gemini returned no text output.');

  const runDir = opts.outputDir ? path.resolve(opts.outputDir)
    : path.join(path.resolve(opts.outputBase || process.env.VD_OUTPUT_DIR || path.join(defaultCacheRoot(), 'runs')), key || 'gemini');
  const outDir = ensureDir(path.join(runDir, 'gemini'));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(outDir, `gemini-${stamp}.md`);
  const range = start !== undefined || end !== undefined ? ` | range ${fmtTime(start ?? 0)}-${end !== undefined ? fmtTime(end) : 'end'}` : '';
  fs.writeFileSync(file, [
    `# Gemini analysis`, '',
    `- Source: ${source}`, `- Model: ${model} (${mode}${fps !== undefined ? `, ${fps} fps` : ''}${range})`,
    `- Generated: ${new Date().toISOString()}`, '', '## Prompt', '', prompt, '', '## Response', '', text, '',
  ].join('\n'));
  return {
    model, processing: mode, source, prompt: opts.prompt ? 'custom' : 'default production-breakdown prompt',
    elapsedSec: round((Date.now() - started) / 1000, 1), usage: data.usage || data.usage_metadata || null, file, text,
  };
}
