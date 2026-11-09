"use strict";
const { descriptor, privateValue } = require("../../model-descriptor.cjs");
// Accio model execution only. OAuth, credential parsing, refresh, balance,
// check-in and model discovery remain owned by the AgentHub management adapter.
const crypto = require("node:crypto");
const endpoints = require("./endpoints.cjs");
const protocol = require("./protocol.cjs");
const stream = require("./stream.cjs");
const { sse } = require("../../network/sse.cjs");
const { forwardError } = require("../../../sdk/runtime/provider.cjs");

function fail(error, contentSeen = false) {
  if (error?.forwardError) return error;
  const status = Number(error?.status) || 502;
  const kind = protocol.classifyUpstreamError(status, error?.message || "");
  return forwardError({ code: kind === "auth" ? "AUTH_REQUIRED" : kind === "quota" ? "RATE_LIMITED" : "UPSTREAM_FAILED",
    message: kind === "auth" ? "Accio 登录态无效，请在号池检查凭据" : kind === "quota" ? "Accio 上游额度或请求受限" : "Accio 模型执行失败",
    category: kind === "auth" ? "auth" : kind === "quota" ? "rate" : "upstream", scope: kind === "auth" || kind === "quota" ? "account" : "invocation",
    replay: contentSeen ? "unsafe" : "unknown", retryable: !contentSeen && status >= 500, status: status >= 400 && status <= 599 ? status : 502 });
}

function entryFor(models, requested) {
  const key = String(requested || "").toLowerCase();
  // 老配置可能写的是上游代号，目录对外 id 已经换成稳定名，两边都要认。
  return models.find(item => String(item?.id || "").toLowerCase() === key
    || String(privateValue(item, "upstreamKey") || "").toLowerCase() === key) || null;
}

// 上游把模型名换成了不透明代号，展示名才是稳定对外的东西。老配置写的是
// 代号之前的名字，这里按展示名接回去；新模型没有老名字，直接用代号。
// 只接同一个模型，版本跃迁不接（宁可 404，也不静默换成别的模型）。
const STABLE_IDS = [
  ["claude-sonnet-4-6", "Claude Sonnet 4.6"],
  ["claude-opus-4-6", "Claude Opus 4.6"],
  ["gemini-3-flash-preview", "Gemini 3 Flash"],
  ["gemini-3.1-pro-preview", "Gemini 3.1 Pro"],
  ["glm-5", "GLM-5"],
];

function stableId(code, display) {
  const wanted = String(display || "").trim().toLowerCase();
  const hit = STABLE_IDS.find(([, name]) => name.toLowerCase() === wanted);
  return hit ? hit[0] : code;
}

// responses / openai 只认 properties 里的档位，其余落顶层。兜底取顶层：
// Gemini 系放 properties 是硬 400，放顶层只是不出思考内容。
function effortPlacement(item) {
  const protocol = String(item?.protocol || "").trim().toLowerCase();
  return protocol === "responses" || protocol === "openai" ? "properties" : "top";
}

function parseCatalog(payload) {
  const providers = Array.isArray(payload?.data) ? payload.data
    : Array.isArray(payload?.data?.providers) ? payload.data.providers : Array.isArray(payload) ? payload : [];
  const seen = new Set(), models = [];
  for (const provider of providers) for (const item of Array.isArray(provider?.modelList) ? provider.modelList : []) {
    if (item?.visible === false) continue;
    const code = String(item?.modelCode || item?.modelName || "").trim();
    const display = String(item?.modelDisplayName || item?.modelName || code).trim();
    const id = stableId(code, display);
    if (!id || id.length > 160 || /[\x00-\x1f\x7f]/.test(id) || seen.has(id.toLowerCase())) continue;
    seen.add(id.toLowerCase());
    const efforts = Array.isArray(item.reasoningEfforts) ? item.reasoningEfforts.filter(value => typeof value === "string") : [];
    models.push({ id, name: display,
      capabilities: { tools: true, images: item.multimodal === true, reasoning: efforts.length > 0 },
      contextLength: Number.isSafeInteger(Number(item.contextWindow)) && Number(item.contextWindow) > 0 ? Number(item.contextWindow) : 0,
      maxOutputTokens: 0,
      // 发给上游的永远是当前代号，对外 id 可以一直是老名字。
      routing: { upstreamKey: code, protocolKind: effortPlacement(item), reasoningEfforts: efforts } });
  }
  return models;
}

function catalogError(status, message) {
  return forwardError({ code: status === 401 || status === 403 ? "AUTH_REQUIRED" : "CATALOG_REFRESH_FAILED",
    message, category: status === 401 || status === 403 ? "auth" : "upstream",
    scope: status === 401 || status === 403 ? "account" : "service", replay: "safe", retryable: status >= 500,
    status: status >= 400 && status <= 599 ? status : 502 });
}

async function fetchCatalog(ctx, url, region, payload) {
  const response = await ctx.pool.network().fetch(url, { method: "POST", redirect: "error", signal: ctx.signal,
    headers: endpoints.apiHeaders(region), body: JSON.stringify(payload) });
  if (!response.ok) throw Object.assign(new Error("Accio catalog request failed"), { status: response.status });
  const data = await response.json();
  return parseCatalog(data);
}

