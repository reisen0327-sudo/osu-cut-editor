'use strict';

const { ipcRenderer } = require('electron');
const path = require('path');
const osuParser = require('../shared/osuParser');
const cutEngine = require('../shared/cutEngine');
const snapEngine = require('../shared/snapEngine');
const wav = require('../shared/wav');
const editSession = require('../shared/editSession');
const timeFormat = require('../shared/timeFormat');
const maniaLayout = require('../shared/maniaLayout');

const $ = (id) => document.getElementById(id);
const playfield = $('playfield');
const timeline = $('timeline');
const pfCtx = playfield.getContext('2d');
const tlCtx = timeline.getContext('2d');

const state = {
  folder: null,
  osuPath: null,
  osuName: null,
  parsed: null,
  text: null,
  objects: [],
  audioBuffer: null,
  audioContext: null,
  audioSource: null,
  playheadMs: 0,
  playStartedAt: null,
  playStartedCtxTime: null,
  playing: false,
  selectionStart: null,
  selectionEnd: null,
  cutStart: 0,
  cutEnd: 0,
  totalMs: 0,
  background: null,
  backgroundImage: null,
  fileList: [],
  audioFilename: null,
  mode: 0,
  snapDivisor: 4,
  snapPoints: null,
  snapCacheKey: null,
  maniaSpeed: 2,
  exportFolder: null,
  original: null,
  undo: [],
  redo: [],
  edited: false,
  loading: false,
  exporting: false,
  loadToken: 0
};

function fmtMs(ms) {
  return timeFormat.formatTimestamp(Math.max(0, Math.round(ms))) || '00:00.000';
}

function getSnapPoints() {
  if (!state.parsed) return [];
  const key = Math.round(state.totalMs) + ':' + state.snapDivisor;
  if (state.snapCacheKey !== key || !state.snapPoints) {
    state.snapPoints = snapEngine.buildSnapPoints(state.parsed, state.snapDivisor, state.totalMs);
    state.snapCacheKey = key;
  }
  return state.snapPoints;
}

function snapTime(ms, dir) {
  if (!state.parsed) return ms;
  return snapEngine.snapFromPoints(getSnapPoints(), ms, dir);
}

function updateSnapLabel() {
  if (!state.parsed) {
    $('snap-label').textContent = '无节拍锚定';
    return;
  }
  const t = snapTime(state.playheadMs, 0);
  const info = snapEngine.measureBeatInfo(state.parsed, t);
  $('snap-label').textContent = 'M' + info.measure + ' B' + info.beat + ' @ ' + fmtMs(t) + ' (' + Math.round(info.bpm * 100) / 100 + ' BPM, ' + info.meter + '/4)';
}

function sanitize(s) {
  return String(s || 'cut').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim();
}

function initBrandIcon() {
  const p = path.join(__dirname, '..', 'build', 'icon.png');
  try {
    if (require('fs').existsSync(p)) $('brand-icon').src = 'file:///' + p.replace(/\\/g, '/');
  } catch (e) {}
}

function parseCurrent(text) {
  const parsed = osuParser.parseOsu(text);
  state.parsed = parsed;
  state.text = text;
  state.objects = editSession.objectsFor(parsed);
  return parsed;
}

function objectInterval(item) {
  return [item.start, item.end];
}

function objectAtMs(ms) {
  return state.objects.find((it) => ms >= it.start - 5 && ms <= it.end + 5);
}

function maxObjectEnd() {
  let max = 0;
  for (const it of state.objects) max = Math.max(max, it.end);
  return max;
}

function updateTotal() {
  const audioDur = state.audioBuffer ? state.audioBuffer.duration * 1000 : 0;
  state.totalMs = Math.max(audioDur, maxObjectEnd() + 5000, 10000);
}

function updateMetadataPanel() {
  if (!state.parsed) { $('metadata').textContent = ''; return; }
  const g = osuParser.getKv.bind(null, state.parsed);
  const lines = [];
  const sec = osuParser.getSection(state.parsed, 'Metadata');
  if (sec && sec.entries) {
    for (const [k, v] of sec.entries) lines.push(k + ': ' + v);
  }
  const gen = osuParser.getSection(state.parsed, 'General');
  if (gen && gen.map && gen.map.AudioFilename) lines.push('Audio: ' + gen.map.AudioFilename);
  lines.push('Objects: ' + state.objects.length);
  lines.push('Mode: ' + (state.mode === 3 ? 'osu!mania (' + maniaKeys() + 'K)' : state.mode === 0 ? 'osu!standard' : 'mode ' + state.mode));
  lines.push('Length: ' + fmtMs(state.totalMs));
  $('metadata').textContent = lines.join('\n');
}

// ---------- file loading ----------

async function readText(p) { return ipcRenderer.invoke('read-text', p); }
async function readBinary(p) { return ipcRenderer.invoke('read-binary', p); }

