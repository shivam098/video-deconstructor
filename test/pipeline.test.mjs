import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveTool } from '../src/binaries.mjs';
import { run } from '../src/util.mjs';

process.env.VD_QUIET = '1';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { overview, zoom, frames, probeMedia, renderAudioStrip } = await import('../src/engine.mjs');

const ff = await resolveTool('ffmpeg');
const fp = await resolveTool('ffprobe');
const skip = ff.missing || fp.missing ? 'ffmpeg/ffprobe not available' : false;

let dir;
let video;

/**
 * 5 s synthetic video: test pattern -> hard cut at 2 s -> white -> 0.5 s wipe
 * to black at 3.0-3.5 s; a tone with a 1 s gap at 3-4 s; sidecar captions.
 */
before(async () => {
  if (skip) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vd-test-'));
  video = path.join(dir, 'synthetic.mp4');
  const r = await run(ff.cmd, [
    '-hide_banner', '-nostdin', '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=25:d=2',
    '-f', 'lavfi', '-i', 'color=c=white:s=640x360:r=25:d=2',
    '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=25:d=2',
    '-f', 'lavfi', '-i', "aevalsrc='if(between(t,3,4),0,0.4*sin(2*PI*440*t))':s=44100:d=5",
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0,fps=25,settb=1/25,format=yuv420p[ab];[2:v]fps=25,settb=1/25,format=yuv420p[c];[ab][c]xfade=transition=wipeleft:duration=0.5:offset=3[v]',
    '-map', '[v]', '-map', '3:a', '-c:v', 'mpeg4', '-q:v', '4', '-pix_fmt', 'yuv420p', '-c:a', 'aac', video,
  ]);
  assert.equal(r.code, 0, r.stderr);
  fs.writeFileSync(path.join(dir, 'synthetic.vtt'), 'WEBVTT\n\n00:00:00.200 --> 00:00:01.800\nScene one test pattern\n\n00:00:02.100 --> 00:00:03.000\nWhite card arrives\n\n00:00:03.600 --> 00:00:04.800\nWiped to black\n');
});

after(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test('overview produces all artifacts for a local file', { skip }, async () => {
  const out = path.join(dir, 'run');
  const m = await overview(video, { outputDir: out, maxStyleFrames: 6 });
  assert.equal(m.summary.hardCuts, 1);
  assert.equal(m.summary.softTransitions, 1);
  const cuts = JSON.parse(fs.readFileSync(m.artifacts.pacingMetrics, 'utf8')).cuts;
  assert.ok(Math.abs(cuts[0].t - 2) < 0.1 && cuts[0].type === 'hard', `hard cut: ${JSON.stringify(cuts[0])}`);
  assert.ok(cuts[1].t > 2.9 && cuts[1].t < 3.6 && cuts[1].type === 'soft', `soft transition: ${JSON.stringify(cuts[1])}`);
  assert.equal(m.artifacts.styleFrames.length, 3);
  assert.ok(m.artifacts.contactSheets.length >= 1);
  for (const s of m.artifacts.contactSheets) assert.ok(fs.statSync(s.file).size > 1000);
  assert.ok(fs.statSync(m.artifacts.audioStrip).size > 1000);
  assert.equal(m.summary.captionLines, 3);
  const silences = JSON.parse(fs.readFileSync(m.artifacts.pacingMetrics, 'utf8')).silences;
  assert.ok(silences.some((s) => Math.abs(s.start - 3) < 0.2 && s.duration > 0.7), JSON.stringify(silences));
  const md = fs.readFileSync(m.artifacts.avTimeline, 'utf8');
  assert.match(md, /\| 2 \| hard \| 00:02\.\d{3} \| [\d.]+ \| White card arrives \| silence/);
  assert.match(md, /\| 3 \| soft \| 00:03\.\d{3} \| [\d.]+ \| Wiped to black \|/);
  const sheet = await probeMedia(m.artifacts.contactSheets[0].file).catch(() => null);
  assert.ok(!sheet || sheet.width > 640, 'contact sheet should be a tiled image');
});

test('zoom renders high-fps sheets around a cut', { skip }, async () => {
  const r = await zoom(video, { start: 1.5, end: 2.5, fps: 10, outputDir: path.join(dir, 'run') });
  assert.equal(r.fps, 10);
  assert.equal(r.cuts.length, 1);
  assert.equal(r.artifacts.contactSheets.length, 1);
  assert.equal(r.artifacts.contactSheets[0].frames, 10);
  assert.equal(r.narration.length, 1);
});

test('frames extracts native-resolution stills', { skip }, async () => {
  const r = await frames(video, { timestamps: ['00:01', 4.5], format: 'png', outputDir: path.join(dir, 'run') });
  assert.equal(r.frames.length, 2);
  const p = await probeMedia(r.frames[1].path);
  assert.equal(`${p.width}x${p.height}`, '640x360');
});

test('audio strip draws every marker even when the filtergraph is long', { skip }, async () => {
  const cuts = Array.from({ length: 700 }, (_, i) => ({ t: (i * 5) / 700, type: i % 3 ? 'hard' : 'soft' }));
  const silences = Array.from({ length: 300 }, (_, i) => ({ start: (i * 5) / 300, end: (i * 5) / 300 + 0.004 }));
  const outFile = path.join(dir, 'strip-many.png');
  await renderAudioStrip({ file: video, localStart: 0, dur: 5, absStart: 0, cuts, silences, outFile, width: 3000 });
  assert.ok(fs.statSync(outFile).size > 1000);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith('filter-')), [], 'filter script cleaned up');
});

function rpcSession() {
  const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'cli.mjs'), 'mcp'], { env: { ...process.env, VD_QUIET: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  const waiters = new Map();
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      waiters.get(msg.id)?.(msg);
    }
  });
  let id = 0;
  const call = (method, params) => new Promise((resolve) => {
    const n = ++id;
    waiters.set(n, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`);
  });
  const notify = (method) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
  return { child, call, notify };
}

test('MCP server speaks JSON-RPC over stdio', async () => {
  const s = rpcSession();
  try {
    const init = await s.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    assert.equal(init.result.serverInfo.name, 'video-deconstructor');
    s.notify('notifications/initialized');
    const list = await s.call('tools/list', {});
    assert.deepEqual(list.result.tools.map((t) => t.name), [
      'check_environment', 'deconstruct_video_overview', 'inspect_motion_or_transition', 'extract_highres_style_frames',
      'setup_whisper', 'transcribe_audio', 'gemini_analyze_video',
    ]);
    const env = await s.call('tools/call', { name: 'check_environment', arguments: {} });
    const envJson = JSON.parse(env.result.content[0].text);
    assert.ok(envJson.tools.ffmpeg);
    assert.ok('whisper' in envJson && 'gemini' in envJson);
    const bad = await s.call('tools/call', { name: 'extract_highres_style_frames', arguments: { source: path.join(os.tmpdir(), 'nope.mp4'), timestamps: [1] } });
    assert.equal(bad.result.isError, true);
    if (!skip) {
      const r = await s.call('tools/call', { name: 'extract_highres_style_frames', arguments: { source: video, timestamps: ['00:03'], inline_images: 1, output_dir: path.join(dir, 'mcp') } });
      assert.ok(!r.result.isError, r.result.content[0].text);
      assert.equal(r.result.content[1].type, 'image');
    }
    const unknown = await s.call('nope/method', {});
    assert.equal(unknown.error.code, -32601);
  } finally {
    s.child.kill();
  }
});
