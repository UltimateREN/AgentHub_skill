"use strict";
// Private model network only. No host source, management parser or refresh code.
const crypto = require("node:crypto");
const CatPawError = require("./errors.cjs");
const { unwrapApiData } = require("./api-envelope.cjs");
const { current } = require("./runtime-context.cjs");
const DEFAULT_CFG = Object.freeze({
  baseUrl: "https://ai.catpaw.meituan.com", source: "CatX", mode: "CATX_APP",
  toolVersion: "2.0.2", agentVersion: "1.0.1", appKey: "fe_com.sankuai.catpaw.external.front",
  permissionMode: "unsafeBypassPermissions", requestTimeoutMs: 30000, stopTimeoutMs: 3000, sseTimeoutMs: 900000,
});
function settings() { return current().settings; }
function configuration(raw = {}) {
  const result = { ...DEFAULT_CFG };
  for (const key of Object.keys(result)) if (raw[key] !== undefined && raw[key] !== null) result[key] = raw[key];
  const url = new URL(result.baseUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new TypeError("Invalid CatPaw execution endpoint");
  result.baseUrl = String(result.baseUrl).replace(/\/+$/, "");
  for (const key of ["requestTimeoutMs", "stopTimeoutMs", "sseTimeoutMs"]) {
    if (!Number.isSafeInteger(result[key]) || result[key] < 1 || result[key] > 86400000) throw new TypeError("Invalid CatPaw execution timeout");
  }
  for (const key of ["source", "mode", "toolVersion", "agentVersion", "appKey", "permissionMode"]) {
    if (typeof result[key] !== "string" || !result[key] || result[key].length > 256 || /[\x00-\x1f\x7f]/.test(result[key])) throw new TypeError("Invalid CatPaw execution setting");
  }
  if (raw.proxy || raw.ca || raw.rejectUnauthorized === false) throw new TypeError("CatPaw proxy/TLS policy is not implemented");
  return Object.freeze(result);
}
function upstreamBaseUrl() { return settings().baseUrl; }
function requestHeaders(credentials, accept) {
  const cfg = settings();
  const token = String(credentials.token || "").trim(), uid = String(credentials.uid || "").trim();
  if (!token || /[\x00-\x1f\x7f;]/.test(token) || /[\x00-\x1f\x7f]/.test(uid)) throw CatPawError.badRequest("CatPaw 有效凭据格式不可用");
  return { Accept: accept, "Content-Type": "application/json", "M-TRACEID": crypto.randomUUID().replace(/-/g, ""),
    "M-APPKEY": cfg.appKey, "gray-set": "new-agent-sdk", enableHeartBeat: "true", "X-Agent-Version": cfg.agentVersion,
    Cookie: "X-Passport-Token=" + token, ...(uid ? { "user-uid": uid } : {}) };
}
function budget(timeoutMs, cleanup) {
  const ctx = current();
  const ms = cleanup && ctx.signal.aborted ? Math.min(timeoutMs, 300) : timeoutMs;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(new Error("CatPaw upstream deadline")), ms);
  return { signal: cleanup ? controller.signal : AbortSignal.any([ctx.signal, controller.signal]), close: () => clearTimeout(timer) };
}
async function text(response, signal, maxBytes = 8 * 1024 * 1024) {
  if (!response.body) return "";
  const reader = response.body.getReader(), chunks = [];
  let bytes = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw CatPawError.upstream("CatPaw 上游响应超过限制");
      chunks.push(Buffer.from(chunk.value));
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { try { await reader.cancel(); } finally { reader.releaseLock(); } }
}
async function postJson(baseUrl, route, credentials, body, timeoutMs = settings().requestTimeoutMs, cleanup = false) {
  const bound = budget(timeoutMs, cleanup);
  try {
    const response = await current().network.fetch(baseUrl + route, { method: "POST", redirect: "error", signal: bound.signal,
      headers: requestHeaders(credentials, "application/json"), body: JSON.stringify(body) });
    const raw = await text(response, bound.signal);
    if (!response.ok) throw CatPawError.http(response.status, raw.slice(0, 500));
    let value; try { value = JSON.parse(raw); } catch { value = null; }
    return unwrapApiData(value);
  } finally { bound.close(); }
}
function statusBody(conversationId, status, error) {
  const data = { status };
  if (error) {
    data.failReason = String(error.message || "").slice(0, 500);
    if (error.code !== null && Number.isFinite(Number(error.code))) data.failCode = Number(error.code);
    if (error.unifyCode !== null && Number.isFinite(Number(error.unifyCode))) data.unifyCode = Number(error.unifyCode);
  }
  return { conversationId, eventType: "conversation", data };
}
async function reportStatus(baseUrl, credentials, conversationId, status, error) {
  return postJson(baseUrl, "/api/agent/conversation/event", credentials, statusBody(conversationId, status, error));
}
async function reportTerminal(baseUrl, credentials, conversationId, status, error) {
  if (!conversationId) return;
  try { await postJson(baseUrl, "/api/agent/conversation/event", credentials, statusBody(conversationId, status, error), settings().stopTimeoutMs, true); }
  catch { /* Best-effort terminal cleanup does not replace the primary result. */ }
}
async function stopTurn(baseUrl, credentials, conversationId, turnRequestId) {
  if (!conversationId || !turnRequestId) return;
  try { await postJson(baseUrl, "/api/agent/conversation/turn/stop", credentials, { conversationId, turnRequestId }, settings().stopTimeoutMs, true); }
  catch { /* Bounded best effort with already delivered credentials, no new grant read. */ }
}
async function turnRequest(baseUrl, credentials, body) {
  const ctx = current(), bound = budget(settings().sseTimeoutMs, false);
  const actualModel = String(body.modelType);
  let response;
  try {
    await ctx.sdk.attempts.report({ state: "planned", actualModel });
    bound.signal.throwIfAborted();
    response = await current().network.fetch(baseUrl + "/api/agent/conversation/turn", { method: "POST", redirect: "error", signal: bound.signal,
      headers: requestHeaders(credentials, "text/event-stream"), body: JSON.stringify(body) });
    await ctx.sdk.attempts.report({ state: "responded", actualModel });
    if (!response.ok) throw CatPawError.http(response.status, (await text(response, bound.signal, 65536)).slice(0, 500));
    return { response, cancelTimer: bound.close };
  } catch (error) {
    bound.close();
    try { await response?.body?.cancel(); } catch { /* Already consumed. */ }
    throw error;
  }
}
module.exports = { settings, configuration, upstreamBaseUrl, requestHeaders, postJson, reportStatus, reportTerminal, stopTurn, turnRequest };