function showFileList(files, folder, exportFolder) {
  state.fileList = files || [];
  const box = $('osu-file-list');
  box.innerHTML = '';
  if (!state.fileList.length) { box.innerHTML = '<div class="hint">没有找到 .osu 文件</div>'; return; }
  for (const f of state.fileList) {
    const div = document.createElement('div');
    div.className = 'osu-file';
    div.textContent = f.name;
    div.addEventListener('click', () => {
      document.querySelectorAll('.osu-file').forEach((el) => el.classList.remove('active'));
      div.classList.add('active');
      loadOsuPath(f.path, path.dirname(f.path), exportFolder);
    });
    box.appendChild(div);
  }
}

async function findAudio(folder, audioFilename) {
  if (!audioFilename) return null;
  const lower = audioFilename.toLowerCase();
  const candidates = [path.join(folder, audioFilename)];
  try {
    const list = await ipcRenderer.invoke('list-folder', folder);
    for (const f of list.files) {
      if (f.name.toLowerCase() === lower) candidates.push(f.path);
    }
    for (const f of list.files) {
      if (f.name.toLowerCase().endsWith('.mp3') || f.name.toLowerCase().endsWith('.ogg') || f.name.toLowerCase().endsWith('.wav')) {
        if (path.dirname(f.name).toLowerCase() === path.dirname(audioFilename).toLowerCase() &&
          path.parse(f.name).name.toLowerCase() === path.parse(audioFilename).name.toLowerCase()) {
          candidates.push(f.path);
        }
      }
    }
  } catch (e) {}
  for (const c of candidates) {
    try { require('fs').accessSync(c); return c; } catch (e) {}
  }
  return null;
}

function extractBackground(parsed) {
  const sec = osuParser.getSection(parsed, 'Events');
  if (!sec) return null;
  for (const ev of sec.events) {
    if (ev.kind === 'background' && ev.fields.length >= 3) {
      let name = ev.fields[2];
      name = String(name).replace(/^"|"$/g, '');
      return name;
    }
  }
  return null;
}

async function loadOsuPath(p, folder, exportFolder) {
  if (state.exporting) return;
  const token = ++state.loadToken;
  state.loading = true;
  stopPlayback();
  updateActionButtons();
  try {
    const text = await readText(p);
    const parsed = osuParser.parseOsu(text);
    const sourceFolder = path.dirname(p);
    const audioFilename = osuParser.getKv(parsed, 'General', 'AudioFilename', '');
    const audioPath = await findAudio(sourceFolder, audioFilename);
    let audioBuffer = null;
    let audioError = '未找到谱面引用的音频';
    if (audioPath) {
      try { audioBuffer = await loadAudioBytes(await readBinary(audioPath)); }
      catch (error) { audioError = '音频解码失败：' + error.message; }
    }
    if (token !== state.loadToken) return;
    const snapshot = editSession.snapshotFor(text, audioBuffer);
    state.osuPath = p;
    state.osuName = path.basename(p);
    state.folder = sourceFolder;
    state.exportFolder = exportFolder || sourceFolder;
    state.audioFilename = audioFilename;
    state.backgroundImage = null;
    state.undo = [];
    state.redo = [];
    state.original = snapshot;
    commitSnapshot(snapshot);
    $('cut-report').textContent = audioBuffer ? '已加载，可选择剪切区间。' : audioError + '；暂时无法剪切和导出。';
    const bgName = extractBackground(parsed);
    if (bgName) {
      const bgPath = path.join(sourceFolder, bgName);
      if (require('fs').existsSync(bgPath)) {
        const img = new Image();
        img.onload = () => {
          if (token === state.loadToken) { state.backgroundImage = img; drawPlayfield(); }
        };
        img.src = require('url').pathToFileURL(bgPath).href;
      }
    }
  } catch (error) {
    if (token === state.loadToken) alert('加载失败: ' + error.message);
  } finally {
    if (token === state.loadToken) { state.loading = false; updateActionButtons(); }
  }
}

async function loadAudioBytes(bytes) {
  const ctx = ensureAudioContext();
  const arrayBuf = bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return ctx.decodeAudioData(arrayBuf.slice(0));
}

function ensureAudioContext() {
  if (!state.audioContext) state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
  return state.audioContext;
}

// ---------- playback ----------

function stopPlayback() {
  if (state.audioSource) {
    try { state.audioSource.stop(); } catch (e) {}
    state.audioSource.disconnect();
    state.audioSource = null;
  }
  state.playing = false;
  $('btn-play').textContent = '▶ 播放';
}

