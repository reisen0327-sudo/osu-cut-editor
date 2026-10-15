'use strict';

const { cutBeatmapText, applyCutTitle, validateRange } = require('./cutEngine');
const { serializeOsu, parseOsu, getSection, objectIntervalMs } = require('./osuParser');

function objectsFor(parsed) {
  const sec = getSection(parsed, 'HitObjects');
  return (sec ? sec.objects : []).map((obj) => {
    const [start, end] = objectIntervalMs(parsed, obj);
    return { obj, start, end };
  });
}

function snapshotFor(text, audioBuffer, playheadMs = 0, edited = false) {
  const parsed = parseOsu(text);
  return { text, parsed, objects: objectsFor(parsed), audioBuffer, playheadMs, edited };
}

function prepareCut(text, audioBuffer, createBuffer, start, end) {
  validateRange(start, end);
  if (!audioBuffer) throw new Error('没有可剪切的音频，请先加载可解码的音频');
  const { sampleRate, length, numberOfChannels } = audioBuffer;
  if (end > length / sampleRate * 1000 + 1e-6) throw new Error('剪切结束时间不能超出音频长度');
  const first = Math.floor(start / 1000 * sampleRate);
  const last = Math.min(length, Math.floor(end / 1000 * sampleRate));
  if (last <= first) throw new Error('剪切区间至少需要包含一个音频采样点');
  if (length - (last - first) <= 0) throw new Error('不能删除整段音频，请至少保留一个采样点');
  // Every allocation and transformation finishes before the caller commits state.
  const result = cutBeatmapText(text, start, end);
  applyCutTitle(result.parsed);
  const newAudio = createBuffer(numberOfChannels, length - (last - first), sampleRate);
  for (let c = 0; c < numberOfChannels; c++) {
    const src = audioBuffer.getChannelData(c), dest = newAudio.getChannelData(c);
    dest.set(src.subarray(0, first));
    dest.set(src.subarray(last), first);
  }
  const snapshot = snapshotFor(serializeOsu(result.parsed), newAudio, 0, true);
  return { snapshot, report: result.report };
}

module.exports = { objectsFor, snapshotFor, prepareCut };
