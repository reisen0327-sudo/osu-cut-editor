'use strict';

const { parseOsu, serializeOsu, objectIntervalMs, getSection, setKv, getKv,
  parseTimingPoint, parseHitObject, parseEvent } = require('./osuParser');

const CUT_SUFFIX = ' (Cut. Ver)';

function appendOnce(value, suffix) {
  const s = String(value || '').trim();
  return s.endsWith(suffix.trim()) ? s : s + suffix;
}

function applyCutTitle(parsed) {
  const title = getKv(parsed, 'Metadata', 'Title', '');
  setKv(parsed, 'Metadata', 'Title', appendOnce(title, CUT_SUFFIX));
  setKv(parsed, 'Metadata', 'TitleUnicode', appendOnce(getKv(parsed, 'Metadata', 'TitleUnicode', '') || title, CUT_SUFFIX));
  return parsed;
}

function roundMs(n) { return Math.round(n * 1000) / 1000; }

function validateRange(start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error('剪切时间必须为有效数字');
  if (start < 0 || end <= start) throw new Error('剪切范围必须满足 0 ≤ 开始 < 结束');
}

function movePoint(point, time) {
  const fields = point.fields.slice();
  fields[0] = String(roundMs(time));
  return parseTimingPoint(fields.join(','));
}

function stripStoryboard(parsed) {
  const sec = getSection(parsed, 'Events');
  if (sec) {
    sec.events = sec.events.filter((ev) => ev.kind === 'background' || ev.kind === 'break');
    sec.lines = sec.events.map((ev) => ev.raw);
  }
  // Video cannot stay synchronised without editing the video itself.
  delete parsed.sections.Variables;
  parsed.sectionOrder = parsed.sectionOrder.filter((name) => name !== 'Variables');
  return parsed;
}

function prepareIndependentMap(parsed) {
  setKv(parsed, 'Metadata', 'BeatmapID', '0');
  setKv(parsed, 'Metadata', 'BeatmapSetID', '-1');
  return stripStoryboard(parsed);
}

function cutBeatmap(parsed, startMs, endMs) {
  const start = Number(startMs), end = Number(endMs);
  validateRange(start, end);
  const delta = end - start;
  const report = {
    start, end, delta, removedObjects: 0, shiftedObjects: 0,
    removedTimingPoints: 0, shiftedTimingPoints: 0, restoredTimingPoints: 0,
    removedBreaks: 0, shiftedBreaks: 0
  };
  const objectsSec = getSection(parsed, 'HitObjects');
  // Evaluate sliders using ORIGINAL timing. The cut interval is [start, end).
  const plans = (objectsSec ? objectsSec.objects : []).map((obj) => {
    const [s, e] = objectIntervalMs(parsed, obj);
    const action = s < start && e <= start ? 'keep' : s >= end ? 'shift' : 'remove';
    return { obj, action };
  });

  const timingSec = getSection(parsed, 'TimingPoints');
  if (timingSec) {
    const points = timingSec.points.slice().sort((a, b) => a.time - b.time);
    let red = null, last = null;
    for (const t of points) {
      if (t.time >= end) break;
      if (t.uninherited) red = t;
      last = t;
    }
    const kept = points.filter((t) => t.time < start);
    // An original red line at the end already resets all inherited state.
    const boundaryRed = points.some((t) => t.time === end && t.uninherited);
    if (!boundaryRed) {
      if (red && red.time >= start) {
        kept.push(movePoint(red, start));
        report.restoredTimingPoints++;
      }
      if (last && !last.uninherited && last.time >= start) {
        kept.push(movePoint(last, start));
        report.restoredTimingPoints++;
      }
    }
    for (const t of points) {
      if (t.time >= end) {
        kept.push(movePoint(t, t.time - delta));
        report.shiftedTimingPoints++;
      } else if (t.time >= start) report.removedTimingPoints++;
    }
    timingSec.points = kept;
    timingSec.lines = kept.map((t) => t.raw);
  }

  if (objectsSec) {
    const kept = [];
    for (const { obj, action } of plans) {
      if (action === 'remove') { report.removedObjects++; continue; }
      if (action === 'keep') { kept.push(obj); continue; }
      const fields = obj.parts.slice();
      fields[2] = String(roundMs(obj.time - delta));
      if (obj.kind === 'spinner') fields[5] = String(roundMs(obj.endTime - delta));
      if (obj.kind === 'hold') {
        const field = fields[5] || '';
        const colon = field.indexOf(':');
        fields[5] = String(roundMs(obj.endTime - delta)) + (colon < 0 ? '' : field.slice(colon));
      }
      kept.push(parseHitObject(fields.join(',')));
      report.shiftedObjects++;
    }
    objectsSec.objects = kept;
    objectsSec.lines = kept.map((obj) => obj.raw);
  }

  const mapTime = (t) => roundMs(t < start ? t : t >= end ? t - delta : start);
  const eventsSec = getSection(parsed, 'Events');
  if (eventsSec) {
    const kept = [];
    for (const ev of eventsSec.events) {
      if (ev.kind !== 'break') { kept.push(ev); continue; }
      const a = mapTime(ev.start), b = mapTime(ev.end);
      if (b <= a) { report.removedBreaks++; continue; }
      const fields = ev.fields.slice();
      fields[1] = String(a); fields[2] = String(b);
      kept.push(parseEvent(fields.join(',')));
      if (a !== ev.start || b !== ev.end) report.shiftedBreaks++;
    }
    eventsSec.events = kept;
    eventsSec.lines = kept.map((ev) => ev.raw);
  }
  const preview = getKv(parsed, 'General', 'PreviewTime', '');
  if (preview !== '' && Number.isFinite(Number(preview)) && Number(preview) >= 0) {
    setKv(parsed, 'General', 'PreviewTime', Math.round(mapTime(Number(preview))));
  }
  const bookmarks = getKv(parsed, 'Editor', 'Bookmarks', '');
  if (bookmarks !== '') {
    const moved = bookmarks.split(',').map((s) => s.trim()).filter(Boolean).map(Number)
      .filter((t) => Number.isFinite(t) && t >= 0 && (t < start || t >= end))
      .map((t) => Math.round(mapTime(t)));
    setKv(parsed, 'Editor', 'Bookmarks', [...new Set(moved)].sort((a, b) => a - b).join(','));
  }
  prepareIndependentMap(parsed);
  return report;
}

function cutBeatmapText(text, startMs, endMs) {
  const parsed = parseOsu(text);
  const report = cutBeatmap(parsed, startMs, endMs);
  return { text: serializeOsu(parsed), parsed, report };
}

module.exports = { CUT_SUFFIX, applyCutTitle, cutBeatmap, cutBeatmapText,
  stripStoryboard, prepareIndependentMap, validateRange, roundMs };