function playPause() {
  if (!state.audioBuffer) { alert('没有可播放的音频'); return; }
  const ctx = ensureAudioContext();
  if (state.playing) { stopPlayback(); return; }
  if (ctx.state === 'suspended') ctx.resume();
  const src = ctx.createBufferSource();
  src.buffer = state.audioBuffer;
  src.connect(ctx.destination);
  const offset = Math.max(0, Math.min(state.playheadMs / 1000, state.audioBuffer.duration));
  src.start(0, offset);
  state.audioSource = src;
  state.playStartedAt = state.playheadMs;
  state.playStartedCtxTime = ctx.currentTime;
  state.playing = true;
  $('btn-play').textContent = '⏸ 暂停';
}

function seekTo(ms) {
  const wasPlaying = state.playing;
  stopPlayback();
  state.playheadMs = Math.max(0, ms);
  if (wasPlaying && state.audioBuffer) {
    const ctx = ensureAudioContext();
    const src = ctx.createBufferSource();
    src.buffer = state.audioBuffer;
    src.connect(ctx.destination);
    src.start(0, Math.min(state.playheadMs / 1000, state.audioBuffer.duration));
    state.audioSource = src;
    state.playStartedAt = state.playheadMs;
    state.playStartedCtxTime = ctx.currentTime;
    state.playing = true;
    $('btn-play').textContent = '⏸ 暂停';
  }
  updateTimeLabel();
  drawTimeline();
  drawPlayfield();
  updateSnapLabel();
}

function updateTimeLabel() {
  $('time-label').textContent = fmtMs(state.playheadMs);
  $('seek-input').value = Math.round(state.playheadMs);
}

function tick() {
  if (state.playing && state.audioContext && state.playStartedCtxTime != null) {
    state.playheadMs = state.playStartedAt + (state.audioContext.currentTime - state.playStartedCtxTime) * 1000;
    const dur = state.audioBuffer ? state.audioBuffer.duration * 1000 : state.totalMs;
    if (state.playheadMs >= dur) { state.playheadMs = dur; stopPlayback(); }
    updateTimeLabel();
    updateSnapLabel();
    drawTimeline();
    drawPlayfield();
  }
  requestAnimationFrame(tick);
}

// ---------- drawing ----------

function pfTransform() {
  const { width: w, height: h } = canvasSize(playfield);
  const scale = Math.min(w / 512, h / 384);
  const ox = (w - 512 * scale) / 2;
  const oy = (h - 384 * scale) / 2;
  return { scale, ox, oy };
}

function maniaKeys() {
  if (!state.parsed) return 4;
  const cs = parseFloat(osuParser.getKv(state.parsed, 'Difficulty', 'CircleSize', '4'));
  if (!Number.isFinite(cs) || cs < 1) return 4;
  return Math.max(1, Math.min(18, Math.round(cs)));
}

function canvasSize(canvas) {
  return { width: canvas.clientWidth || 1024, height: canvas.clientHeight || 768 };
}

function resizeCanvas(canvas, context) {
  const { width, height } = canvasSize(canvas);
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
}

function selectedForCut(item) {
  const a = state.selectionStart, b = state.selectionEnd;
  return Number.isFinite(a) && Number.isFinite(b) && b > a &&
    item.start < b && (item.end > a || item.start === a);
}

