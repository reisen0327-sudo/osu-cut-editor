'use strict';

function parseNumber(v, fallback) {
  if (fallback === undefined) fallback = 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function splitComma(line) {
  return String(line).split(',').map((s) => s.trim());
}

function sectionType(name) {
  if (name === 'HitObjects') return 'objects';
  if (name === 'TimingPoints') return 'timing';
  if (name === 'Events') return 'events';
  if (name === 'Colours') return 'raw';
  return 'kv';
}

function parseOsu(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const parsed = { formatVersion: 14, sectionOrder: [], sections: {} };
  let current = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '' || line.startsWith('//')) continue;
    const m = line.match(/^osu file format v(\d+)/i);
    if (m) {
      parsed.formatVersion = parseInt(m[1], 10);
      continue;
    }
    const sm = line.match(/^\[([^\]]+)\]\s*$/);
    if (sm) {
      const name = sm[1];
      current = name;
      parsed.sectionOrder.push(name);
      const type = sectionType(name);
      parsed.sections[name] = {
        type,
        lines: [],
        entries: type === 'kv' ? [] : undefined,
        map: type === 'kv' ? {} : undefined,
        objects: type === 'objects' ? [] : undefined,
        points: type === 'timing' ? [] : undefined,
        events: type === 'events' ? [] : undefined
      };
      continue;
    }
    if (!current) continue;
    const sec = parsed.sections[current];
    sec.lines.push(raw);
    if (sec.type === 'kv') {
      const idx = raw.indexOf(':');
      if (idx >= 0) {
        const key = raw.slice(0, idx).trim();
        const value = raw.slice(idx + 1).trim();
        sec.entries.push([key, value]);
        sec.map[key] = value;
      }
    } else if (sec.type === 'objects') {
      sec.objects.push(parseHitObject(raw));
    } else if (sec.type === 'timing') {
      sec.points.push(parseTimingPoint(raw));
    } else if (sec.type === 'events') {
      sec.events.push(parseEvent(raw));
    }
  }
  const timing = parsed.sections.TimingPoints;
  if (timing) timing.points.sort((a, b) => a.time - b.time);
  return parsed;
}

function parseTimingPoint(raw) {
  const p = splitComma(raw);
  return {
    raw,
    time: parseNumber(p[0]),
    beatLength: parseNumber(p[1]),
    meter: parseNumber(p[2], 4),
    sampleSet: parseNumber(p[3], 0),
    sampleIndex: parseNumber(p[4], 0),
    volume: parseNumber(p[5], 100),
    uninherited: p[6] === undefined ? parseNumber(p[1]) > 0 : p[6] === '1',
    effects: parseNumber(p[7], 0),
    fields: p
  };
}

