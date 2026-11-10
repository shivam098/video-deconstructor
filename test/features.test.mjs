import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { run } from '../src/util.mjs';
import { resolveTool } from '../src/binaries.mjs';
import { findWhisperModel, whisperBackend, transcribe } from '../src/transcribe.mjs';
import { parseCaptions } from '../src/timeline.mjs';

process.env.VD_QUIET = '1';
const ff = await resolveTool('ffmpeg');
const model = findWhisperModel();
const backend = ff.missing ? null : await whisperBackend();
const hasFlite = !ff.missing && /\sflite\s/.test((await run(ff.cmd, ['-hide_banner', '-filters'])).stdout);
const whisperSkip = !model ? 'no Whisper model installed (run setup-whisper)' : !backend ? 'no Whisper backend' : !hasFlite ? 'ffmpeg lacks flite for test speech' : false;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vd-feat-'));
const realCache = process.env.VD_CACHE_DIR;
process.env.VD_CACHE_DIR = path.join(dir, 'cache');
if (model) process.env.VD_WHISPER_MODEL = model.path;
const { overview, transcribeSource } = await import('../src/engine.mjs');
const { geminiAnalyze, interactionText, DEFAULT_GEMINI_PROMPT } = await import('../src/gemini.mjs');

after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  if (realCache === undefined) delete process.env.VD_CACHE_DIR; else process.env.VD_CACHE_DIR = realCache;
});

// ------------------------------------------------------------------ Whisper

let speech;
before(async () => {
  if (whisperSkip) return;
  speech = path.join(dir, 'speech.mp4');
  const r = await run(ff.cmd, [
    '-hide_banner', '-nostdin', '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=navy:s=320x180:r=25:d=6',
    '-f', 'lavfi', '-i', "flite=text='The quick brown fox jumps over the lazy dog.':voice=slt",
    '-filter_complex', '[1:a]adelay=1500|1500,apad=whole_dur=6[a]',
    '-map', '0:v', '-map', '[a]', '-c:v', 'mpeg4', '-c:a', 'aac', '-shortest', speech,
  ]);
  assert.equal(r.code, 0, r.stderr);
});

test('overview transcribes uncaptioned speech with Whisper (absolute times)', { skip: whisperSkip }, async () => {
  const m = await overview(speech, { outputDir: path.join(dir, 'run-auto'), maxStyleFrames: 1 });
  assert.match(m.summary.captionsKind, /^Whisper transcription/);
  const text = JSON.parse(fs.readFileSync(m.artifacts.captions, 'utf8')).map((c) => c.text).join(' ').toLowerCase();
  assert.match(text, /fox/);
  assert.ok(fs.existsSync(m.artifacts.whisperTranscript));
  assert.match(fs.readFileSync(m.artifacts.avTimeline, 'utf8'), /Whisper transcription/);
});

test('transcribeSource offsets segment times by the section start', { skip: whisperSkip }, async () => {
  const r = await transcribeSource(speech, { start: 1, end: 6, outputDir: path.join(dir, 'run-tr') });
  assert.ok(r.segments >= 1);
  assert.ok(r.cues[0].start >= 1, `first cue at ${r.cues[0].start}`);
  assert.ok(fs.readFileSync(r.transcript, 'utf8').includes('fox'));
});

test('Whisper handles model and output paths with apostrophes, commas, spaces and brackets', { skip: whisperSkip }, async () => {
  const odd = path.join(dir, "it's, a [test] dir");
  fs.mkdirSync(odd, { recursive: true });
  const modelCopy = path.join(odd, "ggml-model's.bin");
  fs.copyFileSync(model.path, modelCopy);
  const r = await transcribe({ file: speech, outSrt: path.join(odd, "out's, [1].srt"), model: { name: 'copy', path: modelCopy }, language: 'en' });
  assert.ok(r.cues.some((c) => /fox/i.test(c.text)), JSON.stringify(r.cues));
  await assert.rejects(transcribe({ file: speech, outSrt: path.join(odd, 'x.srt'), model, language: "en'x" }), /Invalid language/);
});