function drawManiaField() {
  const ctx = pfCtx;
  const { width: w, height: h } = canvasSize(playfield);
  const keys = maniaKeys();
  const view = maniaLayout.layoutMania({ width: w, height: h, keys,
    playheadMs: state.playheadMs, speed: state.maniaSpeed, objects: state.objects });
  const { left, top, bottom, fieldWidth, laneWidth, judgeY, yForTime } = view;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#10121b';
  ctx.fillRect(0, 0, w, h);
  if (state.backgroundImage) {
    const image = state.backgroundImage;
    const scale = Math.max(w / image.width, h / image.height);
    ctx.save();
    ctx.globalAlpha = 0.16;
    ctx.drawImage(image, (w - image.width * scale) / 2, (h - image.height * scale) / 2,
      image.width * scale, image.height * scale);
    ctx.restore();
  }
  ctx.font = '12px "Segoe UI", "Microsoft YaHei"';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#dce3f1';
  ctx.fillText(keys + 'K · Mania', left, 23);
  ctx.font = '11px "Segoe UI", "Microsoft YaHei"';
  ctx.fillStyle = '#8e99b0';
  ctx.textAlign = 'right';
  ctx.fillText('↓ 后续音符', left + fieldWidth, 23);

  ctx.fillStyle = 'rgba(3,5,10,.96)';
  ctx.fillRect(left, top, fieldWidth, bottom - top);
  for (let k = 0; k < keys; k++) {
    if (k % 2) { ctx.fillStyle = '#0c1019'; ctx.fillRect(left + k * laneWidth, top, laneWidth, bottom - top); }
    ctx.strokeStyle = '#515a6e';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(left + k * laneWidth, top); ctx.lineTo(left + k * laneWidth, bottom); ctx.stroke();
  }
  ctx.strokeStyle = '#7c879c';
  ctx.strokeRect(left, top, fieldWidth, bottom - top);

  // Labels sit outside the clipping region; all notes stay inside their lanes.
  let lastLabelY = -Infinity;
  const grid = getSnapPoints().filter((point) => point.time >= view.visibleStart && point.time <= view.visibleEnd).reverse();
  for (const point of grid) {
    const y = yForTime(point.time);
    if (point.kind === 'measure' && y - lastLabelY > 28 && Math.abs(y - judgeY) > 22) {
      ctx.textAlign = 'right'; ctx.fillStyle = '#aab4c9'; ctx.font = '10px Consolas, monospace';
      ctx.fillText(fmtMs(point.time), left - 12, y);
      lastLabelY = y;
    }
  }
  ctx.save();
  ctx.beginPath(); ctx.rect(left, top, fieldWidth, bottom - top); ctx.clip();
  for (const point of grid) {
    const y = yForTime(point.time);
    ctx.strokeStyle = point.kind === 'measure' ? '#8d435d' : point.kind === 'beat' ? '#355c80' : '#202b3d';
    ctx.lineWidth = point.kind === 'measure' ? 1.2 : 0.7;
    ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(left + fieldWidth, y); ctx.stroke();
  }
  if (Number.isFinite(state.selectionStart) && state.selectionEnd > state.selectionStart) {
    ctx.fillStyle = 'rgba(255,95,130,.12)';
    const y1 = yForTime(state.selectionEnd), y2 = yForTime(state.selectionStart);
    ctx.fillRect(left, y1, fieldWidth, y2 - y1);
  }
  const pinkLane = (lane) => Math.min(lane, keys - 1 - lane) % 2 === 1;
  for (const body of view.bodies) {
    if (!body.height) continue;
    const gradient = ctx.createLinearGradient(body.x, 0, body.x + body.width, 0);
    const cut = selectedForCut(body.item), pink = pinkLane(body.lane);
    gradient.addColorStop(0, cut ? '#742a43' : pink ? '#6d3b59' : '#535969');
    gradient.addColorStop(0.5, cut ? '#e1859b' : pink ? '#bd7ca2' : '#b6bfce');
    gradient.addColorStop(1, cut ? '#742a43' : pink ? '#6d3b59' : '#535969');
    ctx.fillStyle = gradient;
    ctx.fillRect(body.x, body.y, body.width, body.height);
    ctx.fillStyle = cut ? '#eaa0b6' : pink ? '#d4a0bd' : '#d4dae6';
    ctx.fillRect(body.x, body.y, 0.7, body.height);
    ctx.fillRect(body.x + body.width - 0.7, body.y, 0.7, body.height);
  }
  for (const cap of view.caps) {
    const cut = selectedForCut(cap.item), pink = pinkLane(cap.lane);
    const y = cap.y - cap.height / 2;
    const gradient = ctx.createLinearGradient(cap.x, 0, cap.x + cap.width, 0);
    gradient.addColorStop(0, cut ? '#de6f8f' : pink ? '#b56f99' : '#b1baca');
    gradient.addColorStop(0.5, cut ? '#ffd3df' : pink ? '#f7d4e9' : '#ffffff');
    gradient.addColorStop(1, cut ? '#de6f8f' : pink ? '#b56f99' : '#b1baca');
    ctx.fillStyle = gradient;
    ctx.fillRect(cap.x, y, cap.width, cap.height);
    if (cap.height >= 2) {
      ctx.strokeStyle = cap.kind === 'tail' ? '#c0cad9' : '#f5f7ff';
      ctx.lineWidth = 0.5;
      ctx.strokeRect(cap.x + 0.25, y + 0.25, cap.width - 0.5, cap.height - 0.5);
    }
  }
  ctx.strokeStyle = '#b4ef73'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(left, judgeY); ctx.lineTo(left + fieldWidth, judgeY); ctx.stroke();
  ctx.restore();
  ctx.fillStyle = '#b4ef73'; ctx.textAlign = 'right'; ctx.font = '11px Consolas, monospace';
  ctx.fillText(fmtMs(state.playheadMs), left - 12, judgeY);
  ctx.fillStyle = '#8b98af'; ctx.textAlign = 'center'; ctx.font = '11px "Segoe UI"';
  for (let k = 0; k < keys; k++) ctx.fillText(String(k + 1), left + (k + 0.5) * laneWidth, bottom + 18);
}

