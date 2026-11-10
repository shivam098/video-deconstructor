import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTime, fmtTime, filterValue } from '../src/util.mjs';
import { parseCaptions, buildAvTimeline, cutsNearNarration } from '../src/timeline.mjs';
import { detectCuts, detectSoftTransitions, mergeCuts, computePacing, computeActivity, pickStyleFrameTimes } from '../src/metrics.mjs';
import { youtubeId } from '../src/engine.mjs';

test('parseTime / fmtTime', () => {
  assert.equal(parseTime(75), 75);
  assert.equal(parseTime('75.5'), 75.5);
  assert.equal(parseTime('01:15'), 75);
  assert.equal(parseTime('1:02:03.250'), 3723.25);
  assert.equal(parseTime(''), undefined);
  assert.throws(() => parseTime('abc'));
  assert.equal(fmtTime(75.5), '01:15.500');
  assert.equal(fmtTime(3723.25), '1:02:03.250');
  assert.equal(fmtTime(59.9996, { ms: false }), '01:00');
});

test('filterValue escapes for the option and filtergraph parsers', () => {
  assert.equal(filterValue('C:\\Windows\\Fonts\\arial.ttf'), 'C\\\\:/Windows/Fonts/arial.ttf');
  assert.equal(filterValue("it's 00:10"), "it\\\\\\'s 00\\\\:10");
  assert.equal(filterValue('a,b;[c]'), 'a\\,b\\;\\[c\\]');
});

test('youtubeId handles common URL shapes', () => {
  assert.equal(youtubeId('https://www.youtube.com/watch?v=HoKkasEyDOI&t=3s'), 'HoKkasEyDOI');
  assert.equal(youtubeId('https://youtu.be/HoKkasEyDOI'), 'HoKkasEyDOI');
  assert.equal(youtubeId('https://www.youtube.com/shorts/HoKkasEyDOI'), 'HoKkasEyDOI');
  assert.equal(youtubeId('https://vimeo.com/123'), null);
});

test('parseCaptions collapses YouTube rolling auto-captions', () => {
  const vtt = `WEBVTT
Kind: captions
Language: en

00:00:00.000 --> 00:00:02.310 align:start position:0%
 
so<00:00:00.320><c> today</c><00:00:00.640><c> we're</c><00:00:01.000><c> talking</c>

00:00:02.310 --> 00:00:02.320 align:start position:0%
so today we're talking
 

00:00:02.320 --> 00:00:05.000 align:start position:0%
so today we're talking
about<00:00:02.800><c> maps</c> &amp; borders
`;
  const cues = parseCaptions(vtt);
  assert.deepEqual(cues.map((c) => c.text), ["so today we're talking", 'about maps & borders']);
  assert.equal(cues[1].start, 2.32);
});

test('parseCaptions reads SRT', () => {
  const srt = '1\n00:00:01,000 --> 00:00:02,500\nHello <i>world</i>\n\n2\n00:00:03,000 --> 00:00:04,000\nSecond line\n';
  assert.deepEqual(parseCaptions(srt), [
    { start: 1, end: 2.5, text: 'Hello world' },
    { start: 3, end: 4, text: 'Second line' },
  ]);
});

test('detectCuts applies threshold and merges near-duplicates', () => {
  const frames = [
    { t: 0, score: 0.9 }, { t: 1, score: 0.05 }, { t: 2, score: 0.5 }, { t: 2.1, score: 0.7 },
    { t: 3, score: 0.1 }, { t: 4, score: 0.35 },
  ];
  assert.deepEqual(detectCuts(frames, { threshold: 0.3, start: 0 }), [{ t: 2.1, score: 0.7, type: 'hard' }, { t: 4, score: 0.35, type: 'hard' }]);
});

test('detectSoftTransitions ignores changes already explained by a hard cut', () => {
  const coarse = [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.25].map((t) => ({ t, score: 0.01 }));
  coarse[3].score = 0.6; // 0.5-0.75: hard cut at 0.6 explains it
  coarse[7].score = 0.5; // 1.5-1.75: gradual wipe, no hard cut
  coarse[8].score = 0.45; // same wipe continuing -> merged
  const soft = detectSoftTransitions(coarse, [{ t: 0.6, score: 0.9, type: 'hard' }], { threshold: 0.35, start: 0 });
  assert.deepEqual(soft, [{ t: 1.625, score: 0.5, type: 'soft' }]);
  assert.deepEqual(mergeCuts([{ t: 0.6, type: 'hard' }], soft).map((c) => c.type), ['hard', 'soft']);
});