test('a broken model does not abort an auto overview, but fails transcribe=always', { skip: whisperSkip }, async () => {
  const fake = path.join(dir, 'ggml-broken.bin');
  fs.writeFileSync(fake, Buffer.concat([Buffer.from('lmgg', 'latin1'), Buffer.alloc(2 * 1024 * 1024, 1)]));
  const saved = process.env.VD_WHISPER_MODEL;
  process.env.VD_WHISPER_MODEL = fake;
  try {
    const m = await overview(speech, { outputDir: path.join(dir, 'run-broken'), maxStyleFrames: 1, whisperLanguage: 'de' });
    assert.equal(m.summary.captionLines, 0);
    assert.match(m.summary.narrationNote, /Whisper transcription failed/);
    await assert.rejects(overview(speech, { outputDir: path.join(dir, 'run-broken2'), transcribe: 'always', whisperLanguage: 'fr' }), /Whisper transcription failed/);
  } finally {
    process.env.VD_WHISPER_MODEL = saved;
  }
});

test('transcribe=never skips Whisper; missing model yields a setup note', { skip: whisperSkip }, async () => {
  const never = await overview(speech, { outputDir: path.join(dir, 'run-never'), maxStyleFrames: 1, transcribe: 'never' });
  assert.equal(never.summary.captionLines, 0);
  const saved = process.env.VD_WHISPER_MODEL;
  process.env.VD_WHISPER_MODEL = path.join(dir, 'missing.bin');
  try {
    const none = await overview(speech, { outputDir: path.join(dir, 'run-nomodel'), maxStyleFrames: 1 });
    assert.equal(none.summary.captionLines, 0);
    assert.match(none.summary.narrationNote, /setup-whisper/);
    await assert.rejects(overview(speech, { outputDir: path.join(dir, 'run-always'), transcribe: 'always' }), /No Whisper model installed/);
  } finally {
    process.env.VD_WHISPER_MODEL = saved;
  }
});

test('parseCaptions keeps repeated lines when rolling de-duplication is off', () => {
  const srt = '1\n00:00:01,000 --> 00:00:02,000\nYeah.\n\n2\n00:00:02,000 --> 00:00:03,000\nYeah.\n';
  assert.equal(parseCaptions(srt).length, 1);
  assert.equal(parseCaptions(srt, { rolling: false }).length, 2);
});

// ------------------------------------------------------------------- Gemini

test('interactionText reads the supported response shapes', () => {
  assert.equal(interactionText({ output_text: 'a' }), 'a');
  assert.equal(interactionText({ steps: [{ type: 'thought' }, { type: 'model_output', content: [{ type: 'text', text: 'b' }] }] }), 'b');
  assert.equal(interactionText({ outputs: [{ type: 'text', text: 'c' }] }), 'c');
  assert.equal(interactionText({ candidates: [{ content: { parts: [{ text: 'd' }] } }] }), 'd');
});

function mockGemini() {
  const calls = [];
  let fileState = 0;
  let agenticPolls = 0;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const call = { method: req.method, url: req.url, headers: req.headers, size: body.length };
    calls.push(call);
    const json = (status, obj, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
    if (req.headers['x-goog-api-key'] !== 'test-key') return json(400, { error: { message: 'API key not valid' } });
    const base = `http://127.0.0.1:${server.address().port}`;
    if (req.url === '/upload/v1beta/files') return json(200, {}, { 'x-goog-upload-url': `${base}/upload-session/1` });
    if (req.url === '/upload-session/1') {
      call.declaredLength = req.headers['content-length'];
      return json(200, { file: { name: 'files/abc', uri: `${base}/v1beta/files/abc`, mimeType: 'video/mp4', state: 'PROCESSING' } });
    }
    if (req.url === '/v1beta/files/abc') return json(200, { name: 'files/abc', uri: `${base}/v1beta/files/abc`, mimeType: 'video/mp4', state: ++fileState >= 2 ? 'ACTIVE' : 'PROCESSING' });
    if (req.url === '/v1beta/interactions' && req.method === 'POST') {
      call.body = JSON.parse(body.toString());
      if (call.body.input[1].text === 'RATE') return json(429, { error: { message: 'Resource exhausted' } });
      if (call.body.background) return json(200, { id: 'int-1', status: 'in_progress' });
      return json(200, { id: 'int-0', status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'MOCK ANALYSIS' }] }], usage: { total_tokens: 42 } });
    }
    if (req.url === '/v1beta/interactions/int-1') {
      return json(200, ++agenticPolls < 2 ? { id: 'int-1', status: 'in_progress' } : { id: 'int-1', status: 'completed', output_text: 'AGENTIC DONE' });
    }
    return json(404, { error: { message: `no route ${req.url}` } });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls, base: `http://127.0.0.1:${server.address().port}` })));
}

