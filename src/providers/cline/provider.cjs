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
const { descriptor } = require("../../model-descriptor.cjs");
// Model execution only. Account import, login, balance and refresh algorithms
// stay in the original host. This provider only asks the original preflight.
const defaults = require("./defaults.json");
const { buildUpstreamHeaders } = require("./headers.cjs");
const { rewriteBody, parseTryAgainMs, upstreamMessage } = require("./protocol.cjs");
const { parseRecommended, filterByPool } = require("./models.cjs");
const { sse, errorDetail } = require("../../network/sse.cjs");
const { forwardError } = require("../../../sdk/runtime/provider.cjs");
const { hasContent } = require("../../../sdk/provider-protocol.cjs");

function catalogError(status, message) {
  return forwardError({ code: "CATALOG_REFRESH_FAILED", message, category: status === 401 ? "auth" : "upstream",
    scope: status === 401 ? "account" : "service", replay: "safe", retryable: status >= 500,
    status: status >= 400 && status <= 599 ? status : 502 });
}

function catalogRows(payload, channel) {
  const target = channel === "cline_free" ? "free" : "pass";
  return filterByPool(parseRecommended(payload), target)
    .map(({ id, name }) => ({ id, name, capabilities: { tools: true } }));
}

function retryAfter(headers) {
  const cap = 2 * 3600000;
  for (const [key, kind] of [["retry-after", "s"], ["retry-after-ms", "ms"], ["x-ratelimit-reset", "epoch"]]) {
    const raw = String(headers?.get(key) || "").trim();
    if (!/^[0-9]+$/.test(raw)) continue;
    const value = Number(raw);
    const ms = kind === "s" ? value * 1000 : kind === "ms" ? value : (raw.length >= 12 ? value : value * 1000) - Date.now();
    if (ms > 0 && ms <= cap) return ms;
  }
  return 0;
}

function errorFor(status, detail, headers, contentSeen = false) {
  // Raw detail stays in-process. 403/404 are deterministic and do not punish
  // accounts or trigger another account merely because replay would be safe.
  const message = upstreamMessage(detail);
  const channel = status === 403 && /product surfaces|not a supported client|unapproved (channel|client)/i.test(message);
  const denied = status === 403 || status === 404;
  const auth = status === 401, rate = status === 429;
  const retryAfterMs = rate ? Math.min(86400000, parseTryAgainMs(detail) || retryAfter(headers)) : 0;
  return forwardError({
    code: channel ? "CLIENT_SURFACE_REJECTED" : denied ? "MODEL_DENIED" : auth ? "AUTH_REQUIRED" : rate ? "RATE_LIMITED" : "UPSTREAM_FAILED",
    message: channel ? "Cline 产品面校验失败，请检查插件的客户端请求头设置" : denied ? "Cline 拒绝该模型，请检查模型或订阅权限" : auth ? "Cline 登录态无效，请在号池检查凭据" : rate ? "Cline 上游请求受限" : "Cline 模型上游返回错误",
    category: denied ? "model" : auth ? "auth" : rate ? "rate" : "upstream",
    scope: channel ? "service" : denied ? "invocation" : auth || rate ? "account" : "invocation",
    replay: contentSeen ? "unsafe" : denied || auth || rate ? "safe" : "unknown",
    retryable: !denied && !contentSeen,
    status: status >= 400 && status <= 599 ? status : 502,
    ...(retryAfterMs > 0 ? { retryAfterMs } : {}),
  });
}

