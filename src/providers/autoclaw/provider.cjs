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
const { descriptor } = require("../../model-descriptor.cjs");
// Model execution only. Uses the ORIGINAL host's effective noPersist credentials
// and read-only catalog facts. No login, refresh implementation, DB or pool copy.
const defaults = require("./defaults.json");
const models = require("./models.cjs");
const prompt = require("./prompt.cjs");
const headers = require("./headers.cjs");
const { classifyUpstream } = require("../../execution/upstream-errors.cjs");
const { sse, errorDetail } = require("../../network/sse.cjs");
const { forwardError } = require("../../../sdk/runtime/provider.cjs");
const { hasContent } = require("../../../sdk/provider-protocol.cjs");
const catalogCache = new Map();

function rewriteBody(model, body, entries) {
  const { routeModelId, bodyModelId } = models.resolveRoute(model, entries);
  const out = structuredClone(body || {});
  out.model = bodyModelId;
  prompt.normalizeSystemMessages(out);
  prompt.normalizeMaxTokens(out);
  return { body: out, routeModelId, bodyModelId };
}
function errorFor(error, contentSeen = false) {
  const cls = classifyUpstream(error, false);
  const shape = {
    credit: ["quota", "account"], relogin: ["auth", "account"], rate: ["rate", "account"],
    model_rate: ["rate", "account-model"], model_blocked: ["model", "account-model"],
    model_config: ["model", "account-model"], not_found: ["model", "account-model"],
    prompt_too_long: ["model", "invocation"], bad_params: ["model", "invocation"],
    fatal: ["upstream", "invocation"], slow: ["network", "invocation"], server: ["upstream", "account"],
  };
  let [category, scope] = shape[cls.kind] || ["upstream", "invocation"];
  // Connection/TLS/parse uncertainty is an execution fault, never evidence that
  // an account's management login or balance has become invalid.
  if (error.network && cls.kind === "server") { category = "network"; scope = "service"; }
  const rejected = Number(error.status) >= 400 && Number(error.status) < 500 || Number(error.code) > 0;
  const retryAfterMs = cls.resetMs > Date.now() ? Math.min(86400000, cls.resetMs - Date.now()) : 0;
  return forwardError({ code: `UPSTREAM_${cls.kind.toUpperCase()}`,
    message: Number(error.status) === 406 && !String(error.message || "").trim()
      ? "AutoClaw 拒收请求（406），请检查插件的 system 提示、max_tokens 和客户端请求头设置"
      : "AutoClaw 模型调用失败，请查看脱敏诊断",
    category, scope, status: cls.status, retryable: cls.switchable && !contentSeen,
    replay: contentSeen ? "unsafe" : rejected ? "safe" : "unknown",
    ...(retryAfterMs ? { retryAfterMs } : {}),
  });
}
function httpError(status, detail, responseHeaders) {
  let parsed;
  try { parsed = JSON.parse(detail); } catch { /* Text errors retain original classifier input. */ }
  const data = parsed?.error || parsed;
  const raw = String(responseHeaders?.get("retry-after") || "");
  const retryAfterMs = /^[0-9]+$/.test(raw) ? Math.min(86400000, Number(raw) * 1000) : 0;
  return { status, code: data?.code, message: String(data?.message || detail || ""), retryAfterMs };
}
function signedCatalogHeaders(config, token, now = Date.now()) {
  const appId = String(config.authAppId || "100003");
  const timestamp = String(Math.max(0, Math.floor(now / 1000)));
  const sign = crypto.createHash("md5").update(`${appId}&${timestamp}&${String(config.authAppKey || "")}`).digest("hex");
  return { "content-type": "application/json", accept: "*/*", "x-version": config.apiVersion || "2.2.0",
    "x-product": "autoclaw", "x-client-type": "pc", "x-harness-type": "zcode",
    "x-tm": process.platform === "win32" ? "win" : "linux", "x-lang": "zh-CN", "x-channel": "official",
    "x-auth-appid": appId, "x-auth-timestamp": timestamp, "x-auth-sign": sign,
    "x-trace-id": crypto.randomUUID(), ...(token ? { authorization: `Bearer ${token}` } : {}) };
}
function normalizeCatalogEntry(entry) {
  if (typeof entry === "string") {
    const routeId = entry.trim();
    if (!routeId) return null;
    const id = models.stripRoutePrefix(routeId);
    return { id, name: id.toUpperCase(), routeId, routing: { routeId }, capabilities: { images: false, reasoning: true, tools: true } };
  }
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const routeId = typeof entry.id === "string" ? entry.id.trim() : "";
  if (!routeId) return null;
  const id = models.stripRoutePrefix(routeId);
  const contextLength = Number(entry.contextWindow), maxOutputTokens = Number(entry.maxTokens);
  return { id, name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : id.toUpperCase(), routeId,
    routing: { routeId },
    capabilities: { images: Array.isArray(entry.input) && entry.input.includes("image"), reasoning: entry.reasoning !== false, tools: true },
    ...(Number.isSafeInteger(contextLength) && contextLength >= 0 ? { contextLength } : {}),
    ...(Number.isSafeInteger(maxOutputTokens) && maxOutputTokens >= 0 ? { maxOutputTokens } : {}),
    ...(typeof entry.creditConsumptionLevel === "string" && entry.creditConsumptionLevel.trim() ? { rate: entry.creditConsumptionLevel.trim() } : {}) };
}
async function fetchCatalog(request, ctx, config) {
  const credentials = await ctx.pool.credentials();
  const token = String(credentials?.token || "").trim();
  if (!token) throw forwardError({ code: "AUTH_REQUIRED", message: "AutoClaw 登录态无效，请在号池检查凭据", category: "auth", scope: "account", replay: "safe", status: 401 });
  const base = String(config.userapiBase || "").replace(/\/+$/, "");
  if (!base) throw new Error("AutoClaw catalog base is not configured");
  const response = await ctx.pool.network().fetch(`${base}${config.catalogPath || "/autoclaw-proxy/proxy/autoclaw-model-config"}`, {
    method: "GET", headers: signedCatalogHeaders(config, token), signal: request.signal, redirect: "error" });
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > 4 * 1024 * 1024) throw new Error("AutoClaw catalog response exceeds limit");
  if (!response.ok) throw Object.assign(new Error("AutoClaw catalog request failed"), { status: response.status });
  let payload;
  try { payload = JSON.parse(text); } catch { throw new Error("AutoClaw catalog response is invalid JSON"); }
  const authCode = Number(payload?.code ?? payload?.errorCode) || 0;
  if ([410000, 400000].includes(authCode)) throw forwardError({ code: "AUTH_REQUIRED", message: "AutoClaw 登录态已失效，请在号池检查凭据", category: "auth", scope: "account", replay: "safe", status: 401 });
  if (!Array.isArray(payload?.models)) throw new Error("AutoClaw catalog response has no models array");
  const rows = payload.models.map(normalizeCatalogEntry).filter(Boolean);
  const seen = new Set();
  const unique = rows.filter(row => { const key = row.id.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; });
  if (!unique.length) throw new Error("AutoClaw catalog is empty or invalid");
  const key = `${config.channel || ""}:${crypto.createHash("sha256").update(token).digest("hex")}`;
  catalogCache.delete(key);
  catalogCache.set(key, { models: unique, expiresAt: Date.now() + 30 * 60 * 1000 });
  while (catalogCache.size > 256) catalogCache.delete(catalogCache.keys().next().value);
  return unique;
}
function createAutoClaw(channel, settings = {}) {
  if (!["autoclaw", "autoclaw_intl"].includes(channel)) throw new TypeError("Unknown AutoClaw region");
  return {
    id: channel, channels: [channel],
    requiredFeatures: ["attempt-reservation@1", "execution-facts@1", "explicit-retry-policy@1", "request-headers@1"],
    async listModels(request, ctx) {
      const context = request.grantId ? await ctx.pool.context() : {};
      if (request.force === true) return fetchCatalog(request, ctx, { ...defaults[channel], ...settings, channel });
      return (context.models || settings.models || models.STATIC_MODELS).map(descriptor);
    },
    async *invoke(request, ctx) {
      const credentials = await ctx.pool.ensureCredentials("preflight");
      const token = String(credentials.token || "");
      if (!token) throw errorFor({ status: 401 });
      const context = await ctx.pool.context();
      const cacheKey = `${channel}:${crypto.createHash("sha256").update(token).digest("hex")}`;
      const cached = catalogCache.get(cacheKey);
      let entries = cached?.expiresAt > Date.now() ? cached.models : context.models || settings.models || models.STATIC_MODELS;
      if (cached && cached.expiresAt <= Date.now()) catalogCache.delete(cacheKey);
      const hasRequested = entries.some(entry => models.matchCatalogEntry([entry], request.model));
      if (!hasRequested) {
        try { entries = await fetchCatalog({ signal: ctx.signal }, ctx, { ...defaults[channel], ...settings, channel }); }
        catch { /* Keep the account's last host-owned route map as an execution fallback. */ }
      }
      const { body, routeModelId } = rewriteBody(request.model, request.input, entries);
      const config = { ...defaults[channel], ...settings };
      const base = String(config.userapiBase || "").replace(/\/+$/, "");
      const payload = JSON.stringify({ ...body, stream: true });
      const timeoutSetting = (key, fallback) => Number.isFinite(Number(settings[key])) && Number(settings[key]) > 0 ? Math.round(Number(settings[key])) : fallback;
      const firstMs = Math.min(timeoutSetting("firstByteMaxMs", 180000), timeoutSetting("firstByteBaseMs", 30000) + Math.floor(Math.ceil(payload.length / 3) / 10000) * 1000);
      const first = new AbortController(), signal = AbortSignal.any([ctx.signal, first.signal]);
      const timer = setTimeout(() => first.abort(new Error("First upstream event timed out")), Math.min(firstMs, Math.max(1, ctx.deadlineAt - Date.now())));
      let response, contentSeen = false, finishReason = "", streamError;
      try {
        await ctx.attempts.report({ state: "planned", actualModel: body.model });
        signal.throwIfAborted();
        // Proxy/TLS policy transport remains a separate outstanding suite item.
        // This private endpoint/body/header construction always stays in plugin.
        response = await ctx.pool.network().fetch(`${base}${config.llmProxyPath || "/autoclaw-proxy/proxy/autoclaw"}/chat/completions`, {
          method: "POST", signal, redirect: "error", body: payload,
          headers: headers.llmHeaders(config, token, routeModelId, headers.sessionPassthroughHeaders(ctx.request?.headers)),
        });
        await ctx.attempts.report({ state: "responded", actualModel: body.model });
        if (!response.ok) throw errorFor(httpError(response.status, await errorDetail(response), response.headers));
        for await (const raw of sse(response, signal)) {
          // Preserve the original FIRST SSE EVENT budget cancellation, including
          // [DONE]/non-content events; never leave a timer cutting a healthy stream.
          clearTimeout(timer);
          if (!raw || raw === "[DONE]") continue;
          let chunk;
          try { chunk = JSON.parse(raw); } catch { continue; }
          if (!chunk || typeof chunk !== "object") continue;
          if (chunk.error) { streamError = httpError(502, JSON.stringify(chunk.error), response.headers); continue; }
          if (streamError) continue;
          const choice = chunk.choices?.[0];
          if (choice?.delta && Object.keys(choice.delta).length) {
            contentSeen ||= hasContent(choice.delta);
            yield { type: "delta", delta: choice.delta };
          }
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          if (chunk.usage) yield { type: "usage", mode: "snapshot", usage: {
            ...chunk.usage, prompt_tokens: Number(chunk.usage.prompt_tokens) || 0,
            completion_tokens: Number(chunk.usage.completion_tokens) || 0, total_tokens: Number(chunk.usage.total_tokens) || 0,
          } };
        }
        if (streamError) throw errorFor(streamError, contentSeen);
        if (!contentSeen) throw errorFor({ status: 502, network: true });
        yield { type: "finish", reason: finishReason };
      } catch (error) {
        if (error.forwardError) throw error;
        if (ctx.signal.aborted) throw ctx.signal.reason;
        throw errorFor({ network: true, ...(first.signal.aborted ? { firstByteTimeout: true } : {}) }, contentSeen);
      } finally {
        clearTimeout(timer);
        try { await response?.body?.cancel(); } catch { /* Parser may have released its reader already. */ }
      }
    },
  };
}
module.exports = { createAutoClaw, rewriteBody, errorFor, signedCatalogHeaders, normalizeCatalogEntry };