function drawPlayfield() {
  const ctx = pfCtx;
  const { width: w, height: h } = canvasSize(playfield);
  ctx.clearRect(0, 0, w, h);
  if (state.mode === 3) {
    drawManiaField();
    return;
  }
  const { scale, ox, oy } = pfTransform();
  ctx.fillStyle = '#1a1030';
  ctx.fillRect(ox, oy, 512 * scale, 384 * scale);
  if (state.backgroundImage) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(ox, oy, 512 * scale, 384 * scale);
    ctx.clip();
    ctx.drawImage(state.backgroundImage, ox, oy, 512 * scale, 384 * scale);
    ctx.restore();
  }
  ctx.strokeStyle = 'rgba(255,255,255,.14)';
  ctx.lineWidth = 1;
  ctx.strokeRect(ox, oy, 512 * scale, 384 * scale);
  let combo = 0;
  for (const item of state.objects) {
    const obj = item.obj;
    if (obj.isNewCombo) combo = (combo + 1 + obj.comboSkip) % 8;
    const cx = ox + obj.x * scale;
    const cy = oy + obj.y * scale;
    const inCut = selectedForCut(item);
    if (obj.kind === 'circle') {
      ctx.beginPath();
      ctx.arc(cx, cy, 42 * scale, 0, Math.PI * 2);
      ctx.fillStyle = inCut ? 'rgba(255,60,90,.75)' : 'rgba(255,102,170,.85)';
      ctx.fill();
      ctx.lineWidth = Math.max(2, 4 * scale / 2);
      ctx.strokeStyle = '#fff';
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = (28 * scale) + 'px Segoe UI';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(combo), cx, cy);
    } else if (obj.kind === 'slider') {
      drawSlider(obj, cx, cy, scale, inCut);
    } else if (obj.kind === 'spinner') {
      ctx.beginPath();
      ctx.arc(ox + 256 * scale, oy + 192 * scale, 110 * scale, 0, Math.PI * 2);
      ctx.lineWidth = Math.max(2, 4 * scale / 2);
      ctx.strokeStyle = inCut ? 'rgba(255,80,100,.9)' : 'rgba(180,220,255,.85)';
      ctx.stroke();
    } else if (obj.kind === 'hold') {
      ctx.fillStyle = inCut ? 'rgba(255,60,90,.75)' : 'rgba(255,200,80,.8)';
      ctx.fillRect(cx - 18 * scale, cy - 90 * scale, 36 * scale, 180 * scale);
    }
  }
}

function drawSlider(obj, cx, cy, scale, inCut) {
  const ctx = pfCtx;
  const points = [];
  if (obj.curvePointsRaw) {
    for (const pair of obj.curvePointsRaw.split('|')) {
      const p = pair.split(':');
      if (p.length >= 2) points.push([Number(p[0]), Number(p[1])]);
    }
  }
  if (!points.length) points.push([obj.x, obj.y]);
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  const { ox, oy } = pfTransform();
  for (const [px, py] of points) ctx.lineTo(ox + px * scale, oy + py * scale);
  ctx.lineWidth = Math.max(3, 6 * scale / 2);
  ctx.strokeStyle = inCut ? 'rgba(255,80,100,.9)' : 'rgba(140,120,255,.9)';
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, 26 * scale, 0, Math.PI * 2);
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.lineWidth = Math.max(2, 3 * scale / 2);
  ctx.strokeStyle = inCut ? '#ff5a70' : '#8c78ff';
  ctx.stroke();
}

function timeToX(ms) {
  const w = canvasSize(timeline).width;
  const pad = 30;
  const t = Math.max(1, state.totalMs);
  return pad + (ms / t) * (w - pad * 2);
}

function xToTime(x) {
  const w = canvasSize(timeline).width;
  const pad = 30;
  const t = Math.max(1, state.totalMs);
  return Math.max(0, Math.min(state.totalMs, ((x - pad) / (w - pad * 2)) * t));
}

