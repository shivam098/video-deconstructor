import { spawn } from 'node:child_process';
import fs from 'node:fs';
import crypto from 'node:crypto';

export function log(...args) {
  if (process.env.VD_QUIET) return;
  process.stderr.write(`[video-deconstructor] ${args.join(' ')}\n`);
}

/**
 * Run a process without a shell and capture its output. Never rejects: spawn
 * failures, crashes and timeouts are reported through `code`/`error`.
 */
export function run(cmd, args = [], { env, cwd, timeoutMs = 0 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
    let child;
    try {
      child = spawn(cmd, args, {
        env: env ? { ...process.env, ...env } : process.env,
        cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish({ code: -1, stdout: '', stderr: String(error), error });
      return;
    }
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    let timedOut = false;
    if (timeoutMs) timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.on('error', (error) => finish({ code: -1, stdout: '', stderr: String(error), error }));
    child.on('close', (code, signal) => finish({
      code: code ?? -1,
      signal,
      timedOut,
      stdout: Buffer.concat(out).toString('utf8'),
      stderr: Buffer.concat(err).toString('utf8'),
    }));
  });
}

export function describeExit(r) {
  if (r.timedOut) return 'timed out';
  if (r.error) return r.error.code || String(r.error);
  if (r.code > 0x7fffffff || r.code < 0) {
    const u = r.code < 0 ? r.code >>> 0 : r.code;
    return `exit 0x${u.toString(16).toUpperCase()}`;
  }
  return `exit ${r.code}`;
}

/** Parse seconds (`75`, `75.5`, `75s`), `MM:SS(.mmm)` or `HH:MM:SS(.mmm)`. */
export function parseTime(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid time: ${value}`);
    return value;
  }
  const s = String(value).trim();
  if (/^\d+(\.\d+)?s?$/.test(s)) return parseFloat(s);
  const parts = s.split(':');
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) {
    throw new Error(`Invalid time "${value}". Use seconds, MM:SS or HH:MM:SS(.mmm).`);
  }
  return parts.reduce((acc, p) => acc * 60 + parseFloat(p), 0);
}

/** Format seconds as `MM:SS.mmm` (or `H:MM:SS.mmm` past one hour). */
export function fmtTime(sec, { ms = true } = {}) {
  let total = Math.round(Math.max(0, sec) * 1000);
  const h = Math.floor(total / 3600000); total -= h * 3600000;
  const m = Math.floor(total / 60000); total -= m * 60000;
  const s = Math.floor(total / 1000); const milli = total - s * 1000;
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  let out = h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  if (ms) out += `.${pad(milli, 3)}`;
  return out;
}

export const fileTag = (sec) => fmtTime(sec).replace(/[:.]/g, '-');

export function slug(s, max = 48) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max) || 'video';
}

export function hash8(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 8);
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function resetDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  return ensureDir(dir);
}

export function round(n, digits = 3) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export function isUrl(s) {
  return /^https?:\/\//i.test(String(s).trim());
}

/**
 * Escape a value for an ffmpeg filter option without quoting: first for the
 * option parser (\ ' :), then for the filtergraph parser (\ ' [ ] , ;).
 * Backslashes are normalised to forward slashes, which ffmpeg accepts on all
 * platforms, so Windows paths stay simple.
 */
export function filterValue(v) {
  const level1 = String(v).replace(/\\/g, '/').replace(/[\\':]/g, (c) => `\\${c}`);
  return level1.replace(/[\\'[\],;]/g, (c) => `\\${c}`);
}
