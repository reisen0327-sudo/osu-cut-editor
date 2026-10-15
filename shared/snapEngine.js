'use strict';

// Beat / measure snap engine for osu! editor-like wheel navigation.
// Uses uninherited timing points (red lines) only: beatLength = one beat in ms,
// meter = beats per measure. 1/N means one Nth of a beat, as in osu!'s editor.

const { objectIntervalMs } = require('./osuParser');

function getSection(parsed, name) {
  return parsed.sections && parsed.sections[name] ? parsed.sections[name] : null;
}

function uninheritedPoints(parsed) {
  const sec = getSection(parsed, 'TimingPoints');
  if (!sec || !sec.points) return [];
  return sec.points.filter((tp) => tp.uninherited && tp.beatLength > 0).slice().sort((a, b) => a.time - b.time);
}

function maxTime(parsed) {
  const sec = getSection(parsed, 'HitObjects');
  let max = 0;
  if (sec && sec.objects) {
    for (const obj of sec.objects) max = Math.max(max, objectIntervalMs(parsed, obj)[1]);
  }
  const tsec = getSection(parsed, 'TimingPoints');
  if (tsec && tsec.points) {
    for (const tp of tsec.points) max = Math.max(max, tp.time);
  }
  return max + 10000;
}

function divisorToInterval(beatLength, divisor) {
  const d = Number(divisor) || 4;
  return Math.max(1, beatLength / d);
}

function buildSnapPoints(parsed, divisor, endTime) {
  const reds = uninheritedPoints(parsed);
  const end = endTime == null ? maxTime(parsed) : endTime;
  const points = [];
  const push = (time, kind) => {
    if (time < -1e-6 || time > end + 1e-6) return;
    points.push({ time: Math.round(time * 1000) / 1000, kind });
  };
  for (let i = 0; i < reds.length; i++) {
    const tp = reds[i];
    const nextTime = i + 1 < reds.length ? reds[i + 1].time : end + 1;
    const beat = Math.max(1, tp.beatLength);
    const meter = Math.max(1, tp.meter || 4);
    const measure = beat * meter;
    const interval = divisorToInterval(beat, divisor);
    // start on measure/beat boundaries, then step by interval
    const start = tp.time;
    let t = start + Math.max(0, Math.ceil(-start / interval)) * interval;
    while (t < nextTime - 1e-6 && t <= end + 1e-6) {
      const off = t - start;
      const nearMeasure = Math.abs(off % measure) < 0.01 || Math.abs((off % measure) - measure) < 0.01;
      const nearBeat = Math.abs(off % beat) < 0.01 || Math.abs((off % beat) - beat) < 0.01;
      push(t, nearMeasure ? 'measure' : nearBeat ? 'beat' : 'tick');
      t += interval;
    }
  }
  // dedupe and sort
  const map = new Map();
  for (const p of points) {
    const key = p.time.toFixed(3);
    const prev = map.get(key);
    if (!prev) map.set(key, p);
    else if (p.kind === 'measure' && prev.kind !== 'measure') map.set(key, p);
    else if (p.kind === 'beat' && prev.kind === 'tick') map.set(key, p);
  }
  return Array.from(map.values()).sort((a, b) => a.time - b.time);
}

function snapFromPoints(points, timeMs, direction) {
  if (!points.length) return timeMs;
  let best = points[0].time;
  if (direction < 0) {
    for (const p of points) {
      if (p.time < timeMs - 1e-6) best = p.time;
      else break;
    }
    return best < timeMs ? best : timeMs;
  }
  if (direction > 0) {
    for (const p of points) {
      if (p.time > timeMs + 1e-6) return p.time;
    }
    return timeMs;
  }
  let bestDist = Infinity;
  for (const p of points) {
    const d = Math.abs(p.time - timeMs);
    if (d < bestDist) { bestDist = d; best = p.time; }
  }
  return best;
}

function snapTo(parsed, timeMs, divisor, direction, endTime) {
  return snapFromPoints(buildSnapPoints(parsed, divisor, endTime), timeMs, direction);
}

function measureBeatInfo(parsed, timeMs) {
  const reds = uninheritedPoints(parsed);
  let active = null;
  let next = null;
  for (let i = 0; i < reds.length; i++) {
    if (reds[i].time <= timeMs + 1e-6) active = reds[i];
    else { next = reds[i]; break; }
  }
  if (!active) return { measure: 1, beat: 1, beatLength: 500, meter: 4, bpm: 120 };
  const beat = Math.max(1, active.beatLength);
  const meter = Math.max(1, active.meter || 4);
  const off = Math.max(0, timeMs - active.time);
  const measureIndex = Math.floor(off / (beat * meter)) + 1;
  const inMeasure = off % (beat * meter);
  const beatIndex = Math.floor(inMeasure / beat) + 1;
  const bpm = 60000 / beat;
  return { measure: measureIndex, beat: beatIndex, beatLength: beat, meter, bpm };
}

module.exports = { buildSnapPoints, snapTo, snapFromPoints, measureBeatInfo, divisorToInterval };