function drawTimeline() {
  const ctx = tlCtx;
  const w = canvasSize(timeline).width;
  const h = canvasSize(timeline).height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#120a20';
  ctx.fillRect(0, 0, w, h);
  const pad = 30;
  const axisY = h - 24;
  ctx.font = '10px Segoe UI';
  ctx.textAlign = 'center';
  // measure / beat / tick grid from timing points
  const snapPts = getSnapPoints();
  for (const p of snapPts) {
    const x = timeToX(p.time);
    if (p.kind === 'measure') {
      ctx.strokeStyle = 'rgba(255,150,200,.45)';
      ctx.lineWidth = 1.6;
    } else if (p.kind === 'beat') {
      ctx.strokeStyle = 'rgba(255,255,255,.16)';
      ctx.lineWidth = 1;
    } else {
      ctx.strokeStyle = 'rgba(255,255,255,.06)';
      ctx.lineWidth = 1;
    }
    ctx.beginPath();
    ctx.moveTo(x, 18);
    ctx.lineTo(x, axisY);
    ctx.stroke();
    if (p.kind === 'measure') {
      ctx.fillStyle = 'rgba(255,180,210,.8)';
      ctx.fillText(fmtMs(p.time), x, axisY + 12);
    }
  }
  const selA = state.selectionStart != null ? state.selectionStart : state.cutStart;
  const selB = state.selectionEnd != null ? state.selectionEnd : state.cutEnd;
  if (selA != null && selB != null && selB > selA) {
    const x1 = timeToX(selA);
    const x2 = timeToX(selB);
    ctx.fillStyle = 'rgba(255,122,184,.16)';
    ctx.fillRect(x1, 18, x2 - x1, axisY - 18);
    ctx.fillStyle = 'rgba(255,122,184,.5)';
    ctx.fillRect(x1, 18, 2, axisY - 18);
    ctx.fillRect(x2, 18, 2, axisY - 18);
  }
  // notes
  for (const item of state.objects) {
    const obj = item.obj;
    const x = timeToX(item.start);
    let y = 55;
    if (obj.kind === 'slider') y = 72;
    else if (obj.kind === 'spinner' || obj.kind === 'hold') y = 88;
    if (obj.kind === 'slider') {
      const x2 = timeToX(item.end);
      ctx.strokeStyle = 'rgba(140,120,255,.8)';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x2, y);
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x2, y, 3, 0, Math.PI * 2);
      ctx.fill();
    } else if (obj.kind === 'spinner') {
      const x2 = timeToX(item.end);
      ctx.strokeStyle = 'rgba(180,220,255,.7)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x2, y);
      ctx.stroke();
      ctx.fillStyle = '#b4dcff';
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
    } else if (obj.kind === 'hold') {
      const x2 = timeToX(item.end);
      ctx.fillStyle = 'rgba(255,200,80,.75)';
      ctx.fillRect(x - 3, y - 6, Math.max(3, x2 - x), 12);
    } else {
      ctx.fillStyle = '#ff66aa';
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
  // playhead
  const px = timeToX(state.playheadMs);
  ctx.strokeStyle = '#ff4f6b';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(px, 16);
  ctx.lineTo(px, axisY);
  ctx.stroke();
}

function niceStep(total) {
  if (!(total > 0)) return 1000;
  const rough = total / 12;
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / mag;
  if (norm < 1.5) return mag;
  if (norm < 3.5) return 2 * mag;
  if (norm < 7.5) return 5 * mag;
  return 10 * mag;
}

function updateModeUI() {
  const mania = state.mode === 3;
  $('mania-speed-row').style.display = mania ? 'block' : 'none';
  $('mania-speed').value = state.maniaSpeed;
  $('mania-speed-value').value = state.maniaSpeed.toFixed(2) + '×';
  $('mania-speed-hint').textContent = '前方显示 ' + (maniaLayout.lookaheadMs(state.maniaSpeed) / 1000).toFixed(2) + ' 秒 · 音频速度保持不变';
}

function drawAll() {
  updateModeUI();
  drawPlayfield();
  drawTimeline();
  updateTimeLabel();
  updateSnapLabel();
}

function resizeTimeline() {
  resizeCanvas(timeline, tlCtx);
  resizeCanvas(playfield, pfCtx);
  drawTimeline();
}

// ---------- cut ----------

function currentSelectionRange() {
  // Inputs are authoritative, including edits made after a mouse selection.
  return [timeFormat.parseMilliseconds($('cut-start').value), timeFormat.parseMilliseconds($('cut-end').value)];
}

function updateActionButtons() {
  const busy = state.loading || state.exporting;
  const [a, b] = currentSelectionRange();
  $('btn-cut').disabled = busy || !state.parsed || !state.audioBuffer ||
    !Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b <= a;
  $('btn-export-folder').disabled = $('btn-export-osz').disabled = busy || !state.edited || !state.audioBuffer;
  $('btn-undo').disabled = busy || !state.undo.length;
  $('btn-redo').disabled = busy || !state.redo.length;
  $('btn-reset').disabled = busy || !state.edited;
  for (const id of ['btn-open-osu', 'btn-open-folder', 'btn-open-osz']) $(id).disabled = busy;
}

function syncTimePair(endpoint, fromTimestamp) {
  const msInput = $('cut-' + endpoint), stampInput = $('cut-' + endpoint + '-time');
  const source = fromTimestamp ? stampInput : msInput;
  const value = fromTimestamp ? timeFormat.parseTimestamp(source.value) : timeFormat.parseMilliseconds(source.value);
  for (const input of [msInput, stampInput]) {
    input.removeAttribute('aria-invalid'); input.setCustomValidity('');
  }
  if (fromTimestamp) msInput.value = timeFormat.formatMilliseconds(value);
  else stampInput.value = timeFormat.formatTimestamp(value);
  if (source.value.trim() && !Number.isFinite(value)) {
    source.setAttribute('aria-invalid', 'true');
    source.setCustomValidity('请输入非负毫秒，或合法的分:秒.毫秒时间戳。');
  }
}