test('gemini: YouTube URL is sent directly with clipping and fps', async () => {
  const m = await mockGemini();
  process.env.VD_GEMINI_BASE_URL = m.base;
  process.env.GEMINI_API_KEY = 'test-key';
  try {
    const r = await geminiAnalyze('https://www.youtube.com/watch?v=HoKkasEyDOI', { start: '0:10', end: 40, fps: 4, outputBase: path.join(dir, 'g1') });
    assert.equal(r.text, 'MOCK ANALYSIS');
    assert.equal(path.dirname(r.file), path.join(dir, 'g1', 'youtube-HoKkasEyDOI', 'gemini'));
    const req = m.calls.find((c) => c.url === '/v1beta/interactions').body;
    assert.equal(req.model, 'gemini-3.8-flash');
    assert.deepEqual(req.input[0], { type: 'video', uri: 'https://www.youtube.com/watch?v=HoKkasEyDOI', processing: { type: 'static', start_offset: '10s', end_offset: '40s', fps: 4 } });
    assert.equal(req.input[1].text, DEFAULT_GEMINI_PROMPT);
    assert.ok(!m.calls.some((c) => c.url.startsWith('/upload')), 'no upload for YouTube');
    assert.match(fs.readFileSync(r.file, 'utf8'), /MOCK ANALYSIS/);
  } finally {
    m.server.close();
  }
});

test('gemini: local files are streamed to the Files API and polled until ACTIVE', async () => {
  const m = await mockGemini();
  process.env.VD_GEMINI_BASE_URL = m.base;
  process.env.GEMINI_API_KEY = 'test-key';
  const file = path.join(dir, 'clip.mp4');
  fs.writeFileSync(file, Buffer.alloc(300000, 7));
  try {
    const r = await geminiAnalyze(file, { prompt: 'Describe the edit.', pollMs: 10, outputDir: path.join(dir, 'g2') });
    assert.equal(r.text, 'MOCK ANALYSIS');
    const start = m.calls.find((c) => c.url === '/upload/v1beta/files');
    assert.equal(start.headers['x-goog-upload-protocol'], 'resumable');
    assert.equal(start.headers['x-goog-upload-header-content-length'], '300000');
    const up = m.calls.find((c) => c.url === '/upload-session/1');
    assert.equal(up.size, 300000);
    assert.equal(up.headers['x-goog-upload-command'], 'upload, finalize');
    assert.ok(m.calls.filter((c) => c.url === '/v1beta/files/abc').length >= 2, 'polled file state');
    const req = m.calls.find((c) => c.url === '/v1beta/interactions').body;
    assert.deepEqual(req.input[0], { type: 'video', uri: `${m.base}/v1beta/files/abc`, mime_type: 'video/mp4' });
    assert.equal(req.input[1].text, 'Describe the edit.');
  } finally {
    m.server.close();
  }
});

test('gemini: agentic mode runs in the background and is polled', async () => {
  const m = await mockGemini();
  process.env.VD_GEMINI_BASE_URL = m.base;
  process.env.GEMINI_API_KEY = 'test-key';
  try {
    const r = await geminiAnalyze('https://youtu.be/HoKkasEyDOI', { processing: 'agentic', pollMs: 10, outputDir: path.join(dir, 'g3') });
    assert.equal(r.text, 'AGENTIC DONE');
    const req = m.calls.find((c) => c.url === '/v1beta/interactions').body;
    assert.equal(req.background, true);
    assert.equal(req.input[0].processing, 'agentic');
    await assert.rejects(geminiAnalyze('https://youtu.be/HoKkasEyDOI', { processing: 'agentic', fps: 2 }), /only supported with processing "static"/);
  } finally {
    m.server.close();
  }
});

test('gemini: errors are explained (rate limit, bad key, missing key)', async () => {
  const m = await mockGemini();
  process.env.VD_GEMINI_BASE_URL = m.base;
  try {
    process.env.GEMINI_API_KEY = 'test-key';
    await assert.rejects(geminiAnalyze('https://youtu.be/HoKkasEyDOI', { prompt: 'RATE' }), /HTTP 429.*free-tier quota/);
    process.env.GEMINI_API_KEY = 'wrong';
    await assert.rejects(geminiAnalyze('https://youtu.be/HoKkasEyDOI', {}), /HTTP 400.*check GEMINI_API_KEY/);
    delete process.env.GEMINI_API_KEY;
    await assert.rejects(geminiAnalyze('https://youtu.be/HoKkasEyDOI', {}), /GEMINI_API_KEY is not set.*aistudio\.google\.com\/apikey/);
  } finally {
    m.server.close();
    delete process.env.GEMINI_API_KEY;
    delete process.env.VD_GEMINI_BASE_URL;
  }
});