function parseEvent(raw) {
  // Event resource names may contain commas inside quotes.
  const p = (String(raw).match(/(?:"[^"]*"|[^,])+/g) || []).map((s) => s.trim());
  const type = p[0];
  const num = /^\d+$/.test(type) ? parseInt(type, 10) : null;
  let start = 0;
  let end = 0;
  if (p.length > 1) start = parseNumber(p[1]);
  if (p.length > 2) end = parseNumber(p[2]);
  const kind =
    type === 'Video' || num === 1 ? 'video' :
    type === 'Break' || num === 2 ? 'break' :
    type === 'Background' || num === 0 ? 'background' : 'other';
  return { raw, type, start, end, kind, fields: p };
}

function parseHitObject(raw) {
  const parts = splitComma(raw);
  const x = parseNumber(parts[0]);
  const y = parseNumber(parts[1]);
  const time = parseNumber(parts[2]);
  const type = parseNumber(parts[3]);
  const hitSound = parseNumber(parts[4], 0);
  const rest = parts.slice(5);
  const kind =
    (type & 128) ? 'hold' :
    (type & 8) ? 'spinner' :
    (type & 2) ? 'slider' :
    (type & 1) ? 'circle' : 'circle';
  let endTime = time;
  let curveType = null;
  let curvePointsRaw = '';
  let slides = 1;
  let length = 0;
  if (kind === 'spinner') {
    endTime = parseNumber(rest[0], time);
  } else if (kind === 'hold') {
    // osu!mania hold: objectParams = endTime:hitSample (colon-separated)
    const first = rest[0] || '';
    const colon = first.indexOf(':');
    endTime = parseNumber(colon >= 0 ? first.slice(0, colon) : first, time);
  } else if (kind === 'slider') {
    const first = rest[0] || '';
    const pipe = first.indexOf('|');
    curveType = pipe >= 0 ? first.slice(0, pipe) : first;
    curvePointsRaw = pipe >= 0 ? first.slice(pipe + 1) : '';
    slides = parseNumber(rest[1], 1);
    length = parseNumber(rest[2], 0);
  }
  return {
    raw, parts, x, y, time, type, hitSound, rest, kind, endTime,
    curveType, curvePointsRaw, slides, length,
    isNewCombo: (type & 4) !== 0,
    comboSkip: (type >> 4) & 7
  };
}

function getSection(parsed, name) {
  return parsed.sections[name] || null;
}

function getKv(parsed, section, key, fallback) {
  if (fallback === undefined) fallback = '';
  const sec = getSection(parsed, section);
  if (!sec || !sec.map) return fallback;
  return key in sec.map ? sec.map[key] : fallback;
}

function setKv(parsed, section, key, value) {
  let sec = getSection(parsed, section);
  if (!sec) {
    parsed.sectionOrder.push(section);
    sec = { type: 'kv', lines: [], entries: [], map: {} };
    parsed.sections[section] = sec;
  }
  const sv = String(value);
  if (key in sec.map) {
    sec.map[key] = sv;
    for (let i = 0; i < sec.entries.length; i++) {
      if (sec.entries[i][0] === key) { sec.entries[i][1] = sv; break; }
    }
  } else {
    sec.map[key] = sv;
    sec.entries.push([key, sv]);
  }
  sec.lines = sec.entries.map((e) => e[0] + ':' + e[1]);
  return sec;
}

function serializeOsu(parsed) {
  const out = [];
  out.push('osu file format v' + parsed.formatVersion);
  out.push('');
  for (const name of parsed.sectionOrder) {
    const sec = parsed.sections[name];
    if (!sec) continue;
    out.push('[' + name + ']');
    if (sec.type === 'kv') {
      for (const e of sec.entries) out.push(e[0] + ':' + e[1]);
    } else if (sec.type === 'objects') {
      for (const o of sec.objects) out.push(o.raw);
    } else if (sec.type === 'timing') {
      for (const t of sec.points) out.push(t.raw);
    } else if (sec.type === 'events') {
      for (const e of sec.events) out.push(e.raw);
    } else {
      for (const l of sec.lines) out.push(l);
    }
    out.push('');
  }
  return out.join('\n');
}

function getSliderMultiplier(parsed) {
  return parseNumber(getKv(parsed, 'Difficulty', 'SliderMultiplier', '1.4'), 1.4);
}

function timingAt(parsed, timeMs) {
  const sec = getSection(parsed, 'TimingPoints');
  if (!sec) return null;
  let active = null;
  for (const t of sec.points) {
    if (t.time <= timeMs + 1e-6) active = t;
    else break;
  }
  return active;
}

function uninheritedAt(parsed, timeMs) {
  const sec = getSection(parsed, 'TimingPoints');
  if (!sec) return null;
  let active = null;
  for (const t of sec.points) {
    if (t.time <= timeMs + 1e-6 && t.uninherited) active = t;
    else if (t.time > timeMs + 1e-6) break;
  }
  return active;
}

function sliderVelocityMultiplierAt(parsed, timeMs) {
  const sec = getSection(parsed, 'TimingPoints');
  if (!sec) return 1;
  let sv = 1;
  for (const t of sec.points) {
    if (t.time > timeMs + 1e-6) break;
    if (t.uninherited) sv = 1;
    else if (t.beatLength < 0) sv = Math.max(0.1, Math.min(10, 100 / -t.beatLength));
  }
  return sv;
}

function sliderDurationMs(parsed, obj) {
  if (obj.kind !== 'slider') return 0;
  const base = uninheritedAt(parsed, obj.time);
  if (!base || base.beatLength <= 0) return 0;
  const sv = sliderVelocityMultiplierAt(parsed, obj.time);
  const velocity = getSliderMultiplier(parsed) * 100 * sv;
  if (velocity <= 0) return 0;
  const numBeats = (obj.length * Math.max(1, obj.slides)) / velocity;
  return numBeats * base.beatLength;
}

function objectIntervalMs(parsed, obj) {
  let end = obj.endTime;
  if (obj.kind === 'slider') end = obj.time + sliderDurationMs(parsed, obj);
  if (!Number.isFinite(end)) end = obj.time;
  return [obj.time, Math.max(obj.time, end)];
}

module.exports = {
  parseOsu, serializeOsu, parseHitObject, parseTimingPoint, parseEvent,
  getSection, getKv, setKv, getSliderMultiplier, timingAt, uninheritedAt,
  sliderVelocityMultiplierAt, sliderDurationMs, objectIntervalMs
};
