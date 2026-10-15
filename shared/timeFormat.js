'use strict';

// Internally keep milliseconds to 0.001 ms, matching the cut engine's precision.
function validTime(ms) {
  return Number.isFinite(ms) && ms >= 0 && Number.isSafeInteger(Math.round(ms * 1000));
}

function parseMilliseconds(value) {
  const text = String(value).trim();
  if (!/^\d+(?:\.\d{1,3})?$/.test(text)) return NaN;
  const ms = Number(text);
  return validTime(ms) ? ms : NaN;
}

function parseTimestamp(value) {
  const match = String(value).trim().match(/^(\d+):([0-5]?\d)(?:\.(\d{1,6})|:(\d{3}))?$/);
  if (!match) return NaN;
  const ms = Number(match[1]) * 60000 + Number(match[2]) * 1000 + Number('0.' + (match[3] || match[4] || '0')) * 1000;
  return validTime(ms) ? Math.round(ms * 1000) / 1000 : NaN;
}

function formatMilliseconds(ms) {
  return validTime(ms) ? String(Math.round(ms * 1000) / 1000) : '';
}

function formatTimestamp(ms) {
  if (!validTime(ms)) return '';
  const micros = Math.round(ms * 1000);
  const minutes = Math.floor(micros / 60000000);
  const seconds = Math.floor(micros % 60000000 / 1000000);
  let fraction = String(micros % 1000000).padStart(6, '0');
  while (fraction.length > 3 && fraction.endsWith('0')) fraction = fraction.slice(0, -1);
  return String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0') + '.' + fraction;
}

module.exports = { parseMilliseconds, parseTimestamp, formatMilliseconds, formatTimestamp };
