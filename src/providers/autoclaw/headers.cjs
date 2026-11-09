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
const crypto = require("node:crypto");
function llmPlatformTm() {
  return process.platform === "darwin" ? "mac" : "win";
}

function llmHeaders(cfg, token, routeModelId, sessionHeaders) {
  return {
    "content-type": "application/json",
    accept: "*/*",
    "x-product": "autoclaw",
    "x-client-type": "pc",
    "x-tm": llmPlatformTm(),
    // 版本对齐（12 §6.4）：客户端 X-Version = app.getVersion() = 2.2.0（原兜底 1.17.8 已过期）
    "x-version": cfg.llmVersion || "2.2.0",
    "x-lang": "zh-CN",
    "x-channel": "official",
    // brandHeaders 的原样字面量：小写 x + 下划线，值固定
    x_trace_id: "autoclaw-desktop",
    "x-authorization": `Bearer ${token}`,
    "x-request-id": crypto.randomUUID(),
    "x-request-model": routeModelId,
    ...(sessionHeaders && Object.keys(sessionHeaders).length ? sessionHeaders : {}),
  };
}

const SESSION_HEADER_MAP = [
  ["x-autoclaw-session-id", "X-Session-Id"],
  ["x-autoclaw-agent-id", "X-Agent-Id"],
  ["x-autoclaw-zcode-invocation-id", "X-ZCode-Invocation-Id"],
];

function sessionPassthroughHeaders(clientHeaders) {
  const out = {};
  if (!clientHeaders || typeof clientHeaders !== "object") return out;
  for (const [from, to] of SESSION_HEADER_MAP) {
    for (const key of Object.keys(clientHeaders)) {
      if (key.toLowerCase() === from) {
        const v = String(clientHeaders[key] || "").trim();
        if (v) out[to] = v;
      }
    }
  }
  return out;
}
module.exports = { llmPlatformTm, llmHeaders, SESSION_HEADER_MAP, sessionPassthroughHeaders };
