'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { prepareCut } = require('../shared/editSession');
const { audioBufferToWav } = require('../shared/wav');
const p = require('../shared/osuParser');
const snap = require('../shared/snapEngine');

const sample = fs.readFileSync(path.join(__dirname, '../sample/Cut Test - osu-cut-editor [Normal].osu'), 'utf8');
function buffer(channels, length, sampleRate) {
  const data = Array.from({ length: channels }, () => new Float32Array(length));
  return { length, sampleRate, numberOfChannels: channels, duration: length / sampleRate, getChannelData: (c) => data[c] };
}

test('audio and beatmap are cut together; input buffers and text remain intact', () => {
  const audio = buffer(2, 8000, 1000);
  for (let c = 0; c < 2; c++) for (let i = 0; i < 8000; i++) audio.getChannelData(c)[i] = (i + c) / 10000;
  const before = audio.getChannelData(0).slice();
  const { snapshot } = prepareCut(sample, audio, buffer, 2500, 5500);
  assert.equal(snapshot.audioBuffer.length, 5000);
  for (let c = 0; c < 2; c++) {
    assert.deepEqual(snapshot.audioBuffer.getChannelData(c).slice(0, 2500), audio.getChannelData(c).slice(0, 2500));
    assert.deepEqual(snapshot.audioBuffer.getChannelData(c).slice(2500), audio.getChannelData(c).slice(5500));
  }
  assert.deepEqual(audio.getChannelData(0), before);
  assert.equal(snapshot.objects.length, 5);
  const wav = Buffer.from(audioBufferToWav(snapshot.audioBuffer));
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt16LE(22), 2);
  assert.equal(wav.readUInt32LE(40), 5000 * 2 * 2);
});

test('allocation failure does not mutate the original text or audio', () => {
  const audio = buffer(1, 8000, 1000);
  assert.throws(() => prepareCut(sample, audio, () => { throw new Error('allocation failed'); }, 2500, 5500), /allocation failed/);
  assert.equal(audio.length, 8000);
  assert.equal(p.parseOsu(sample).sections.HitObjects.objects.length, 7);
});

test('missing audio, whole-song cuts, out-of-range and sub-sample cuts are rejected', () => {
  assert.throws(() => prepareCut(sample, null, buffer, 1, 2), /没有/);
  for (const [a, b] of [[0, 8000], [1, 8001], [1, 1.00001], [-1, 10], [2, 1]]) {
    assert.throws(() => prepareCut(sample, buffer(1, 8000, 1000), buffer, a, b));
  }
});

test('sample-aligned fractional cuts keep audio duration within one sample of map delta', () => {
  const audio = buffer(1, 441000, 44100);
  const { snapshot, report } = prepareCut(sample, audio, buffer, 1234.567, 2345.678);
  const removedMs = (audio.length - snapshot.audioBuffer.length) / 44100 * 1000;
  assert.ok(Math.abs(removedMs - report.delta) < 1000 / 44100);
});

function timed(lines) {
  return p.parseOsu('osu file format v14\n[TimingPoints]\n' + lines + '\n[HitObjects]\n256,192,6000,1,0');
}

test('osu divisors mean fractions of one beat', () => {
  assert.equal(snap.divisorToInterval(500, 1), 500);
  assert.equal(snap.divisorToInterval(500, 4), 125);
});

test('forward and backward wheel snaps move strictly and stop at bounds', () => {
  const m = timed('0,500,4,1,0,100,1,0');
  assert.equal(snap.snapTo(m, 500, 4, 1, 1000), 625);
  assert.equal(snap.snapTo(m, 500, 4, -1, 1000), 375);
  assert.equal(snap.snapTo(m, 1000, 4, 1, 1000), 1000);
  assert.equal(snap.snapTo(m, 0, 4, -1, 1000), 0);
  assert.equal(snap.snapTo(m, 2000, 4, 1, 1000), 2000);
});

test('old tempo grid stops at the next red line, including fractional and negative offsets', () => {
  const m = timed('-100,500,4,1,0,100,1,0\n1100,400,3,1,0,100,1,0');
  assert.deepEqual(snap.buildSnapPoints(m, 1, 2200).map((x) => x.time), [400, 900, 1100, 1500, 1900]);
  const fractional = timed('0,333.333,4,1,0,100,1,0\n500,400,4,1,0,100,1,0');
  assert.ok(!snap.buildSnapPoints(fractional, 1, 1000).some((x) => x.time === 666.666));
});

test('empty timing leaves navigation in place', () => {
  assert.equal(snap.snapTo(timed(''), 1234, 4, 1), 1234);
});