test('computePacing produces shots and statistics', () => {
  const p = computePacing({ cuts: [{ t: 2 }, { t: 3, type: 'soft' }, { t: 9 }], start: 0, end: 12 });
  assert.equal(p.totalCuts, 3);
  assert.equal(p.hardCuts, 2);
  assert.equal(p.softTransitions, 1);
  assert.deepEqual(p.shots.map((s) => s.enteredBy), ['start', 'hard', 'soft', 'hard']);
  assert.deepEqual(p.shots.map((s) => s.length), [2, 1, 6, 3]);
  assert.equal(p.averageShotLength, 3);
  assert.equal(p.medianShotLength, 2.5);
  assert.equal(p.cutsPerMinute, 15);
  const share = p.shotLengthDistribution.reduce((a, b) => a + b.runtimeShare, 0);
  assert.ok(Math.abs(share - 1) < 0.01);
});

test('computePacing segments by chapters when available', () => {
  const p = computePacing({
    cuts: [{ t: 5 }, { t: 15 }, { t: 16 }],
    start: 0,
    end: 20,
    chapters: [{ start: 0, end: 10, title: 'Intro' }, { start: 10, end: 20, title: 'Body' }],
  });
  assert.deepEqual(p.pacingBySegment.map((s) => [s.label, s.cuts]), [['Intro', 1], ['Body', 2]]);
});

test('computeActivity uses the coarse MAFD series and ignores samples spanning a cut', () => {
  const coarse = [];
  for (let i = 1; i <= 40; i++) {
    const t = i / 4;
    coarse.push({ t, score: 0, mafd: t > 5 && t <= 8 ? 2 : 0.05 });
  }
  Object.assign(coarse.find((f) => f.t === 2), { score: 0.9, mafd: 60 });
  const a = computeActivity(coarse, [{ t: 1.9, type: 'hard' }], { start: 0, end: 10 });
  assert.equal(a.motionHotspots.length, 1);
  assert.equal(a.motionHotspots[0].start, 5);
  assert.equal(a.perSecond[1], 0.05);
  assert.equal(a.lowMotionShare, 0.7);
});

test('pickStyleFrameTimes samples inside long shots', () => {
  const picks = pickStyleFrameTimes([{ index: 1, start: 0, end: 120, length: 120 }], 12);
  assert.equal(picks.length, 12);
  assert.equal(picks[0].t, 5);
  assert.equal(picks[11].t, 115);
  const few = pickStyleFrameTimes([{ index: 1, start: 0, end: 10, length: 10 }, { index: 2, start: 10, end: 11, length: 1 }], 12);
  assert.deepEqual(few.map((p) => p.shot), [1, 1, 2]);
});

test('pickStyleFrameTimes spreads picks across shots', () => {
  const shots = Array.from({ length: 20 }, (_, i) => ({ index: i + 1, start: i * 2, end: i * 2 + 2, length: 2 }));
  const picks = pickStyleFrameTimes(shots, 5);
  assert.equal(picks.length, 5);
  assert.equal(picks[0].shot, 1);
  assert.equal(picks[4].shot, 20);
  assert.equal(picks[0].t, 1);
});

test('buildAvTimeline groups narration per shot', () => {
  const pacing = computePacing({ cuts: [{ t: 2, type: 'hard' }], start: 0, end: 4 });
  const md = buildAvTimeline({
    meta: { title: 'T' },
    pacing,
    cues: [{ start: 0.5, end: 1, text: 'first | line' }, { start: 2.5, end: 3, text: 'second' }],
    silences: [{ start: 3, end: 3.5, duration: 0.5 }],
    styleFrames: [{ shot: 2, file: 'style_01.jpg' }],
    relDir: 'style-frames',
  });
  assert.match(md, /\| 1 \| start \| 00:00\.000 \| 2\.00 \| first \\\| line \|/);
  assert.match(md, /\| 2 \| hard \| 00:02\.000 \| 2\.00 \| second \| silence 0\.5s @ 00:03\.000 \| \[style_01\.jpg\]\(style-frames\/style_01\.jpg\) \|/);
  assert.deepEqual(cutsNearNarration([{ t: 2 }], [{ start: 2.3 }]), { tolerance: 0.5, cuts: 1, nearCaptionStart: 1, share: 1 });
});
