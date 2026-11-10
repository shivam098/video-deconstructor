import fs from 'node:fs';
import readline from 'node:readline';
import { overview, zoom, frames, transcribeSource, acquireMedia, VERSION } from './engine.mjs';
import { checkEnvironment } from './binaries.mjs';
import { whisperStatus, downloadWhisperModel, WHISPER_MODELS, DEFAULT_WHISPER_MODEL } from './transcribe.mjs';
import { geminiAnalyze, geminiKeyConfigured, DEFAULT_GEMINI_MODEL } from './gemini.mjs';

export async function fullEnvironment() {
  const env = await checkEnvironment();
  env.whisper = await whisperStatus();
  env.gemini = {
    apiKeyConfigured: geminiKeyConfigured(),
    defaultModel: process.env.VD_GEMINI_MODEL || DEFAULT_GEMINI_MODEL,
    setup: geminiKeyConfigured() ? undefined : 'create a free key at https://aistudio.google.com/apikey and set GEMINI_API_KEY.',
  };
  return env;
}

const source = { type: 'string', description: 'YouTube (or any yt-dlp supported) URL, or a local video file path.' };
const time = { type: ['string', 'number'], description: 'Seconds (75.5) or timestamp (MM:SS.mmm / HH:MM:SS).' };
const outputDir = { type: 'string', description: 'Optional folder for the outputs. Defaults to the per-user cache (see check_environment.cacheRoot).' };
const inlineImages = {
  type: 'integer', minimum: 0, maximum: 8, default: 0,
  description: 'Also return up to N generated images inline (base64). Use when your client cannot open local files; otherwise open the returned paths with your image/file viewer.',
};
const whisperModel = { type: 'string', enum: Object.keys(WHISPER_MODELS), description: `Whisper model (default: best installed, normally ${DEFAULT_WHISPER_MODEL}). ".en" models are English-only and more accurate for English.` };
const whisperLanguage = { type: 'string', default: 'auto', description: 'Spoken language: "auto" or an ISO 639-1 code (en, hi, es...). Use a multilingual model (no .en) for non-English audio.' };

