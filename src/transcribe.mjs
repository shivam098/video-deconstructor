import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { run, describeExit, log, ensureDir, filterValue, round } from './util.mjs';
import { requireTool, resolveTool, defaultCacheRoot } from './binaries.mjs';
import { parseCaptions } from './timeline.mjs';

/** whisper.cpp GGML models published at huggingface.co/ggerganov/whisper.cpp. */
export const WHISPER_MODELS = {
  'tiny.en': 75, tiny: 75,
  'base.en': 142, base: 142,
  'small.en': 466, small: 466,
  'medium.en': 1500, medium: 1500,
  'large-v3-turbo': 1600,
};
export const DEFAULT_WHISPER_MODEL = 'base.en';
const MODEL_PREFERENCE = ['base.en', 'small.en', 'base', 'small', 'large-v3-turbo', 'medium.en', 'medium', 'tiny.en', 'tiny'];
const modelUrl = (name) => `${process.env.VD_WHISPER_MODEL_BASE_URL || 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main'}/ggml-${name}.bin`;

export const modelsDir = () => path.join(defaultCacheRoot(), 'models');

function isModelFile(p) {
  try {
    if (fs.statSync(p).size < 1024 * 1024) return false;
    const fd = fs.openSync(p, 'r');
    const b = Buffer.alloc(4);
    fs.readSync(fd, b, 0, 4, 0);
    fs.closeSync(fd);
    return b.toString('latin1') === 'lmgg' || b.toString('latin1') === 'ggml';
  } catch { return false; }
}

/** Locate a model: VD_WHISPER_MODEL path, a named model in the cache, or the best cached one. */
export function findWhisperModel(name) {
  if (process.env.VD_WHISPER_MODEL) {
    const p = path.resolve(process.env.VD_WHISPER_MODEL);
    return isModelFile(p) ? { name: path.basename(p), path: p } : null;
  }
  const names = name ? [name] : MODEL_PREFERENCE;
  for (const n of names) {
    const p = path.join(modelsDir(), `ggml-${n}.bin`);
    if (isModelFile(p)) return { name: n, path: p };
  }
  return null;
}

export function installedWhisperModels() {
  try {
    return fs.readdirSync(modelsDir())
      .filter((f) => /^ggml-.+\.bin$/.test(f) && isModelFile(path.join(modelsDir(), f)))
      .map((f) => f.replace(/^ggml-|\.bin$/g, ''));
  } catch { return []; }
}

