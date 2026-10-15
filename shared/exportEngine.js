'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const AdmZip = require('adm-zip');
const { parseOsu, serializeOsu, getKv, getSection, setKv } = require('./osuParser');
const { prepareIndependentMap } = require('./cutEngine');

const MARKER = '.osu-cut-export.json';
const STAGE_PREFIX = '.osu-cut-stage-';
const key = (name) => String(name).replace(/\\/g, '/').toLowerCase();

function safeName(value) {
  let name = String(value || 'cut').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '').trim().slice(0, 140).replace(/[. ]+$/g, '');
  if (!name) name = 'cut';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = '_' + name;
  return name;
}

function resourceFiles(sourceDir, originalAudioName) {
  const files = [];
  const walk = (dir, base) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = base ? base + '/' + entry.name : entry.name;
      if (entry.isDirectory()) {
        if (entry.name.startsWith(STAGE_PREFIX) || fs.existsSync(path.join(full, MARKER))) continue;
        walk(full, rel);
      } else if (entry.isFile()) {
        if (entry.name === MARKER || /\.(osu|osb|osz|mp4|avi|mkv|webm|wmv|flv|mov|m4v|mpg|mpeg)$/i.test(rel)) continue;
        if (originalAudioName && key(rel) === key(originalAudioName)) continue;
        files.push({ name: rel, source: full });
      }
    }
  };
  walk(sourceDir, '');
  return files;
}

function createExportPlan({ sourceDir, osuText, audioBuffer, originalAudioName }) {
  const audio = Buffer.from(audioBuffer);
  if (audio.length < 44 || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('导出音频不是有效的 WAV 数据');
  }
  const parsed = prepareIndependentMap(parseOsu(osuText));
  const resources = resourceFiles(sourceDir, originalAudioName);
  const used = new Set(resources.map((f) => key(f.name)));
  let audioName = 'audio_cut.wav';
  for (let i = 2; used.has(key(audioName)); i++) audioName = 'audio_cut-' + i + '.wav';
  setKv(parsed, 'General', 'AudioFilename', audioName);
  const baseName = safeName(getKv(parsed, 'Metadata', 'Artist', 'osu') + ' - ' +
    getKv(parsed, 'Metadata', 'Title', 'cut') + ' [' + getKv(parsed, 'Metadata', 'Version', 'Normal') + ']');
  const warnings = [];
  const events = getSection(parsed, 'Events');
  for (const ev of events ? events.events : []) {
    if (ev.kind === 'background') {
      const name = String(ev.fields[2] || '').replace(/^"|"$/g, '');
      if (name && !used.has(key(name))) warnings.push('源目录缺少背景资源：' + name);
    }
  }
  return { resources, audio, audioName, osuName: baseName + '.osu', baseName,
    osuText: serializeOsu(parsed), warnings };
}

function removeOwnedStage(parent, stage) {
  const resolved = path.resolve(stage);
  if (path.dirname(resolved) !== path.resolve(parent) || !path.basename(resolved).startsWith(STAGE_PREFIX)) {
    throw new Error('拒绝清理非本次导出的临时目录');
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

function exportFolder(plan, outputParent) {
  const parent = path.resolve(outputParent);
  const stage = fs.mkdtempSync(path.join(parent, STAGE_PREFIX));
  const folder = path.join(parent, plan.baseName + ' - ' + randomUUID());
  try {
    for (const resource of plan.resources) {
      const dest = path.join(stage, ...resource.name.split('/'));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(resource.source, dest, fs.constants.COPYFILE_EXCL);
    }
    fs.writeFileSync(path.join(stage, plan.osuName), plan.osuText, { encoding: 'utf8', flag: 'wx' });
    fs.writeFileSync(path.join(stage, plan.audioName), plan.audio, { flag: 'wx' });
    fs.writeFileSync(path.join(stage, MARKER), JSON.stringify({ format: 1, beatmap: plan.osuName }), { flag: 'wx' });
    if (fs.existsSync(folder)) throw new Error('输出目录已存在，请重新导出');
    fs.renameSync(stage, folder);
    return { ok: true, folder, osuPath: path.join(folder, plan.osuName),
      audioPath: path.join(folder, plan.audioName), warnings: plan.warnings };
  } catch (error) {
    removeOwnedStage(parent, stage);
    throw error;
  }
}

function exportOsz(plan, destPath) {
  const zip = new AdmZip();
  for (const resource of plan.resources) zip.addFile(resource.name, fs.readFileSync(resource.source));
  zip.addFile(plan.osuName, Buffer.from(plan.osuText, 'utf8'));
  zip.addFile(plan.audioName, plan.audio);
  const data = zip.toBuffer();
  // Exclusive creation protects both the imported archive and earlier exports.
  let fd;
  try { fd = fs.openSync(destPath, 'wx'); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('目标文件已存在，请选择新的文件名；已有文件不会被覆盖');
    throw error;
  }
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } catch (error) {
    fs.closeSync(fd); fd = undefined;
    fs.unlinkSync(destPath);
    throw error;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
  return { canceled: false, path: destPath, warnings: plan.warnings };
}

module.exports = { createExportPlan, exportFolder, exportOsz, safeName, MARKER };
