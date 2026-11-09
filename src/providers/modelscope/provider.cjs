"use strict";
const { sse, errorDetail } = require("../../network/sse.cjs");
const { descriptor } = require("../../model-descriptor.cjs");
const { forwardError } = require("../../../sdk/runtime/provider.cjs");
const { hasContent } = require("../../../sdk/provider-protocol.cjs");

const API_BASE = "https://api-inference.modelscope.cn/v1";
const REAL_NAME = "该魔搭账号绑定的阿里云账号未完成实名认证，无法调用推理。请到 https://www.modelscope.cn/my/accountsettings 完成实名后重试。";
const NEED_BIND = "该魔搭账号尚未绑定阿里云账号，无法调用推理。请到 https://www.modelscope.cn/my/accountsettings 绑定后再试。";
const IMAGE_GENERATION_MODELS = new Set(["qwen/qwen-image", "qwen/qwen-image-2512", "tongyi-mai/z-image-turbo", "tongyi-mai/z-image"]);
const IMAGE_EDITING_MODELS = new Set(["qwen/qwen-image-edit", "qwen/qwen-image-edit-2509", "qwen/qwen-image-edit-2511"]);

function normalizeId(value) {
  return String(value || "").trim().toLowerCase().replace(/_/g, "-");
}
function resolveModel(value, models) {
  const requested = String(value || "").trim();
  const normalized = normalizeId(requested);
  const rows = Array.isArray(models) ? models : [];
  const exact = rows.find(row => normalizeId(row?.id) === normalized);
  if (exact) return String(exact.id);
  const short = rows.filter(row => normalizeId(String(row?.id || "").split("/").pop()) === normalized);
  return short.length === 1 ? String(short[0].id) : requested;
}
function rewriteBody(model, input, models) {
  const body = { ...(input || {}), model: resolveModel(model || input?.model, models) };
  if (body.max_completion_tokens != null && body.max_tokens == null) body.max_tokens = Number(body.max_completion_tokens) || 4096;
  delete body.max_completion_tokens;
  if (body.stream === true) body.stream_options = { ...(body.stream_options || {}), include_usage: true };
  return body;
}
function fail(status, code, message, scope = "invocation", retryable = false) {
  return forwardError({ code, message, category: status === 401 ? "auth" : status === 402 ? "quota" : status === 403 ? "account" : status === 429 ? "rate" : "upstream",
    scope, replay: "unknown", retryable, status });
}
function classify(status, detail) {
  const text = String(detail || "").slice(0, 2048);
  if (/real-name|realname|实名/i.test(text)) return fail(403, "ACCOUNT_REAL_NAME_REQUIRED", REAL_NAME, "account");
  if (/bind your Alibaba Cloud account|绑定阿里云/i.test(text)) return fail(403, "ACCOUNT_BIND_REQUIRED", NEED_BIND, "account");
  if (status === 401) return fail(401, "AUTH_REQUIRED", "ModelScope 登录态无效，请在号池检查凭据", "account");
  if (status === 402 || /insufficient|quota|balance|魔粒|余额|exceeded/i.test(text)) return fail(402, "QUOTA_EXHAUSTED", "ModelScope 上游额度不足", "account");
  if (status === 429) return fail(429, "RATE_LIMITED", "ModelScope 上游请求受限", "account", true);
  return fail(status >= 400 && status <= 599 ? status : 502, "UPSTREAM_FAILED", "ModelScope 模型执行失败", "invocation", status >= 500);
}
function cleanDelta(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === null || item === undefined || item === "" && key !== "content") continue;
    result[key] = item;
  }
  return Object.keys(result).length ? result : null;
}
function usageEvent(usage) {
  if (!usage || typeof usage !== "object") return null;
  const prompt = Number(usage.prompt_tokens ?? usage.input_tokens) || 0;
  const completion = Number(usage.completion_tokens ?? usage.output_tokens) || 0;
  const total = Number(usage.total_tokens) || prompt + completion;
  return prompt || completion || total ? { type: "usage", mode: "snapshot", usage: { ...usage, prompt_tokens: prompt, completion_tokens: completion, total_tokens: total } } : null;
}
function parseFrame(raw) {
  try { const value = JSON.parse(raw); return value && typeof value === "object" && !Array.isArray(value) ? value : null; }
  catch { return null; }
}

