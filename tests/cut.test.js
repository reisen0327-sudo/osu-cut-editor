'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const p = require('../shared/osuParser');
const c = require('../shared/cutEngine');

function map(timing, objects = '256,192,6000,2,0,L|396:192,1,140', extra = '') {
  return p.parseOsu(`osu file format v14
[General]
AudioFilename: audio.wav
PreviewTime:7000
[Editor]
Bookmarks:500,1000,2000,4000,7000
[Metadata]
Title:Test
BeatmapID:123
BeatmapSetID:456
[Difficulty]
SliderMultiplier:1.4
[Events]
${extra}
[TimingPoints]
${timing}
[HitObjects]
${objects}`);
}

const red = '0,500,4,1,0,100,1,0';

test('cut restores removed BPM and preserves slider duration after serialization', () => {
  const m = map(red + '\n2000,250,3,2,3,80,1,1');
  const r = c.cutBeatmap(m, 1000, 4000);
  const reloaded = p.parseOsu(p.serializeOsu(m));
  assert.deepEqual(p.objectIntervalMs(reloaded, reloaded.sections.HitObjects.objects[0]), [3000, 3250]);
  assert.equal(r.restoredTimingPoints, 1);
  assert.equal(p.timingAt(reloaded, 3000).meter, 3);
});

test('cut restores inherited SV, sample bank, volume and effects at the seam', () => {
  const m = map(red + '\n2000,-50,4,3,7,35,0,1');
  c.cutBeatmap(m, 1000, 4000);
  assert.equal(p.sliderVelocityMultiplierAt(m, 3000), 2);
  assert.deepEqual(p.objectIntervalMs(m, m.sections.HitObjects.objects[0]), [3000, 3250]);
  const active = p.timingAt(m, 3000);
  assert.deepEqual([active.sampleSet, active.sampleIndex, active.volume, active.effects], [3, 7, 35, 1]);
});

test('red line resets SV and cut reconstructs red then green in order', () => {
  const m = map(red + '\n500,-50,4,1,0,100,0,0\n2000,400,4,2,1,80,1,0\n3000,-200,4,3,2,40,0,1');
  assert.equal(p.sliderVelocityMultiplierAt(m, 2500), 1);
  c.cutBeatmap(m, 1000, 4000);
  assert.deepEqual(m.sections.TimingPoints.points.filter((t) => t.time === 1000).map((t) => t.uninherited), [true, false]);
  assert.equal(p.sliderDurationMs(m, m.sections.HitObjects.objects[0]), 800);
});

test('original end-boundary red line takes precedence over removed state', () => {
  const m = map(red + '\n2000,-50,4,1,0,100,0,0\n4000,400,3,2,4,65,1,0');
  c.cutBeatmap(m, 1000, 4000);
  assert.equal(p.sliderVelocityMultiplierAt(m, 3000), 1);
  assert.equal(p.sliderDurationMs(m, m.sections.HitObjects.objects[0]), 400);
  assert.equal(m.sections.TimingPoints.points.filter((t) => t.time === 1000).length, 1);
});

test('half-open range removes its start, keeps its end and removes crossing long objects', () => {
  const m = map(red, [
    '64,192,500,128,0,1000:2:3:4:60:tail.wav',
    '64,192,1000,1,0,0:0:0:0:',
    '64,192,900,128,0,1500:0:0:0:0:',
    '64,192,3000,128,0,4500:0:0:0:0:',
    '64,192,4000,128,0,5000:2:3:4:60:tail.wav',
    '64,192,6000,1,0,0:0:0:0:'
  ].join('\n'));
  c.cutBeatmap(m, 1000, 4000);
  assert.deepEqual(m.sections.HitObjects.objects.map((o) => [o.time, o.endTime]), [[500, 1000], [1000, 2000], [3000, 3000]]);
  assert.ok(m.sections.HitObjects.objects[1].raw.endsWith('2000:2:3:4:60:tail.wav'));
});

test('consecutive cuts retain the same remaining slider duration', () => {
  let m = map(red + '\n2000,250,4,1,0,100,1,0\n2500,-50,4,1,0,100,0,0');
  c.cutBeatmap(m, 1000, 4000);
  m = p.parseOsu(p.serializeOsu(m));
  c.cutBeatmap(m, 500, 1500);
  assert.deepEqual(p.objectIntervalMs(m, m.sections.HitObjects.objects[0]), [2000, 2125]);
});

test('timestamps, partial breaks, metadata and unsupported media are reconciled', () => {
  const m = map(red, undefined, '0,0,"bg,wide.jpg",0,0\n2,500,2000\n2,2000,3000\n2,3000,5000\nVideo,0,"video.mp4"\nSprite,Foreground,Centre,"sprite.png",0,0\n F,0,6000,7000,0,1');
  c.cutBeatmap(m, 1000, 4000);
  assert.equal(p.getKv(m, 'General', 'PreviewTime'), '4000');
  assert.equal(p.getKv(m, 'Editor', 'Bookmarks'), '500,1000,4000');
  assert.equal(p.getKv(m, 'Metadata', 'BeatmapID'), '0');
  assert.equal(p.getKv(m, 'Metadata', 'BeatmapSetID'), '-1');
  assert.deepEqual(m.sections.Events.events.map((e) => e.raw), ['0,0,"bg,wide.jpg",0,0', '2,500,1000', '2,1000,2000']);
  assert.equal(m.sections.Events.events[0].fields[2], '"bg,wide.jpg"');
});

test('preview inside cut moves to seam, automatic preview remains -1', () => {
  for (const [before, expected] of [[2000, '1000'], [-1, '-1']]) {
    const m = map(red);
    p.setKv(m, 'General', 'PreviewTime', before);
    c.cutBeatmap(m, 1000, 4000);
    assert.equal(p.getKv(m, 'General', 'PreviewTime'), expected);
  }
});

test('invalid ranges fail before changing the beatmap', () => {
  for (const range of [[-1, 10], [10, 10], [20, 10], [NaN, 100]]) {
    const m = map(red), before = p.serializeOsu(m);
    assert.throws(() => c.cutBeatmap(m, ...range));
    assert.equal(p.serializeOsu(m), before);
  }
});