function createAccio(channel, settings = {}) {
  const region = endpoints.regionOf(channel);
  const base = String(settings.llmBase || endpoints.llmBase()).replace(/\/+$/, "");
  return {
    id: channel, channels: [channel], requiredFeatures: ["explicit-retry-policy@1", "attempt-reservation@1", "execution-facts@1"],
    async listModels(request, ctx) {
      const context = request.grantId ? await ctx.pool.context() : {};
      if (request.force === true) {
        const credentials = await ctx.pool.credentials();
        const token = String(credentials?.token || "").trim();
        if (!token) throw catalogError(401, "Accio 登录态无效，请在号池检查凭据");
        const gateway = String(settings.catalogBase || settings.gatewayBase || endpoints.gatewayBase()).replace(/\/+$/, "");
        let models = [];
        for (const path of [endpoints.MODEL_CONFIG_PATH, endpoints.MODEL_CONFIG_PATH_V2]) {
          try {
            models = await fetchCatalog(ctx, `${gateway}${path}`, region, { token, supportAutoModel: true });
            if (models.length) break;
          } catch (error) {
            if (path === endpoints.MODEL_CONFIG_PATH_V2) throw catalogError(Number(error.status) || 502,
              "Accio 上游模型目录获取失败，已保留原目录");
          }
        }
        if (!models.length) throw catalogError(502, "Accio 上游未返回可见模型，已保留原目录");
        return models.map(descriptor);
      }
      return Array.isArray(context.models) ? context.models.map(descriptor) : [];
    },
    async *invoke(request, ctx) {
      const secrets = await ctx.pool.credentials();
      const token = String(secrets?.token || "").trim();
      if (!token) throw fail({ status: 401 });
      const context = await ctx.pool.context();
      const catalog = Array.isArray(context.models) ? context.models : [];
      const entry = entryFor(catalog, request.model);
      if (!entry) throw fail({ status: 404 });
      const upstreamKey = String(privateValue(entry, "upstreamKey") || entry.id);
      const clientLevel = request.input && (request.input.reasoning_effort || request.input.properties?.reasoning_effort);
      const efforts = privateValue(entry, "reasoningEfforts");
      const effort = clientLevel && String(clientLevel).toLowerCase() !== "off"
        ? protocol.resolveEffort(clientLevel, Array.isArray(efforts) ? efforts : []) : null;
      const placement = privateValue(entry, "protocolKind") === "properties" ? "properties" : "top";
      const built = protocol.buildUpstreamBody(request.input || {}, upstreamKey, token, effort, placement);
      const url = protocol.generateContentUrl(base, built.body.request_id);
      const headers = { "Content-Type": "application/json", Accept: "text/event-stream", "x-package-region": region.packageRegion,
        appKey: endpoints.appKey(), utdid: "", version: endpoints.DEFAULT_APP_VERSION, "Accept-Language": endpoints.ACCEPT_LANGUAGE };
      const payload = JSON.stringify(built.body);
      let response;
      try {
        await ctx.attempts?.report({ state: "planned", actualModel: upstreamKey });
        response = await ctx.pool.network().fetch(url, { method: "POST", headers, body: payload, signal: ctx.signal, redirect: "error" });
        await ctx.attempts?.report({ state: "responded", actualModel: upstreamKey });
        if (!response.ok) throw Object.assign(new Error(`Accio upstream HTTP ${response.status}`), { status: response.status });
        const translator = new stream.Translator(`chatcmpl-${crypto.randomBytes(8).toString("hex")}`, String(request.model || upstreamKey));
        let seen = false;
        for await (const raw of sse(response, ctx.signal)) {
          if (!raw || raw === "[DONE]") continue;
          const frame = stream.parseFrame(raw);
          if (!frame) continue;
          if (stream.frameIsError(frame)) throw Object.assign(new Error(stream.frameErrorText(frame)), { status: protocol.classifyUpstreamError(200, stream.frameErrorText(frame)) === "auth" ? 401 : 502 });
          for (const delta of translator.consume(frame)) {
            if (delta.kind === "content") { seen = true; yield { type: "delta", delta: { content: delta.text } }; }
            else if (delta.kind === "reasoning") { seen = true; yield { type: "delta", delta: { reasoning_content: delta.text } }; }
            else if (delta.kind === "tool_call") yield { type: "delta", delta: { tool_calls: [{ index: delta.index, ...(delta.id ? { id: delta.id } : {}), type: "function", function: { ...(delta.name ? { name: delta.name } : {}), ...(delta.arguments ? { arguments: delta.arguments } : {}) } }] } };
          }
          if (frame.usage) yield { type: "usage", mode: "snapshot", usage: frame.usage };
          if (frame.turnComplete) yield { type: "finish", reason: translator.finalFinishReason() };
        }
        if (!seen) throw Object.assign(new Error("Accio returned an empty response"), { status: 502 });
      } catch (error) { throw fail(error, false); }
    },
  };
}
module.exports = { createAccio, parseCatalog };