function syncSelectionFromInputs(changedId) {
  if (changedId) syncTimePair(changedId.includes('start') ? 'start' : 'end', changedId.endsWith('-time'));
  else { syncTimePair('start', false); syncTimePair('end', false); }
  const [a, b] = currentSelectionRange();
  state.selectionStart = Number.isFinite(a) ? a : null;
  state.selectionEnd = Number.isFinite(b) ? b : null;
  $('selection-label').textContent = a >= 0 && b > a ?
    ('选中 ' + fmtMs(a) + ' - ' + fmtMs(b) + '（' + Math.round(b - a) + ' ms）') : '未选中有效区间';
  const invalid = !!document.querySelector('.time-grid input[aria-invalid="true"]');
  $('time-input-feedback').textContent = invalid ? '请输入非负毫秒，或如 00:49.809 的时间戳（秒数小于 60）。' : '两种格式自动换算，可直接粘贴游戏时间戳。';
  $('time-input-feedback').classList.toggle('error', invalid);
  updateActionButtons();
}

function applySelectionToInputs() {
  const a = Math.min(state.selectionStart, state.selectionEnd);
  const b = Math.max(state.selectionStart, state.selectionEnd);
  $('cut-start').value = cutEngine.roundMs(a);
  $('cut-end').value = cutEngine.roundMs(b);
  syncSelectionFromInputs();
}

function selectRangeFromInputs() {
  syncSelectionFromInputs();
  const [a, b] = currentSelectionRange();
  if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b <= a) {
    alert('请输入合法的开始/结束时间（0 ≤ 开始 < 结束）'); return;
  }
  drawAll();
}

function captureSnapshot() {
  return { text: state.text, parsed: state.parsed, objects: state.objects,
    audioBuffer: state.audioBuffer, playheadMs: state.playheadMs, edited: state.edited };
}

function commitSnapshot(snapshot) {
  stopPlayback();
  Object.assign(state, snapshot);
  state.mode = parseInt(osuParser.getKv(state.parsed, 'General', 'Mode', '0'), 10) || 0;
  state.selectionStart = state.selectionEnd = null;
  state.cutStart = state.cutEnd = 0;
  $('cut-start').value = $('cut-end').value = '0';
  syncSelectionFromInputs();
  state.selectionStart = state.selectionEnd = null;
  $('selection-label').textContent = '未选中区间';
  updateTotal();
  state.snapCacheKey = null;
  state.snapPoints = null;
  $('beatmap-title').textContent = osuParser.getKv(state.parsed, 'Metadata', 'Title', '') +
    ' [' + osuParser.getKv(state.parsed, 'Metadata', 'Version', '') + ']';
  updateMetadataPanel();
  updateActionButtons();
  drawAll();
}

function rememberSnapshot(stack, snapshot) {
  stack.push(snapshot);
  if (stack.length > 10) stack.shift();
}

function doCut() {
  if (state.loading || state.exporting) return;
  if (!state.parsed) { alert('请先加载谱面'); return; }
  const [a, b] = currentSelectionRange();
  try {
    const result = editSession.prepareCut(state.text, state.audioBuffer,
      (channels, frames, rate) => ensureAudioContext().createBuffer(channels, frames, rate), a, b);
    rememberSnapshot(state.undo, captureSnapshot());
    state.redo = [];
    commitSnapshot(result.snapshot);
    const r = result.report;
    $('cut-report').textContent = '已 Cut：删除 ' + r.removedObjects + ' 个 Note，移动 ' + r.shiftedObjects +
      ' 个 Note；补回 ' + r.restoredTimingPoints + ' 个节奏状态点。视频和故事板已移除，可预览后导出。';
  } catch (error) { alert('Cut 失败，原谱面和音频保持不变: ' + error.message); }
}

function undoCut() {
  if (state.loading || state.exporting || !state.undo.length) return;
  rememberSnapshot(state.redo, captureSnapshot());
  commitSnapshot(state.undo.pop());
  $('cut-report').textContent = '已撤销上一次编辑。';
}

function redoCut() {
  if (state.loading || state.exporting || !state.redo.length) return;
  rememberSnapshot(state.undo, captureSnapshot());
  commitSnapshot(state.redo.pop());
  $('cut-report').textContent = '已重做编辑。';
}

function resetCuts() {
  if (state.loading || state.exporting || !state.original || !state.edited) return;
  rememberSnapshot(state.undo, captureSnapshot());
  state.redo = [];
  commitSnapshot(state.original);
  $('cut-report').textContent = '已恢复本次加载的原始谱面和音频。';
}

function exportPayload() {
  if (!state.audioBuffer) throw new Error('没有可导出的音频');
  return {
    sourceDir: state.folder,
    outputParent: state.exportFolder || state.folder,
    osuText: state.text,
    audioBuffer: wav.audioBufferToWav(state.audioBuffer),
    originalAudioName: state.audioFilename,
    oszBaseName: osuParser.getKv(state.parsed, 'Metadata', 'Artist', 'osu') + ' - ' +
      osuParser.getKv(state.parsed, 'Metadata', 'Title', 'cut') + ' [' +
      osuParser.getKv(state.parsed, 'Metadata', 'Version', 'Normal') + ']'
  };
}

