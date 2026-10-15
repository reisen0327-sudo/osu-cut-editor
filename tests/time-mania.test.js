'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const time = require('../shared/timeFormat');
const { layoutMania, lookaheadMs } = require('../shared/maniaLayout');

test('game timestamps and milliseconds convert without manual arithmetic', () => {
  assert.equal(time.parseTimestamp('00:49.809'), 49809);
  assert.equal(time.parseTimestamp('00:49:809'), 49809);
  assert.equal(time.parseTimestamp(' 1:02.5 '), 62500);
  assert.equal(time.parseTimestamp('120:00.000'), 7200000);
  assert.equal(time.formatTimestamp(49809), '00:49.809');
  assert.equal(time.parseMilliseconds('49809'), 49809);
  assert.equal(time.formatTimestamp(60000), '01:00.000');
});

test('both formats round trip fractional millisecond snap positions', () => {
  for (const value of [0, 0.001, 999.999, 1250.5, 49809, 59999.999, 60000, 1333333.333]) {
    assert.equal(time.parseTimestamp(time.formatTimestamp(value)), value);
    assert.equal(time.parseMilliseconds(time.formatMilliseconds(value)), value);
  }
  assert.equal(time.formatTimestamp(59999.9996), '01:00.000');
});

test('invalid and incomplete values do not turn into a valid cut position', () => {
  for (const value of ['', '00:', '00:60.000', '-1:20.000', '01:2x.000', '00:00.1234567', 'Infinity']) {
    assert.ok(Number.isNaN(time.parseTimestamp(value)), value);
  }
  for (const value of ['', '-1', '1e3', '12ms', '00:01.000', 'NaN', '1.1234']) {
    assert.ok(Number.isNaN(time.parseMilliseconds(value)), value);
  }
});

function note(lane, start, end = start, keys = 4) {
  return { start, end, obj: { x: (lane + 0.5) * 512 / keys, kind: end > start ? 'hold' : 'circle' } };
}
function view(objects, overrides = {}) {
  return layoutMania({ width: 960, height: 600, keys: 4, playheadMs: 1000, speed: 2, objects, ...overrides });
}

test('4K and 7K heads remain thin rather than scaling to track width', () => {
  for (const keys of [4, 7, 18]) {
    const result = view([note(0, 1250, 1500, keys)], { keys });
    assert.ok(result.caps.every((cap) => cap.height <= 6));
    assert.ok(result.laneWidth <= 64);
    assert.ok(result.left >= 0 && result.left + result.fieldWidth <= 960);
  }
});

test('dense consecutive LN endpoints do not overlap visually at any slider speed', () => {
  const notes = [note(0, 1000, 1125), note(0, 1130, 1250), note(0, 1255, 1375), note(0, 1380)];
  for (const speed of [0.5, 1.37, 2, 5.63, 8]) {
    const result = view(notes, { speed });
    const caps = result.caps.slice().sort((a, b) => a.y - b.y);
    for (let i = 1; i < caps.length; i++) {
      assert.ok(caps[i - 1].y + caps[i - 1].height / 2 <= caps[i].y - caps[i].height / 2);
    }
  }
});

test('long notes crossing the viewport are clipped without fake endpoint heads', () => {
  const result = view([note(0, 0, 10000)]);
  assert.equal(result.bodies.length, 1);
  assert.equal(result.bodies[0].y, result.top);
  assert.equal(result.bodies[0].height, result.bottom - result.top);
  assert.equal(result.caps.length, 0);
});

test('continuous speed changes scale time distance and preserve note timestamps', () => {
  const item = note(1, 1250, 1400), slow = view([item], { speed: 1 }), fast = view([item], { speed: 3.25 });
  assert.ok(Math.abs((fast.judgeY - fast.yForTime(1250)) / (slow.judgeY - slow.yForTime(1250)) - 3.25) < 1e-9);
  assert.deepEqual(item, note(1, 1250, 1400));
  assert.equal(lookaheadMs(0.5), 8000);
  assert.equal(lookaheadMs(8), 500);
});