function createCline(channel, settings = {}) {
  if (!["cline_free", "cline_pass"].includes(channel)) throw new TypeError("Unknown Cline pool");
  const pool = channel === "cline_free" ? "free" : "pass";
  return {
    id: channel, channels: [channel], requiredFeatures: ["explicit-retry-policy@1", "attempt-reservation@1", "execution-facts@1"],
    async listModels(request, ctx) {
      const context = request.grantId ? await ctx.pool.context() : {};
      if (request.force === true) {
        const base = String(settings.apiBase || defaults.apiBase).replace(/\/+$/, "");
        let response;
        try {
          response = await ctx.pool.network().fetch(`${base}/ai/cline/recommended-models`, {
            method: "GET", redirect: "error", signal: ctx.signal,
            headers: { Accept: "application/json", "X-CLIENT-TYPE": "cline-sdk" },
          });
        } catch { throw catalogError(502, "Cline 上游模型目录请求失败"); }
        if (!response.ok) throw catalogError(response.status, `Cline 上游模型目录请求失败（HTTP ${response.status}）`);
        let payload;
        try { payload = await response.json(); }
        catch { throw catalogError(502, "Cline 上游模型目录格式无法解析"); }
        const refreshed = catalogRows(payload, channel);
        if (!refreshed.length) throw catalogError(502, "Cline 上游没有返回当前渠道可用模型");
        return refreshed.map(descriptor);
      }
      const entries = context.models || settings.models?.[channel] || [];
      return entries.map(descriptor);
    },
    async *invoke(request, ctx) {
      // Original refresh window/noPersist/single-flight and persistence owner.
      // No new refresh implementation or second 401 refresh inside the plugin.
      const secrets = await ctx.pool.ensureCredentials("preflight");
      const raw = String(secrets.token || "").trim();
      if (!raw) throw errorFor(401, "");
      const token = raw.startsWith("workos:") ? raw : `workos:${raw}`;
      const context = await ctx.pool.context();
      const { body, sessionId } = rewriteBody(request.model, request.input, context.models || [], pool);
      const config = { upstreamHeaders: { ...defaults.upstreamHeaders, ...settings.upstreamHeaders } };
      const headers = buildUpstreamHeaders(config, {
        "content-type": "application/json", accept: "text/event-stream",
        authorization: `Bearer ${token}`, "x-task-id": sessionId,
      });
      const base = String(settings.apiBase || defaults.apiBase).replace(/\/+$/, "");
      const payload = JSON.stringify({ ...body, stream: true });
      const setting = (key, fallback) => Number.isFinite(Number(settings[key])) && Number(settings[key]) > 0 ? Math.round(Number(settings[key])) : fallback;
      const firstMs = Math.min(setting("firstByteMaxMs", 180000), setting("firstByteBaseMs", 30000) + Math.floor(Math.ceil(payload.length / 3) / 10000) * 1000);
      const first = new AbortController();
      const signal = AbortSignal.any([ctx.signal, first.signal]);
      const timer = setTimeout(() => first.abort(new Error("First model event timed out")), Math.max(1, Math.min(firstMs, ctx.deadlineAt - Date.now())));
      let response, finishReason = "", contentSeen = false, upstreamError;
      try {
        await ctx.attempts.report({ state: "planned", actualModel: body.model });
        signal.throwIfAborted();
        // Private HTTP remains in the plugin; egress/TLS integration is still a
        // separate outstanding suite requirement, never a host private fetch.
        response = await ctx.pool.network().fetch(`${base}/chat/completions`, { method: "POST", headers, body: payload, signal, redirect: "error" });
        await ctx.attempts.report({ state: "responded", actualModel: body.model });
        if (!response.ok) throw errorFor(response.status, await errorDetail(response), response.headers);
        for await (const raw of sse(response, signal)) {
          clearTimeout(timer);
          if (!raw || raw === "[DONE]") continue;
          let chunk;
          try { chunk = JSON.parse(raw); } catch { continue; }
          if (!chunk || typeof chunk !== "object") continue;
          if (chunk.error) {
            upstreamError = errorFor(502, JSON.stringify(chunk.error), response.headers, contentSeen);
            continue;
          }
          if (upstreamError) continue;
          const choice = chunk.choices?.[0];
          if (choice?.delta && Object.keys(choice.delta).length) {
            contentSeen ||= hasContent(choice.delta);
            yield { type: "delta", delta: choice.delta };
          }
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          if (chunk.usage) yield { type: "usage", mode: "snapshot", usage: {
            ...chunk.usage, prompt_tokens: Number(chunk.usage.prompt_tokens) || 0,
            completion_tokens: Number(chunk.usage.completion_tokens) || 0,
            total_tokens: Number(chunk.usage.total_tokens) || 0,
          } };
        }
        if (upstreamError) throw upstreamError;
        if (!contentSeen) throw errorFor(502, "");
        yield { type: "finish", reason: finishReason };
      } finally {
        clearTimeout(timer);
        try { await response?.body?.cancel(); } catch { /* Stream reader already stopped. */ }
      }
    },
  };
}
module.exports = { createCline, errorFor, retryAfter, catalogRows };
