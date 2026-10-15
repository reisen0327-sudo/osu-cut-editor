'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { createOszImporter, IMPORT_LIMITS } = require('../shared/osz');

function fixture(t, limits = IMPORT_LIMITS) {
  const parent = path.resolve(__dirname, '../.test-tmp');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'osu-cut-import-test-'));
  const temp = path.join(root, 'temp'); fs.mkdirSync(temp);
  const importer = createOszImporter(temp, limits);
  t.after(() => {
    importer.dispose();
    assert.equal(path.dirname(root), parent);
    assert.ok(path.basename(root).startsWith('osu-cut-import-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const archive = (entries) => {
    const zip = new AdmZip();
    entries.forEach(([name, data], index) => {
      const key = 'entry-' + index;
      zip.addFile(key, Buffer.from(data || ''));
      // Preserve unsafe names in the fixture rather than letting addFile sanitise them.
      zip.getEntry(key).entryName = name;
    });
    const file = path.join(root, 'input.osz'); zip.writeZip(file); return file;
  };
  return { root, temp, importer, archive };
}

test('OSZ imports use unique directories and discover nested maps', (t) => {
  const { importer, archive, temp } = fixture(t);
  const file = archive([['set/map.osu', 'osu file format v14'], ['set/audio.wav', 'audio']]);
  const first = importer.open(file), second = importer.open(file);
  assert.notEqual(first.folder, second.folder);
  assert.equal(first.osuFiles[0].name, 'set/map.osu');
  assert.equal(fs.readFileSync(first.osuFiles[0].path, 'utf8'), 'osu file format v14');
  importer.dispose();
  assert.deepEqual(fs.readdirSync(temp), []);
  assert.ok(fs.existsSync(file));
});

test('OSZ rejects traversal, drive paths, ADS and reserved Windows names before writing', (t) => {
  const { importer, archive, temp } = fixture(t);
  for (const name of ['../outside.osu', '/outside.osu', 'C:/outside.osu', 'C:outside.osu',
    'map.osu:stream', 'NUL.txt', 'dir./map.osu', 'dir /map.osu', 'a/../map.osu']) {
    assert.throws(() => importer.open(archive([['valid.osu', 'map'], [name, 'bad']])), /路径/);
    assert.deepEqual(fs.readdirSync(temp), [], name);
  }
});

test('OSZ rejects case-insensitive duplicates and file-directory collisions', (t) => {
  const { importer, archive, temp } = fixture(t);
  for (const entries of [
    [['Map.osu', 'first'], ['map.osu', 'second']],
    [['assets', 'file'], ['assets/map.osu', 'map']],
    [['same/', ''], ['same', 'file']]
  ]) {
    assert.throws(() => importer.open(archive(entries)), /冲突|重复/);
    assert.deepEqual(fs.readdirSync(temp), []);
  }
});

test('OSZ size and entry limits reject compressed input without leaving partial imports', (t) => {
  const { archive, temp } = fixture(t);
  const file = archive([['map.osu', 'map'], ['data.bin', 'x'.repeat(128)]]);
  for (const limits of [{ fileBytes: 32 }, { totalBytes: 64 }, { entries: 1 }, { archiveBytes: 10 }]) {
    const importer = createOszImporter(temp, { ...IMPORT_LIMITS, ...limits });
    assert.throws(() => importer.open(file), /限制/);
    assert.deepEqual(fs.readdirSync(temp), []);
  }
});

test('corrupt and mapless archives are rejected and cleaned up', (t) => {
  const { archive, importer, root, temp } = fixture(t);
  assert.throws(() => importer.open(archive([['audio.wav', 'audio']])), /没有 .osu/);
  const corrupt = path.join(root, 'corrupt.osz'); fs.writeFileSync(corrupt, 'not a zip');
  assert.throws(() => importer.open(corrupt));
  assert.deepEqual(fs.readdirSync(temp), []);
});

test('failure after writing an earlier entry removes the partial extraction', (t) => {
  const { archive, importer, temp } = fixture(t);
  const file = archive([['a-map.osu', 'map'], ['z-bad.wav', 'bad data']]);
  const bytes = fs.readFileSync(file);
  const lastHeader = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  bytes.writeUInt32LE(0, lastHeader + 16); // Wrong CRC for the later file.
  bytes.writeUInt32LE(0, bytes.readUInt32LE(lastHeader + 42) + 14);
  fs.writeFileSync(file, bytes);
  assert.throws(() => importer.open(file), /CRC/);
  assert.deepEqual(fs.readdirSync(temp), []);
});

test('import cleanup never removes unrelated temporary files', (t) => {
  const { archive, importer, temp } = fixture(t);
  const unrelated = path.join(temp, 'other-app'); fs.mkdirSync(unrelated);
  fs.writeFileSync(path.join(unrelated, 'keep.txt'), 'keep');
  importer.open(archive([['map.osu', 'map']]));
  importer.dispose();
  assert.deepEqual(fs.readdirSync(temp), ['other-app']);
  assert.equal(fs.readFileSync(path.join(unrelated, 'keep.txt'), 'utf8'), 'keep');
});