function createModelScope(settings = {}) {
  const base = String(settings.base || API_BASE).replace(/\/+$/, "");
  return {
    id: "modelscope", channels: ["modelscope"], requiredFeatures: ["execution-facts@1"],
    async listModels(request, ctx) {
      if (!request.grantId) return [];
      const context = await ctx.pool.context();
      if (request.force !== true) return (context.models || []).map(descriptor);
      const credentials = await ctx.pool.credentials();
      const token = String(credentials?.token || "").trim();
      if (!token) throw fail(401, "AUTH_REQUIRED", "ModelScope 登录态无效，请在号池检查凭据", "account");
      const response = await ctx.pool.network().fetch(`${base}/models`, { method: "GET", redirect: "error", signal: ctx.signal,
        headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
      if (!response.ok) throw classify(response.status, await errorDetail(response));
      let data;
      try { data = JSON.parse(await response.text()); }
      catch { throw fail(502, "INVALID_CATALOG_RESPONSE", "ModelScope 模型目录格式无法解析", "service"); }
      const rows = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
      if (rows.length > 4096) throw fail(502, "CATALOG_LIMIT", "ModelScope 模型目录超过数量上限", "service");
      const seen = new Set(), models = [];
      for (const row of rows) {
        const id = typeof row?.id === "string" ? row.id.trim() : "";
        if (!id || id.length > 160 || /[\x00-\x1f\x7f]/.test(id) || seen.has(id.toLowerCase())) continue;
        seen.add(id.toLowerCase());
        // The upstream catalog supplies ids only. Keep capability claims to the
        // documented chat API and exact image models confirmed by the host reference.
        const key = id.toLowerCase();
        const editing = IMAGE_EDITING_MODELS.has(key);
        const imageModel = editing || IMAGE_GENERATION_MODELS.has(key);
        models.push({ id, name: id, capabilities: imageModel ? { images: editing, tools: false } : { tools: true }, contextLength: 0, maxOutputTokens: 0 });
      }
      if (!models.length) throw fail(502, "EMPTY_CATALOG", "ModelScope 未返回可用模型目录", "service");
      return models;
    },
    async *invoke(request, ctx) {
      const credentials = await ctx.pool.credentials();
      const token = String(credentials?.token || "").trim();
      if (!token) throw fail(401, "AUTH_REQUIRED", "ModelScope 登录态无效，请在号池检查凭据", "account");
      const context = await ctx.pool.context();
      const model = resolveModel(request.model, context.models);
      const body = rewriteBody(model, request.input, context.models);
      const payload = JSON.stringify(body);
      const controller = new AbortController();
      const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;
      const timeoutMs = Math.max(1, Math.min(Number(settings.firstByteTimeoutMs) || 30000, Number.isFinite(ctx.deadlineAt) ? ctx.deadlineAt - Date.now() : 30000));
      const timer = setTimeout(() => controller.abort(new Error("ModelScope response timed out")), timeoutMs);
      timer.unref?.();
      let response;
      try {
        await ctx.attempts?.report({ state: "planned", actualModel: model });
        signal.throwIfAborted();
        response = await ctx.pool.network().fetch(`${base}/chat/completions`, { method: "POST", redirect: "error", signal,
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "text/event-stream, application/json" }, body: payload });
        await ctx.attempts?.report({ state: "responded", actualModel: model });
        if (!response.ok) throw classify(response.status, await errorDetail(response));
        const contentType = String(response.headers?.get?.("content-type") || "");
        if (!/text\/event-stream/i.test(contentType)) {
          clearTimeout(timer);
          let data;
          try { data = JSON.parse(await response.text()); } catch { throw fail(502, "INVALID_UPSTREAM_RESPONSE", "ModelScope 返回无法解析的响应", "invocation"); }
          if (!data || typeof data !== "object" || Array.isArray(data)) throw fail(502, "INVALID_UPSTREAM_RESPONSE", "ModelScope 返回无法解析的响应", "invocation");
          if (data.error) throw classify(Number(data.error.status) || 502, JSON.stringify(data.error));
          const choice = data.choices?.[0];
          const message = choice?.message;
          const delta = cleanDelta(message && hasContent(message) ? message : choice?.delta || message);
          if (delta) yield { type: "delta", delta };
          const usage = usageEvent(data.usage);
          if (usage) yield usage;
          if (!choice) throw fail(502, "EMPTY_UPSTREAM_RESPONSE", "ModelScope 返回空响应", "invocation");
          yield { type: "finish", reason: String(choice.finish_reason || "stop") };
          return;
        }
        let contentSeen = false, finishReason = "";
        for await (const raw of sse(response, signal)) {
          clearTimeout(timer);
          if (!raw || raw === "[DONE]") continue;
          const frame = parseFrame(raw);
          if (!frame) continue;
          if (frame.error) throw classify(Number(frame.error.status) || 502, JSON.stringify(frame.error));
          const choice = frame.choices?.[0];
          if (choice) {
            const delta = cleanDelta(choice.delta && hasContent(choice.delta) ? choice.delta : choice.message || choice.delta);
            if (delta) { contentSeen ||= hasContent(delta); yield { type: "delta", delta }; }
            if (choice.finish_reason) finishReason = String(choice.finish_reason);
          }
          const usage = usageEvent(frame.usage);
          if (usage) yield usage;
        }
        if (!contentSeen) throw fail(502, "EMPTY_UPSTREAM_RESPONSE", "ModelScope 返回空响应", "invocation");
        yield { type: "finish", reason: finishReason };
      } catch (error) {
        if (error?.forwardError) throw error;
        if (signal.aborted) throw fail(504, "UPSTREAM_TIMEOUT", "ModelScope 请求已取消或超时", "invocation", false);
        throw classify(Number(error?.status) || 502, error?.message);
      } finally {
        clearTimeout(timer);
        try { await response?.body?.cancel(); } catch { /* Stream reader may already have closed. */ }
      }
    },
  };
}
module.exports = { createModelScope, resolveModel, rewriteBody, classify };
