#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { overview, zoom, frames, transcribeSource, acquireMedia, VERSION } from '../src/engine.mjs';
import { startMcpServer, fullEnvironment } from '../src/mcp-server.mjs';
import { downloadWhisperModel, DEFAULT_WHISPER_MODEL, WHISPER_MODELS } from '../src/transcribe.mjs';
import { geminiAnalyze } from '../src/gemini.mjs';

const HELP = `video-deconstructor ${VERSION}

Turn a video into artifacts a multimodal LLM can analyze: storyboard contact
sheets, style frames, an audio strip, pacing metrics and an A/V script.

Usage:
  video-deconstructor doctor
  video-deconstructor overview <url|file> [--start T] [--end T] [--fps N] [--max-sheets N]
                               [--max-style-frames N] [--threshold 0.3] [--soft-threshold 0.35]
                               [--grid 4x4] [--max-height 1080]
                               [--transcribe auto|always|never] [--whisper-model M] [--language L] [--translate]
  video-deconstructor zoom <url|file> --start T --end T [--fps 8] [--grid 4x4] [--tile-width 640] [--max-frames 96]
  video-deconstructor frames <url|file> --timestamps T1,T2,... [--format jpg|png]
  video-deconstructor setup-whisper [--model ${DEFAULT_WHISPER_MODEL}]     Download a local speech-to-text model
  video-deconstructor transcribe <url|file> [--start T] [--end T] [--model M] [--language L] [--translate]
  video-deconstructor gemini <url|file> [--prompt TEXT | --prompt-file F] [--model M]
                             [--start T] [--end T] [--fps N] [--agentic]   Needs GEMINI_API_KEY
  video-deconstructor mcp            Start the MCP server on stdio

Common options:
  --out DIR        Output folder for this run (default: ./vd-output/<video-key>)
  --captions FILE  Captions (.vtt/.srt) for a local video (default: sidecar file with the same name)
  --json           Print the full JSON result

Whisper models: ${Object.keys(WHISPER_MODELS).join(', ')}
Times: seconds (75.5), MM:SS(.mmm) or HH:MM:SS.
Environment: VD_FFMPEG, VD_FFPROBE, VD_YTDLP (binary paths), VD_CACHE_DIR, VD_OUTPUT_DIR, VD_FONT, VD_JS_RUNTIME,
             VD_WHISPER_MODEL, VD_WHISPER_CLI, GEMINI_API_KEY, VD_GEMINI_MODEL.
`;

function parseArgs(argv) {
  const pos = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split(/=(.*)/s);
      const key = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (inline !== undefined) opts[key] = inline;
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) opts[key] = argv[++i];
      else opts[key] = true;
    } else pos.push(a);
  }
  return { pos, opts };
}

const num = (v) => (v === undefined ? undefined : Number(v));

