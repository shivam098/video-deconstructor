import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, describeExit, ensureDir, log } from './util.mjs';

const IS_WIN = process.platform === 'win32';
const exe = (name) => (IS_WIN ? `${name}.exe` : name);

export function defaultCacheRoot() {
  if (process.env.VD_CACHE_DIR) return path.resolve(process.env.VD_CACHE_DIR);
  if (IS_WIN) return path.join(process.env.LOCALAPPDATA || os.homedir(), 'video-deconstructor');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', 'video-deconstructor');
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'video-deconstructor');
}

/**
 * Environment for yt-dlp. PyInstaller builds unpack their DLLs into %TEMP%;
 * Windows Application Control (WDAC / Smart App Control) policies commonly
 * block loading DLLs from %TEMP%, so point TMP/TEMP at a cache folder instead.
 */
export function ytDlpEnv() {
  if (!IS_WIN) return undefined;
  const dir = ensureDir(path.join(defaultCacheRoot(), 'runtime-tmp'));
  return { TMP: dir, TEMP: dir };
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function listDirs(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(dir, d.name)); } catch { return []; }
}

function pathCandidates(name) {
  return (process.env.PATH || '').split(path.delimiter).filter(Boolean).map((d) => path.join(d, exe(name))).filter(isFile);
}

/** Well-known install locations, used when PATH is stale or incomplete. */
function fallbackCandidates(name) {
  const out = [];
  if (IS_WIN) {
    const local = process.env.LOCALAPPDATA || '';
    out.push(path.join(local, 'Microsoft', 'WinGet', 'Links', exe(name)));
    const family = name === 'yt-dlp' ? /yt-dlp\.yt-dlp|yt-dlp_/i : /ffmpeg/i;
    for (const pkg of listDirs(path.join(local, 'Microsoft', 'WinGet', 'Packages')).filter((d) => family.test(path.basename(d)))) {
      out.push(path.join(pkg, exe(name)), path.join(pkg, 'bin', exe(name)));
      for (const sub of listDirs(pkg)) out.push(path.join(sub, 'bin', exe(name)), path.join(sub, exe(name)));
    }
    out.push(
      path.join(os.homedir(), 'scoop', 'shims', exe(name)),
      path.join(process.env.ProgramData || 'C:\\ProgramData', 'chocolatey', 'bin', exe(name)),
      path.join('C:\\ffmpeg', 'bin', exe(name)),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'ffmpeg', 'bin', exe(name)),
    );
  } else {
    for (const d of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/snap/bin', path.join(os.homedir(), '.local', 'bin')]) {
      out.push(path.join(d, name));
    }
  }
  return out.filter(isFile);
}

const SPECS = {
  ffmpeg: { env: 'VD_FFMPEG', versionArgs: ['-hide_banner', '-version'], match: /ffmpeg version (\S+)/ },
  ffprobe: { env: 'VD_FFPROBE', versionArgs: ['-hide_banner', '-version'], match: /ffprobe version (\S+)/ },
  'yt-dlp': { env: 'VD_YTDLP', versionArgs: ['--version'], match: /^(\d{4}\.\d+\.\d+\S*)/m },
};

async function probe(name, cmd, prefix = []) {
  const spec = SPECS[name];
  const r = await run(cmd, [...prefix, ...spec.versionArgs], { timeoutMs: 30000, env: name === 'yt-dlp' ? ytDlpEnv() : undefined });
  const m = r.code === 0 && (r.stdout + r.stderr).match(spec.match);
  if (m) return { ok: true, version: m[1] };
  const detail = (r.stderr || r.stdout).trim().split('\n').pop()?.slice(0, 200);
  return { ok: false, reason: `${describeExit(r)}${detail ? ` - ${detail}` : ''}` };
}

const cache = new Map();

/**
 * Find a working binary. Every candidate is executed (`-version`) so broken
 * builds (wrong architecture, crashing nightlies, policy-blocked) are skipped
 * instead of failing later in the pipeline.
 */