async function runExport(channel) {
  if (state.loading || state.exporting || !state.edited) return;
  state.exporting = true;
  updateActionButtons();
  try {
    const res = await ipcRenderer.invoke(channel, exportPayload());
    if (!res.canceled) {
      const warnings = res.warnings && res.warnings.length ? '\n\n注意：\n' + res.warnings.join('\n') : '';
      alert('已导出独立副本：\n' + (res.folder || res.path) + warnings);
    }
  } catch (error) { alert('导出失败：' + error.message); }
  finally { state.exporting = false; updateActionButtons(); }
}

async function exportToFolder() { return runExport('export-cut-folder'); }
async function exportToOsz() { return runExport('export-osz'); }

// ---------- events ----------

async function runImport(channel) {
  try {
    const res = await ipcRenderer.invoke(channel);
    if (res.canceled) return;
    const files = res.osuFiles || res.files || [];
    const outputParent = res.oszPath ? path.dirname(res.oszPath) : res.folder;
    showFileList(files, res.folder, outputParent);
    if (files.length === 1 || channel === 'open-osu-files' && files.length) {
      await loadOsuPath(files[0].path, path.dirname(files[0].path), outputParent);
    }
  } catch (error) { alert('导入失败：' + error.message); }
}

function bind() {
  $('btn-open-osu').addEventListener('click', () => runImport('open-osu-files'));
  $('btn-open-folder').addEventListener('click', () => runImport('open-folder'));
  $('btn-open-osz').addEventListener('click', () => runImport('open-osz'));
  $('btn-play').addEventListener('click', playPause);
  $('btn-stop').addEventListener('click', () => { stopPlayback(); state.playheadMs = 0; updateTimeLabel(); drawTimeline(); drawPlayfield(); });
  $('btn-seek').addEventListener('click', () => seekTo(parseFloat($('seek-input').value) || 0));

  $('snap-divisor').addEventListener('change', (e) => {
    state.snapDivisor = parseInt(e.target.value, 10) || 4;
    state.snapCacheKey = null;
    state.snapPoints = null;
    drawAll();
  });
  $('btn-snap-to-start').addEventListener('click', () => {
    if (!state.parsed) return;
    const t = snapTime(state.playheadMs, 0);
    $('cut-start').value = cutEngine.roundMs(t);
    syncSelectionFromInputs();
    drawAll();
  });
  $('btn-snap-to-end').addEventListener('click', () => {
    if (!state.parsed) return;
    const t = snapTime(state.playheadMs, 0);
    $('cut-end').value = cutEngine.roundMs(t);
    syncSelectionFromInputs();
    drawAll();
  });

  $('mania-speed').addEventListener('input', () => {
    state.maniaSpeed = Math.max(0.5, Math.min(8, Number($('mania-speed').value) || 2));
    updateModeUI();
    drawPlayfield();
  });

  $('btn-select-range').addEventListener('click', selectRangeFromInputs);
  $('btn-cut').addEventListener('click', doCut);
  $('btn-undo').addEventListener('click', undoCut);
  $('btn-redo').addEventListener('click', redoCut);
  $('btn-reset').addEventListener('click', resetCuts);
  $('btn-export-folder').addEventListener('click', exportToFolder);
  $('btn-export-osz').addEventListener('click', exportToOsz);

  for (const id of ['cut-start', 'cut-end', 'cut-start-time', 'cut-end-time']) {
    for (const event of ['input', 'change']) {
      $(id).addEventListener(event, () => { syncSelectionFromInputs(id); drawAll(); });
    }
  }

  timeline.addEventListener('wheel', (e) => {
    if (!state.parsed) return;
    e.preventDefault();
    const dir = e.deltaY < 0 ? -1 : 1;
    const t = snapTime(state.playheadMs, dir);
    seekTo(t);
  }, { passive: false });

  let dragging = false;
  let dragAnchor = null;
  timeline.addEventListener('mousedown', (e) => {
    if (!state.parsed) return;
    dragging = true;
    const rect = timeline.getBoundingClientRect();
    const raw = xToTime(e.clientX - rect.left);
    const t = snapTime(raw, 0);
    dragAnchor = t;
    state.selectionStart = t;
    state.selectionEnd = t;
    applySelectionToInputs();
    drawTimeline();
  });
  timeline.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const rect = timeline.getBoundingClientRect();
    const raw = xToTime(e.clientX - rect.left);
    const t = snapTime(raw, 0);
    state.selectionStart = dragAnchor;
    state.selectionEnd = t;
    applySelectionToInputs();
    drawTimeline();
  });
  window.addEventListener('mouseup', () => {
    if (dragging) {
      dragging = false;
      updateActionButtons();
      drawAll();
    }
  });

  window.addEventListener('resize', () => { resizeTimeline(); drawPlayfield(); });
}

initBrandIcon();
bind();
resizeTimeline();
drawAll();
requestAnimationFrame(tick);