function printSummary(cmd, r) {
  const lines = [];
  if (cmd === 'overview') {
    const s = r.summary;
    lines.push(`${r.source.title}${r.source.channel ? ` - ${r.source.channel}` : ''}`);
    lines.push(`Range ${r.range.startTime}-${r.range.endTime} | ${r.media.width}x${r.media.height} @ ${r.media.fps} fps | ${r.elapsedSec}s`);
    lines.push(`Shots ${s.shots} (${s.hardCuts} hard cuts, ${s.softTransitions} soft transitions) | cuts/min ${s.cutsPerMinute} | avg shot ${s.averageShotLength}s | median ${s.medianShotLength}s | low-motion ${Math.round(s.lowMotionShare * 100)}%`);
    lines.push(`Narration: ${s.captionLines ? `${s.captionLines} lines (${s.captionsKind})` : 'none'} | silences: ${s.silences}`);
    if (s.narrationNote) lines.push(`  note: ${s.narrationNote}`);
    if (s.motionHotspots.length) lines.push(`Motion hotspots: ${s.motionHotspots.map((h) => `${h.start}-${h.end}s`).join(', ')}`);
    lines.push('', `Output: ${r.artifacts.runDir}`);
    lines.push(`  av-timeline.md, pacing-metrics.json, manifest.json, ${r.artifacts.audioStrip ? 'audio-strip.png, ' : ''}`
      + `contact-sheets/ (${r.artifacts.contactSheets.length}), style-frames/ (${r.artifacts.styleFrames.length})`);
  } else if (cmd === 'zoom') {
    lines.push(`${r.source.title} | ${r.range.startTime}-${r.range.endTime} @ ${r.fps} fps (${r.frameInterval})${r.fpsAdjusted ? ' [fps reduced]' : ''}`);
    lines.push(`Cuts in window: ${r.cuts.length} | narration lines: ${r.narration.length}`);
    lines.push(`Output: ${r.artifacts.dir}`);
    for (const s of r.artifacts.contactSheets) lines.push(`  ${path.basename(s.file)}  ${s.startTime}-${s.endTime} (${s.frames} frames)`);
  } else if (cmd === 'frames') {
    lines.push(`${r.source.title} | ${r.resolution}`);
    for (const f of r.frames) lines.push(`  ${f.time}  ${f.path}`);
  } else if (cmd === 'transcribe') {
    lines.push(`${r.source.title} | ${r.range.startTime}-${r.range.endTime} | ${r.narrationSource} | ${r.segments} segments`);
    lines.push(`Transcript: ${r.transcript}`);
    for (const c of r.cues.slice(0, 8)) lines.push(`  ${c.start.toFixed(2).padStart(8)}s  ${c.text}`);
    if (r.cues.length > 8) lines.push(`  ... ${r.cues.length - 8} more`);
  } else if (cmd === 'gemini') {
    lines.push(r.text, '', `[${r.model}, ${r.processing}, ${r.elapsedSec}s] saved to ${r.file}`);
  }
  console.log(lines.join('\n'));
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, opts } = parseArgs(rest);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') { console.log(HELP); return; }
  if (cmd === '--version' || cmd === 'version') { console.log(VERSION); return; }
  if (cmd === 'mcp') { startMcpServer(); return; }

  if (cmd === 'doctor') {
    const env = await fullEnvironment();
    if (opts.json) { console.log(JSON.stringify(env, null, 2)); return; }
    console.log(`video-deconstructor ${VERSION} on ${env.platform}, Node ${env.node}`);
    for (const [name, t] of Object.entries(env.tools)) {
      console.log(t.ok ? `  OK   ${name} ${t.version}  (${t.path})` : `  MISSING ${name}  -> ${t.install}`);
      for (const r of t.rejected || []) console.log(`       skipped ${r.path}: ${r.reason}`);
    }
    if (env.ffmpegFilters) {
      const missing = Object.entries(env.ffmpegFilters).filter(([, ok]) => !ok).map(([f]) => f);
      console.log(missing.length ? `  WARN ffmpeg lacks filters: ${missing.join(', ')}` : '  OK   ffmpeg filters');
    }
    console.log(`  font: ${env.font || 'none found (set VD_FONT)'}\n  yt-dlp JS runtime: ${env.jsRuntime}\n  cache: ${env.cacheRoot}`);
    const w = env.whisper;
    console.log(w.ready ? `  OK   Whisper (${w.backend}; models: ${w.installedModels.join(', ')})`
      : `  OPTIONAL Whisper transcription: ${w.backend ? `backend ${w.backend} found; ${w.setup}` : w.backendHint}`);
    console.log(env.gemini.apiKeyConfigured ? `  OK   Gemini API key set (model ${env.gemini.defaultModel})` : `  OPTIONAL Gemini: ${env.gemini.setup}`);
    console.log(env.ready ? (env.youtubeReady ? 'Ready.' : 'Ready for local files; install yt-dlp for URLs.') : 'Not ready.');
    process.exitCode = env.ready ? 0 : 1;
    return;
  }

  if (cmd === 'setup-whisper') {
    const r = await downloadWhisperModel(opts.model || DEFAULT_WHISPER_MODEL);
    console.log(r.downloaded ? `Downloaded Whisper model ${r.name} (${r.sizeMB} MB) to ${r.path}` : `Whisper model ${r.name} already installed: ${r.path}`);
    return;
  }

  const src = pos[0];
  if (!src) throw new Error(`Missing <url|file>. Run "video-deconstructor help".`);
  const common = {
    outputDir: opts.out,
    outputBase: path.resolve(process.env.VD_OUTPUT_DIR || 'vd-output'),
    captions: opts.captions,
    maxHeight: num(opts.maxHeight),
  };
  let result;
  if (cmd === 'overview') {
    result = await overview(src, {
      ...common, start: opts.start, end: opts.end, overviewFps: num(opts.fps), maxSheets: num(opts.maxSheets),
      maxStyleFrames: num(opts.maxStyleFrames), sceneThreshold: num(opts.threshold), softThreshold: num(opts.softThreshold),
      grid: opts.grid, tileWidth: num(opts.tileWidth), transcribe: opts.transcribe, whisperModel: opts.whisperModel,
      whisperLanguage: opts.language, whisperTranslate: Boolean(opts.translate),
    });
  } else if (cmd === 'zoom') {
    result = await zoom(src, {
      ...common, start: opts.start, end: opts.end, fps: num(opts.fps), grid: opts.grid, tileWidth: num(opts.tileWidth),
      maxFrames: num(opts.maxFrames), sceneThreshold: num(opts.threshold), softThreshold: num(opts.softThreshold),
    });
  } else if (cmd === 'frames') {
    result = await frames(src, { ...common, timestamps: opts.timestamps, format: opts.format });
  } else if (cmd === 'transcribe') {
    result = await transcribeSource(src, {
      ...common, start: opts.start, end: opts.end, model: opts.model, language: opts.language, translate: Boolean(opts.translate),
    });
  } else if (cmd === 'gemini') {
    const prompt = opts.promptFile ? fs.readFileSync(opts.promptFile, 'utf8') : opts.prompt;
    result = await geminiAnalyze(src, {
      prompt, model: opts.model, start: opts.start, end: opts.end, fps: num(opts.fps), processing: opts.agentic ? 'agentic' : 'static',
      outputDir: opts.out, outputBase: common.outputBase, acquireFile: (s) => acquireMedia(s, common),
    });
  } else {
    throw new Error(`Unknown command "${cmd}". Run "video-deconstructor help".`);
  }
  if (opts.json) console.log(JSON.stringify(result, null, 2));
  else printSummary(cmd, result);
}

main().catch((e) => {
  console.error(`Error: ${e.message}`);
  process.exitCode = 1;
});
