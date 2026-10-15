'use strict';

function lookaheadMs(speed) {
  const value = Number(speed);
  return 4000 / Math.max(0.5, Math.min(8, Number.isFinite(value) ? value : 2));
}

function layoutMania({ width, height, keys, playheadMs, speed, objects }) {
  const top = 44, bottom = Math.max(top + 80, height - 32);
  const judgeY = top + (bottom - top) * 0.83;
  const laneWidth = Math.min(64, Math.max(8, (width - 160) / keys));
  const fieldWidth = laneWidth * keys;
  const left = Math.round((width - fieldWidth) / 2 + 22);
  const pixelsPerMs = (judgeY - top) / lookaheadMs(speed);
  const yForTime = (time) => judgeY - (time - playheadMs) * pixelsPerMs;
  const visibleStart = playheadMs - (bottom - judgeY) / pixelsPerMs;
  const visibleEnd = playheadMs + (judgeY - top) / pixelsPerMs;
  const bodies = [], caps = [], laneCaps = Array.from({ length: keys }, () => []);
  for (const item of objects) {
    if (item.end < visibleStart - 30 || item.start > visibleEnd + 30) continue;
    const lane = Math.max(0, Math.min(keys - 1, Math.floor(item.obj.x * keys / 512)));
    const x = left + lane * laneWidth;
    const headY = yForTime(item.start), tailY = yForTime(item.end);
    if (item.obj.kind === 'hold' && item.end > item.start) {
      bodies.push({ item, lane, x: x + laneWidth * 0.18, y: Math.max(top, tailY),
        width: laneWidth * 0.64, height: Math.max(0, Math.min(bottom, headY) - Math.max(top, tailY)) });
      laneCaps[lane].push({ item, lane, kind: 'tail', time: item.end, y: tailY });
    }
    laneCaps[lane].push({ item, lane, kind: 'head', time: item.start, y: headY });
  }
  for (const lane of laneCaps) {
    lane.sort((a, b) => a.time - b.time);
    const times = [...new Set(lane.map((cap) => cap.time))];
    const gaps = new Map(times.map((time, i) => [time, Math.min(
      i > 0 ? time - times[i - 1] : Infinity,
      i + 1 < times.length ? times[i + 1] - time : Infinity
    ) * pixelsPerMs]));
    for (let i = 0; i < lane.length; i++) {
      const cap = lane[i];
      // Fixed thin heads, reduced further when neighbouring timestamps are very close.
      // Coincident endpoints share their real time; never move notes to fake separation.
      const gap = gaps.get(cap.time);
      const thickness = Math.min(cap.kind === 'head' ? 6 : 3, gap * 0.7);
      if (cap.y + thickness / 2 < top || cap.y - thickness / 2 > bottom) continue;
      caps.push({ ...cap, x: left + cap.lane * laneWidth + 2,
        width: laneWidth - 4, height: thickness });
    }
  }
  // All bodies are drawn before caps; a later long note must not cover a note head.
  caps.sort((a, b) => (a.kind === 'tail' ? 0 : 1) - (b.kind === 'tail' ? 0 : 1));
  return { top, bottom, judgeY, laneWidth, fieldWidth, left, pixelsPerMs,
    visibleStart, visibleEnd, yForTime, bodies, caps };
}

module.exports = { lookaheadMs, layoutMania };
