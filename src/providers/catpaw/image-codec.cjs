"use strict";
// Standalone native codec, shipped as a plugin dependency; no Electron/host IPC.
const sharp = require("sharp");
const { current } = require("./runtime-context.cjs");
const waiting = [];
let active = 0;
const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const MAX_PIXELS = 16 * 1024 * 1024;
async function permit(signal) {
  signal.throwIfAborted();
  if (active < 2) { active++; return; }
  if (waiting.length >= 32) throw new Error("Image codec queue exhausted");
  await new Promise((resolve, reject) => {
    const entry = { resolve, reject, signal, abort: null };
    entry.abort = () => { const i = waiting.indexOf(entry); if (i >= 0) waiting.splice(i, 1); reject(signal.reason); };
    signal.addEventListener("abort", entry.abort, { once: true }); waiting.push(entry);
    if (signal.aborted) entry.abort();
  });
}
function release() {
  const next = waiting.shift();
  if (!next) { active--; return; }
  next.signal.removeEventListener("abort", next.abort); next.resolve();
}
async function operate(input, transform) {
  if (!Buffer.isBuffer(input) || input.length > MAX_INPUT_BYTES) throw new Error("Image input exceeds limit");
  const signal = AbortSignal.any([current().signal, AbortSignal.timeout(30000)]);
  await permit(signal);
  let pipeline;
  try {
    signal.throwIfAborted();
    pipeline = sharp(input, { limitInputPixels: MAX_PIXELS, failOn: "error" });
  } catch (error) { release(); throw error; }
  // Native work may already be executing when destroy() is called. Let the
  // caller cancel immediately, but retain its permit until native settlement.
  let abort;
  const aborted = new Promise((_resolve, reject) => {
    abort = () => { pipeline.destroy(); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
  });
  const work = Promise.resolve().then(() => {
    signal.throwIfAborted(); return transform(pipeline);
  }).finally(() => {
    signal.removeEventListener("abort", abort); pipeline.destroy(); release();
  });
  if (signal.aborted) abort();
  return Promise.race([work, aborted]);
}
const codec = {
  async decode(input) {
    const meta = await operate(input, pipeline => pipeline.metadata());
    const rotated = meta.orientation >= 5 && meta.orientation <= 8;
    return { input, width: rotated ? meta.height : meta.width, height: rotated ? meta.width : meta.height };
  },
  resize(handle, maxDimension) {
    if (handle.width <= maxDimension && handle.height <= maxDimension) return handle;
    const scale = Math.min(maxDimension / handle.width, maxDimension / handle.height);
    return { ...handle, width: Math.max(1, Math.round(handle.width * scale)), height: Math.max(1, Math.round(handle.height * scale)) };
  },
  async encodeJpeg(handle, quality) {
    return operate(handle.input, pipeline => pipeline.rotate()
      .resize(handle.width, handle.height, { fit: "inside", withoutEnlargement: true }).jpeg({ quality }).toBuffer());
  },
};
module.exports = { codec, stats: () => ({ active, waiting: waiting.length }) };
