'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { createExportPlan, exportFolder, exportOsz, safeName, MARKER } = require('../shared/exportEngine');
const { parseOsu, getKv } = require('../shared/osuParser');
const { audioBufferToWav } = require('../shared/wav');

function fixture(t) {
  const parent = path.resolve(__dirname, '../.test-tmp');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'osu-cut-regression-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), parent);
    assert.ok(path.basename(root).startsWith('osu-cut-regression-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const sourceDir = path.join(root, 'extracted'), outputParent = path.join(root, 'downloads');
  fs.mkdirSync(sourceDir); fs.mkdirSync(outputParent);
  fs.mkdirSync(path.join(sourceDir, 'sounds'));
  for (const [name, data] of Object.entries({ 'bg,wide.jpg': 'background', 'sounds/custom.wav': 'sound',
    'audio.mp3': 'original audio', 'audio_cut.wav': 'custom sound with collision', 'video.mp4': 'video',
    'old.osu': 'original map', 'old.osb': 'storyboard', 'original.osz': 'original archive' })) {
    fs.writeFileSync(path.join(sourceDir, name), data);
  }
  const osuText = 'osu file format v14\n[General]\nAudioFilename:audio.mp3\n[Metadata]\nArtist:Artist\nTitle:Title\nVersion:4K\nBeatmapID:123\nBeatmapSetID:456\n[Events]\n0,0,"bg,wide.jpg",0,0\nVideo,0,"video.mp4"\nSprite,Foreground,Centre,"bg,wide.jpg",0,0\n F,0,1,2,0,1\n[Variables]\n$test=1\n[HitObjects]\n64,192,1000,1,0,0:0:0:0:sounds/custom.wav';
  const audioBuffer = audioBufferToWav({ numberOfChannels: 1, sampleRate: 1000, length: 1000, getChannelData: () => new Float32Array(1000) });
  return { root, outputParent, payload: { sourceDir, osuText, audioBuffer, originalAudioName: 'audio.mp3' } };
}

test('folder exports are independent, include nested resources and preserve earlier exports', (t) => {
  const { outputParent, payload } = fixture(t);
  const plan = createExportPlan(payload);
  assert.equal(plan.audioName, 'audio_cut-2.wav');
  const a = exportFolder(plan, outputParent);
  const before = fs.readFileSync(a.audioPath);
  const changed = createExportPlan({ ...payload, osuText: payload.osuText.replace('Version:4K', 'Version:7K') });
  changed.audio = Buffer.from(changed.audio); changed.audio[44] = 12;
  const b = exportFolder(changed, outputParent);
  assert.notEqual(a.folder, b.folder);
  assert.deepEqual(fs.readFileSync(a.audioPath), before);
  assert.equal(fs.readFileSync(path.join(a.folder, 'sounds/custom.wav'), 'utf8'), 'sound');
  assert.equal(fs.readFileSync(path.join(a.folder, 'bg,wide.jpg'), 'utf8'), 'background');
  assert.equal(fs.readFileSync(path.join(payload.sourceDir, 'audio.mp3'), 'utf8'), 'original audio');
  assert.equal(fs.existsSync(path.join(a.folder, 'video.mp4')), false);
});

test('archive export strips embedded and external storyboard, video and original IDs', (t) => {
  const { outputParent, payload } = fixture(t);
  const plan = createExportPlan(payload), dest = path.join(outputParent, 'cut.osz');
  exportOsz(plan, dest);
  const zip = new AdmZip(dest), names = zip.getEntries().map((e) => e.entryName);
  assert.ok(names.includes('sounds/custom.wav') && names.includes('bg,wide.jpg'));
  for (const name of ['old.osu', 'old.osb', 'video.mp4', 'audio.mp3', 'original.osz']) assert.ok(!names.includes(name));
  const text = zip.readAsText(plan.osuName), parsed = parseOsu(text);
  assert.ok(!/Sprite| F,|Video|\[Variables\]/.test(text));
  assert.equal(getKv(parsed, 'Metadata', 'BeatmapID'), '0');
  assert.equal(getKv(parsed, 'Metadata', 'BeatmapSetID'), '-1');
  assert.equal(getKv(parsed, 'General', 'AudioFilename'), plan.audioName);
  assert.deepEqual(zip.readFile(plan.audioName), plan.audio);
});

test('existing OSZ is never overwritten, including the original import archive', (t) => {
  const { payload } = fixture(t);
  const dest = path.join(payload.sourceDir, 'original.osz');
  assert.throws(() => exportOsz(createExportPlan(payload), dest), /不会被覆盖/);
  assert.equal(fs.readFileSync(dest, 'utf8'), 'original archive');
});

test('prior export directories do not get recursively copied into new exports', (t) => {
  const { payload } = fixture(t);
  const first = exportFolder(createExportPlan(payload), payload.sourceDir);
  assert.ok(fs.existsSync(path.join(first.folder, MARKER)));
  const plan = createExportPlan(payload);
  assert.ok(plan.resources.every((r) => !r.source.startsWith(first.folder + path.sep)));
});

test('resource read failure leaves no incomplete export folder', (t) => {
  const { payload, outputParent } = fixture(t);
  const plan = createExportPlan(payload);
  fs.unlinkSync(path.join(payload.sourceDir, 'sounds/custom.wav'));
  assert.throws(() => exportFolder(plan, outputParent));
  assert.deepEqual(fs.readdirSync(outputParent), []);
});

test('missing background is reported without pretending to recreate it', (t) => {
  const { payload } = fixture(t);
  fs.unlinkSync(path.join(payload.sourceDir, 'bg,wide.jpg'));
  assert.match(createExportPlan(payload).warnings[0], /bg,wide.jpg/);
});

test('Windows filenames are safe and export preparation does not mutate input text', (t) => {
  const { payload } = fixture(t), original = payload.osuText;
  createExportPlan(payload);
  assert.equal(payload.osuText, original);
  assert.equal(safeName('CON'), '_CON');
  assert.equal(safeName('test:bad. '), 'test_bad');
});
