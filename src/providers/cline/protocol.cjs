/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-22
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
"use strict";
const modelsMod = require("./models.cjs");
const DEFAULT_REASONING_EFFORT = "high";
function parseTryAgainMs(text) {
  const s = String(text || "");
  const marker = s.indexOf("Try again in");
  if (marker < 0) return 0;
  const rest = s.slice(marker + "Try again in".length);
  const end = rest.search(/["\n\r}]/);
  const seg = (end >= 0 ? rest.slice(0, end) : rest).trim();
  let total = 0;
  let num = 0;
  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i];
    if (ch >= "0" && ch <= "9") { num = num * 10 + Number(ch); continue; }
    if (ch === "d") { total += num * 86400000; num = 0; continue; }
    if (ch === "h") { total += num * 3600000; num = 0; continue; }
    if (ch === "m" && seg[i + 1] === "s") { total += num; num = 0; i++; continue; }
    if (ch === "m") { total += num * 60000; num = 0; continue; }
    if (ch === "s") { total += num * 1000; num = 0; continue; }
    if (ch === " ") continue;
    num = 0; // 未知字符重置累积（半截 token 不算数）
  }
  return total > 0 ? total : 0;
}
function upstreamMessage(body) {
  const text = String(body || "");
  try {
    const d = JSON.parse(text);
    if (d && d.error) {
      if (typeof d.error === "string" && d.error.trim()) return d.error.trim();
      if (typeof d.error === "object") {
        const msg = String(d.error.message || "").trim();
        if (msg) return msg;
      }
    }
  } catch { /* 非 JSON 用原文 */ }
  return text.slice(0, 200);
}
function rewriteBody(model, body, entries, pool) {
      const out = structuredClone(body || {});
      out.model = modelsMod.resolveBodyModel(model, entries, pool);
      // 官方 CLI 形态：每请求生成会话标识（sess_<毫秒>），body 与 X-Task-ID 同值
      const sessionId = `sess_${Date.now()}`;
      out.session_id = sessionId;
      // reasoning_effort：客户端 snake_case 优先，驼峰 reasoningEffort 也认（上行统一 snake）；
      // 都没给时注入默认 high（两来源同值；贴近官方客户端形态，无失败面）
      const effort = [out.reasoning_effort, out.reasoningEffort]
        .map((v) => String(v == null ? "" : v).trim())
        .find((v) => v) || DEFAULT_REASONING_EFFORT;
      out.reasoning_effort = effort;
      delete out.reasoningEffort;
      // max_tokens ≤ 0 按缺失处理（对齐上游：0/负数不算显式小值，对上游只会是
      // 参数错误）；保留「缺失时透传缺失」的既有取舍（本适配器刻意不注入默认值）
      if (Number(out.max_tokens) <= 0) delete out.max_tokens;
      return { body: out, sessionId };
    }
module.exports = {parseTryAgainMs, upstreamMessage, rewriteBody};