export const TOOLS = [
  {
    name: 'check_environment',
    description: 'Check that yt-dlp, ffmpeg and ffprobe are installed and working (broken or blocked builds are reported), whether local Whisper transcription is set up, whether a Gemini API key is configured, and show install commands for this OS.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'deconstruct_video_overview',
    description: 'Pass 1+2 of a video production breakdown. Downloads/caches the video, detects every editorial cut, computes pacing (shot lengths, cuts/min), finds motion hotspots and silences, and writes: av-timeline.md (narration per shot), pacing-metrics.json, timestamped storyboard contact sheets, full-resolution style frames and an audio waveform+spectrogram strip with cut markers. Returns file paths: open the images to analyze style, motion and editing.',
    inputSchema: {
      type: 'object',
      required: ['source'],
      properties: {
        source,
        start: { ...time, description: 'Optional start of the range to analyze (only that section is downloaded).' },
        end: { ...time, description: 'Optional end of the range to analyze.' },
        overview_fps: { type: 'number', description: 'Storyboard sampling rate. Default: auto (<=1 fps, capped by max_sheets).' },
        max_sheets: { type: 'integer', minimum: 1, maximum: 60, default: 12, description: 'Maximum number of storyboard contact sheets.' },
        max_style_frames: { type: 'integer', minimum: 0, maximum: 60, default: 12, description: 'Full-resolution frames to capture (one per representative shot).' },
        scene_threshold: { type: 'number', minimum: 0.05, maximum: 0.9, default: 0.3, description: 'Scene-change score needed to count a hard cut. Lower for soft cuts, higher for busy footage.' },
        soft_threshold: { type: 'number', minimum: 0, maximum: 0.9, default: 0.35, description: 'Score (frames 0.25 s apart) needed to count a gradual transition such as a dissolve or wipe. 0 disables soft transitions.' },
        grid: { type: 'string', default: '4x4', description: 'Contact sheet layout COLSxROWS.' },
        max_height: { type: 'integer', default: 1080, description: 'Maximum download resolution.' },
        transcribe: {
          type: 'string', enum: ['auto', 'always', 'never'], default: 'auto',
          description: 'Local Whisper transcription of the narration. auto = only when the video has no captions and a model is installed; always = transcribe even if captions exist (e.g. poor auto-captions).',
        },
        whisper_model: whisperModel,
        whisper_language: whisperLanguage,
        whisper_translate: { type: 'boolean', default: false, description: 'Translate non-English speech to English.' },
        output_dir: outputDir,
        inline_images: inlineImages,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'inspect_motion_or_transition',
    description: 'Pass 3: zoom into a short window (ideally 2-10 s) at high frame rate (default 8 fps) to reverse-engineer a transition, animation, camera move or easing curve. Returns timestamped contact sheets, a per-frame motion curve, cuts, narration and an audio strip for the window.',
    inputSchema: {
      type: 'object',
      required: ['source', 'start', 'end'],
      properties: {
        source,
        start: time,
        end: time,
        fps: { type: 'number', minimum: 0.5, maximum: 60, default: 8, description: 'Tiles per second of video.' },
        grid: { type: 'string', default: '4x4', description: 'Contact sheet layout COLSxROWS.' },
        tile_width: { type: 'integer', default: 640, description: 'Width of each tile in pixels.' },
        max_frames: { type: 'integer', default: 96, description: 'Cap on tiles; fps is reduced if the window would exceed it.' },
        output_dir: outputDir,
        inline_images: inlineImages,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'extract_highres_style_frames',
    description: 'Extract full-resolution frames at exact timestamps to study typography, colour palette, textures, lighting and layer composition.',
    inputSchema: {
      type: 'object',
      required: ['source', 'timestamps'],
      properties: {
        source,
        timestamps: { type: 'array', items: time, minItems: 1, maxItems: 40 },
        format: { type: 'string', enum: ['jpg', 'png'], default: 'jpg' },
        output_dir: outputDir,
        inline_images: inlineImages,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'setup_whisper',
    description: 'Download a Whisper speech-to-text model (one-time, from huggingface.co/ggerganov/whisper.cpp) so videos without captions can be transcribed locally. base.en is ~142 MB.',
    inputSchema: {
      type: 'object',
      properties: { model: { ...whisperModel, default: DEFAULT_WHISPER_MODEL } },
      additionalProperties: false,
    },
  },
  {
    name: 'transcribe_audio',
    description: 'Transcribe the speech in a video (or a start-end section) locally with Whisper. Returns timestamped segments and writes a transcript file. No captions or API key needed; requires a model from setup_whisper.',
    inputSchema: {
      type: 'object',
      required: ['source'],
      properties: {
        source,
        start: time,
        end: time,
        model: whisperModel,
        language: whisperLanguage,
        translate: { type: 'boolean', default: false, description: 'Translate non-English speech to English.' },
        output_dir: outputDir,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'gemini_analyze_video',
    description: 'OPTIONAL, needs the user\'s GEMINI_API_KEY. Sends the video to Google Gemini, which natively watches motion and listens to audio, and returns its written analysis (default prompt: full production breakdown). YouTube URLs are passed directly (public videos only); local files are uploaded to Google. On the free tier Google may use submitted content to improve its products, so only use when the user has opted in. Complements the local tools; do not use it as a replacement for measured cut/pacing data.',
    inputSchema: {
      type: 'object',
      required: ['source'],
      properties: {
        source,
        prompt: { type: 'string', description: 'Question or instructions for Gemini. Default: a structured "how was this made" production breakdown.' },
        model: { type: 'string', description: `Gemini model id (default ${DEFAULT_GEMINI_MODEL} or VD_GEMINI_MODEL).` },
        start: { ...time, description: 'Clip start (static processing only).' },
        end: { ...time, description: 'Clip end (static processing only).' },
        fps: { type: 'number', minimum: 0.1, maximum: 24, description: 'Frames per second Gemini samples (default 1; raise for fast motion, static processing only).' },
        processing: { type: 'string', enum: ['static', 'agentic'], default: 'static', description: 'agentic = Gemini navigates long videos itself (more efficient for >5-10 min).' },
        output_dir: outputDir,
      },
      additionalProperties: false,
    },
  },
];

function imageContent(paths, n) {
  return paths.filter(Boolean).slice(0, n).flatMap((p) => {
    try {
      return [{ type: 'image', data: fs.readFileSync(p).toString('base64'), mimeType: p.endsWith('.png') ? 'image/png' : 'image/jpeg' }];
    } catch { return []; }
  });
}

export async function callTool(name, args = {}) {
  const n = Math.max(0, Math.min(8, Number(args.inline_images) || 0));
  let result;
  let images = [];
  switch (name) {
    case 'check_environment':
      result = await fullEnvironment();
      break;
    case 'deconstruct_video_overview':
      result = await overview(args.source, {
        start: args.start, end: args.end, overviewFps: args.overview_fps, maxSheets: args.max_sheets,
        maxStyleFrames: args.max_style_frames, sceneThreshold: args.scene_threshold, softThreshold: args.soft_threshold, grid: args.grid,
        maxHeight: args.max_height, outputDir: args.output_dir, transcribe: args.transcribe, whisperModel: args.whisper_model,
        whisperLanguage: args.whisper_language, whisperTranslate: args.whisper_translate,
      });
      images = [result.artifacts.audioStrip, ...result.artifacts.contactSheets.map((s) => s.file), ...result.artifacts.styleFrames.map((f) => f.path)];
      break;
    case 'inspect_motion_or_transition':
      result = await zoom(args.source, {
        start: args.start, end: args.end, fps: args.fps, grid: args.grid, tileWidth: args.tile_width,
        maxFrames: args.max_frames, outputDir: args.output_dir,
      });
      images = [...result.artifacts.contactSheets.map((s) => s.file), result.artifacts.audioStrip];
      break;
    case 'extract_highres_style_frames':
      result = await frames(args.source, { timestamps: args.timestamps, format: args.format, outputDir: args.output_dir });
      images = result.frames.map((f) => f.path);
      break;
    case 'setup_whisper':
      result = await downloadWhisperModel(args.model || DEFAULT_WHISPER_MODEL);
      break;
    case 'transcribe_audio':
      result = await transcribeSource(args.source, {
        start: args.start, end: args.end, model: args.model, language: args.language, translate: args.translate, outputDir: args.output_dir,
      });
      break;
    case 'gemini_analyze_video':
      result = await geminiAnalyze(args.source, {
        prompt: args.prompt, model: args.model, start: args.start, end: args.end, fps: args.fps, processing: args.processing,
        outputDir: args.output_dir, acquireFile: (src) => acquireMedia(src),
      });
      break;
    default:
      throw Object.assign(new Error(`Unknown tool: ${name}`), { rpcCode: -32602 });
  }
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }, ...imageContent(images, n)] };
}

/** Minimal MCP server over stdio (newline-delimited JSON-RPC 2.0), no dependencies. */
export function startMcpServer({ input = process.stdin, output = process.stdout } = {}) {
  process.env.VD_MCP = '1';
  const send = (msg) => output.write(`${JSON.stringify(msg)}\n`);
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const { id, method, params } = msg;
    const reply = (result) => id !== undefined && send({ jsonrpc: '2.0', id, result });
    const fail = (code, message) => id !== undefined && send({ jsonrpc: '2.0', id, error: { code, message } });
    try {
      switch (method) {
        case 'initialize':
          reply({
            protocolVersion: params?.protocolVersion || '2025-06-18',
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'video-deconstructor', version: VERSION },
            instructions: 'Use deconstruct_video_overview first, then open the returned images/files. Zoom into motion hotspots with inspect_motion_or_transition and capture detail frames with extract_highres_style_frames.',
          });
          break;
        case 'ping':
          reply({});
          break;
        case 'tools/list':
          reply({ tools: TOOLS });
          break;
        case 'tools/call':
          try {
            reply(await callTool(params?.name, params?.arguments || {}));
          } catch (e) {
            if (e.rpcCode) fail(e.rpcCode, e.message);
            else reply({ isError: true, content: [{ type: 'text', text: `Error: ${e.message}` }] });
          }
          break;
        default:
          if (method?.startsWith('notifications/')) break;
          fail(-32601, `Method not found: ${method}`);
      }
    } catch (e) {
      fail(-32603, e.message);
    }
  });
  rl.on('close', () => process.exit(0));
}
