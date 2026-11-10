/**
 * ============================================================
 *  作者：UltimateREN
 *  日期：2026-10-22
 *  版权声明：本代码归 UltimateREN 所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
"use strict";
// Bounded, awaited stream parser. No provider or management imports.
async function errorDetail(response) {
  if (!response.body) return "";
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 64 * 1024) throw new Error("Upstream error response exceeds limit");
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { try { await reader.cancel(); } finally { reader.releaseLock(); } }
}
async function* sse(response, signal) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "", data = [];
  try {
    while (true) {
      signal.throwIfAborted();
      const read = await reader.read();
      buffer += read.done ? decoder.decode() : decoder.decode(read.value, { stream: true });
      if (Buffer.byteLength(buffer, "utf8") > 1024 * 1024) throw new Error("SSE buffer exceeds limit");
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (!line) {
          if (data.length) { yield data.join("\n"); data = []; }
        } else if (line.startsWith("data:")) {
          data.push(line.slice(5).replace(/^ /, ""));
          if (Buffer.byteLength(data.join("\n"), "utf8") > 1024 * 1024) throw new Error("SSE event exceeds limit");
        }
      }
      if (read.done) break;
    }
    if (buffer.startsWith("data:")) data.push(buffer.slice(5).replace(/^ /, ""));
    if (data.length) yield data.join("\n");
  } finally {
    try { await reader.cancel(); } catch { /* Already closed/aborted. */ }
    reader.releaseLock();
  }
}
module.exports = {errorDetail, sse};