export async function resolveTool(name) {
  if (cache.has(name)) return cache.get(name);
  const spec = SPECS[name];
  const seen = new Set();
  const candidates = [];
  const add = (cmd, source, prefix = []) => {
    const key = `${path.resolve(cmd).toLowerCase()} ${prefix.join(' ')}`;
    if (!seen.has(key)) { seen.add(key); candidates.push({ cmd, source, prefix }); }
  };
  if (process.env[spec.env]) add(process.env[spec.env], `env:${spec.env}`);
  for (const c of pathCandidates(name)) add(c, 'PATH');
  for (const c of fallbackCandidates(name)) add(c, 'known-location');
  if (name === 'yt-dlp') {
    for (const py of IS_WIN ? ['py', 'python', 'python3'] : ['python3', 'python']) {
      for (const c of pathCandidates(py)) add(c, 'python-module', ['-m', 'yt_dlp']);
    }
  }
  const rejected = [];
  for (const c of candidates) {
    const p = await probe(name, c.cmd, c.prefix);
    if (p.ok) {
      const tool = { name, cmd: c.cmd, prefix: c.prefix, version: p.version, source: c.source, rejected };
      if (rejected.length) log(`${name}: skipped ${rejected.length} unusable candidate(s); using ${c.cmd}`);
      cache.set(name, tool);
      return tool;
    }
    rejected.push({ path: [c.cmd, ...c.prefix].join(' '), reason: p.reason });
  }
  const tool = { name, missing: true, rejected };
  cache.set(name, tool);
  return tool;
}

export function installHint(name) {
  const pkg = {
    ffmpeg: { win: 'winget install Gyan.FFmpeg', mac: 'brew install ffmpeg', linux: 'sudo apt install ffmpeg' },
    ffprobe: { win: 'winget install Gyan.FFmpeg', mac: 'brew install ffmpeg', linux: 'sudo apt install ffmpeg' },
    'yt-dlp': { win: 'winget install yt-dlp.yt-dlp', mac: 'brew install yt-dlp', linux: 'python3 -m pip install -U yt-dlp' },
  }[name];
  return IS_WIN ? pkg.win : process.platform === 'darwin' ? pkg.mac : pkg.linux;
}

export async function requireTool(name) {
  const t = await resolveTool(name);
  if (t.missing) {
    const why = t.rejected.length ? ` Rejected: ${t.rejected.map((r) => `${r.path} (${r.reason})`).join('; ')}.` : '';
    throw new Error(`${name} not found or not working. Install it with: ${installHint(name)}, or set ${SPECS[name].env} to its path.${why}`);
  }
  return t;
}

/** JavaScript runtime used by yt-dlp to solve YouTube player challenges. */
export function jsRuntimeArgs() {
  if (process.env.VD_JS_RUNTIME) return ['--js-runtimes', process.env.VD_JS_RUNTIME];
  if (pathCandidates('deno').length) return [];
  if (pathCandidates('bun').length) return ['--js-runtimes', 'bun'];
  return ['--js-runtimes', `node:${process.execPath}`];
}

/** A TrueType font for timestamp overlays (drawtext needs an explicit file on Windows). */
export function findFont() {
  if (process.env.VD_FONT && isFile(process.env.VD_FONT)) return process.env.VD_FONT;
  const candidates = IS_WIN
    ? ['arial.ttf', 'segoeui.ttf', 'consola.ttf'].map((f) => path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts', f))
    : [
        '/System/Library/Fonts/Supplemental/Arial.ttf',
        '/System/Library/Fonts/Helvetica.ttc',
        '/Library/Fonts/Arial.ttf',
        '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
        '/usr/share/fonts/dejavu/DejaVuSans.ttf',
        '/usr/share/fonts/TTF/DejaVuSans.ttf',
        '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
        '/usr/share/fonts/liberation/LiberationSans-Regular.ttf',
      ];
  return candidates.find(isFile);
}

export async function checkEnvironment() {
  const tools = {};
  for (const name of ['yt-dlp', 'ffmpeg', 'ffprobe']) {
    const t = await resolveTool(name);
    tools[name] = t.missing
      ? { ok: false, install: installHint(name), rejected: t.rejected }
      : { ok: true, path: [t.cmd, ...t.prefix].join(' '), version: t.version, source: t.source, rejected: t.rejected };
  }
  const ff = tools.ffmpeg.ok ? await resolveTool('ffmpeg') : null;
  let filters = null;
  if (ff) {
    const r = await run(ff.cmd, ['-hide_banner', '-filters'], { timeoutMs: 30000 });
    const needed = ['scdet', 'metadata', 'silencedetect', 'drawtext', 'tile', 'showwavespic', 'showspectrumpic', 'vstack'];
    filters = Object.fromEntries(needed.map((f) => [f, new RegExp(`\\s${f}\\s`).test(r.stdout)]));
  }
  return {
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    cacheRoot: defaultCacheRoot(),
    font: findFont() || null,
    jsRuntime: jsRuntimeArgs().length ? jsRuntimeArgs().join(' ') : 'deno (yt-dlp default)',
    tools,
    ffmpegFilters: filters,
    ready: tools.ffmpeg.ok && tools.ffprobe.ok && (!filters || Object.values(filters).every(Boolean)),
    youtubeReady: tools['yt-dlp'].ok,
  };
}