/** Download a whisper.cpp model into the cache (resumable via a .part file rename). */
export async function downloadWhisperModel(name = DEFAULT_WHISPER_MODEL) {
  if (!WHISPER_MODELS[name]) throw new Error(`Unknown Whisper model "${name}". Choose one of: ${Object.keys(WHISPER_MODELS).join(', ')}`);
  const existing = findWhisperModel(name);
  if (existing && !process.env.VD_WHISPER_MODEL) return { ...existing, downloaded: false };
  const dest = path.join(ensureDir(modelsDir()), `ggml-${name}.bin`);
  const part = `${dest}.part`;
  log(`downloading Whisper model ${name} (~${WHISPER_MODELS[name]} MB) from ${modelUrl(name)}`);
  const res = await fetch(modelUrl(name), { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Model download failed: HTTP ${res.status} ${res.statusText}`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(part));
  if (!isModelFile(part)) {
    fs.rmSync(part, { force: true });
    throw new Error('Downloaded file is not a whisper.cpp GGML model.');
  }
  fs.renameSync(part, dest);
  return { name, path: dest, downloaded: true, sizeMB: round(fs.statSync(dest).size / 1048576, 1) };
}

let backendCache;

/**
 * Pick a transcription backend: ffmpeg's built-in `whisper` filter (FFmpeg 8+
 * builds with whisper.cpp), else a whisper.cpp CLI (`whisper-cli`).
 */
export async function whisperBackend() {
  if (backendCache !== undefined) return backendCache;
  const ff = await resolveTool('ffmpeg');
  if (!ff.missing) {
    const r = await run(ff.cmd, [...ff.prefix, '-hide_banner', '-filters'], { timeoutMs: 30000 });
    if (/\swhisper\s/.test(r.stdout)) return (backendCache = { kind: 'ffmpeg-filter', cmd: ff.cmd });
  }
  const candidates = [process.env.VD_WHISPER_CLI, 'whisper-cli', 'whisper-cpp'].filter(Boolean);
  for (const c of candidates) {
    const r = await run(c, ['--help'], { timeoutMs: 20000 });
    if (r.code === 0 || /usage/i.test(r.stdout + r.stderr)) return (backendCache = { kind: 'whisper-cli', cmd: c });
  }
  return (backendCache = null);
}

export function whisperInstallHint() {
  if (process.platform === 'win32') return 'Use an ffmpeg 8+ build with the whisper filter (winget install Gyan.FFmpeg), or set VD_WHISPER_CLI to whisper-cli.exe from github.com/ggml-org/whisper.cpp releases.';
  if (process.platform === 'darwin') return 'brew install whisper-cpp (provides whisper-cli), or use an ffmpeg build with the whisper filter.';
  return 'Build whisper.cpp (github.com/ggml-org/whisper.cpp) and put whisper-cli on PATH, or use an ffmpeg 8+ build with --enable-whisper.';
}

export async function whisperStatus() {
  const backend = await whisperBackend();
  const models = installedWhisperModels();
  return {
    backend: backend ? backend.kind : null,
    backendHint: backend ? undefined : whisperInstallHint(),
    modelsDir: modelsDir(),
    installedModels: models,
    ready: Boolean(backend && (models.length || findWhisperModel())),
    setup: models.length ? undefined : 'video-deconstructor setup-whisper   (downloads base.en, ~142 MB)',
  };
}

/**
 * Transcribe [localStart, localStart+dur] of a media file. Returns caption
 * cues with absolute times (absStart added) and the SRT path written.
 */
export async function transcribe({ file, localStart = 0, dur, absStart = 0, outSrt, model, language = 'auto', translate = false }) {
  if (!/^(auto|[a-z]{2,3})$/.test(language)) throw new Error(`Invalid language "${language}". Use "auto" or an ISO 639-1 code such as en, hi, de.`);
  const backend = await whisperBackend();
  if (!backend) throw new Error(`No Whisper backend found. ${whisperInstallHint()}`);
  if (!model) throw new Error('No Whisper model installed. Run "video-deconstructor setup-whisper" (or the setup_whisper MCP tool) first.');
  ensureDir(path.dirname(outSrt));
  fs.rmSync(outSrt, { force: true });
  const ff = await requireTool('ffmpeg');
  const seek = ['-ss', localStart.toFixed(3), ...(dur ? ['-t', dur.toFixed(3)] : [])];
  const started = Date.now();

  if (backend.kind === 'ffmpeg-filter') {
    const attempt = async (gpu) => run(ff.cmd, [
      ...ff.prefix, '-hide_banner', '-nostdin', '-y', '-loglevel', 'error', ...seek, '-i', file, '-vn', '-sn',
      '-af', `aformat=sample_rates=16000:channel_layouts=mono,whisper=model=${filterValue(model.path)}:language=${language}`
        + `:translate=${translate ? 'true' : 'false'}:use_gpu=${gpu ? 'true' : 'false'}:queue=20:destination=${filterValue(outSrt)}:format=srt`,
      '-f', 'null', '-',
    ]);
    let r = await attempt(true);
    if (r.code !== 0) r = await attempt(false);
    if (r.code !== 0) throw new Error(`Whisper transcription failed (${describeExit(r)}): ${r.stderr.trim().slice(-400)}`);
  } else {
    const wav = outSrt.replace(/\.srt$/i, '') + '.16k.wav';
    const x = await run(ff.cmd, [...ff.prefix, '-hide_banner', '-nostdin', '-y', '-loglevel', 'error', ...seek, '-i', file, '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav]);
    if (x.code !== 0) throw new Error(`Audio extraction failed (${describeExit(x)}): ${x.stderr.trim().slice(-300)}`);
    try {
      const r = await run(backend.cmd, ['-m', model.path, '-f', wav, '-l', language, ...(translate ? ['-tr'] : []), '-osrt', '-of', outSrt.replace(/\.srt$/i, '')]);
      if (r.code !== 0) throw new Error(`whisper-cli failed (${describeExit(r)}): ${(r.stderr || r.stdout).trim().slice(-400)}`);
    } finally {
      fs.rmSync(wav, { force: true });
    }
  }
  if (!fs.existsSync(outSrt)) throw new Error('Whisper produced no transcript (the audio may contain no speech).');
  const cues = parseCaptions(fs.readFileSync(outSrt, 'utf8'), { rolling: false })
    .map((c) => ({ start: round(c.start + absStart), end: round(c.end + absStart), text: c.text }));
  return { cues, srt: outSrt, backend: backend.kind, model: model.name, elapsedSec: round((Date.now() - started) / 1000, 1) };
}
