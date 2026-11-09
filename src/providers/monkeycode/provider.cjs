"use strict";
const { descriptor } = require("../../model-descriptor.cjs");
// MonkeyCode model execution only. Account import, session parsing, image-id
// metadata and the original management singleton remain in AgentHub.
const { createEventBridge } = require("../../execution/event-bridge.cjs");
const { forwardError } = require("../../../sdk/runtime/provider.cjs");
const { hasContent } = require("../../../sdk/provider-protocol.cjs");
const regionStore = require("./region.cjs");
const endpoints = require("./endpoints.cjs");
const task = require("./task.cjs");
const stream = require("./stream.cjs");

function httpJson(fetcher, url, options = {}) {
  return fetcher(url, { ...options, redirect: "error" }).then(async response => {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > 4 * 1024 * 1024) throw new Error("MonkeyCode response exceeds limit");
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* task layer classifies malformed responses */ }
    return { ok: response.ok, status: response.status, data, text };
  });
}

function publicFailure(error, fallback = "MonkeyCode 模型执行失败") {
  const status = Number(error?.status) || 502;
  const category = status === 401 ? "auth" : status === 402 ? "quota" : status === 429 || status === 409 ? "rate" : "upstream";
  return forwardError({
    code: status === 401 ? "AUTH_REQUIRED" : status === 409 ? "TASK_BUSY" : status === 402 ? "QUOTA_EXHAUSTED" : "UPSTREAM_FAILED",
    message: status === 401 ? "MonkeyCode 登录态无效，请在号池重新粘贴 session" : status === 409 ? "MonkeyCode 账号已有运行中的任务" : fallback,
    category, scope: status === 401 || status === 402 || status === 429 ? "account" : "invocation",
    replay: "unknown", retryable: status >= 500 || status === 409, status,
  });
}

function modelTarget(models, requested) {
  const key = String(requested || "").toLowerCase();
  const row = models.find(item => String(item?.id || "").toLowerCase() === key || String(item?.name || "").toLowerCase() === key || String(item?.model || "").toLowerCase() === key);
  const route = row?.routing || row;
  if (!row || !route.upstreamId) return null;
  return { modelId: route.upstreamId, cliName: route.cliName || endpoints.cliNameFor(route.interfaceType), model: route.model || row.id };
}

function createMonkeyCode(channel, settings = {}) {
  if (!regionStore.byChannel(channel)) throw new TypeError("Unknown MonkeyCode channel");
  return {
    id: channel, channels: [channel],
    async listModels(request, ctx) {
      const context = request.grantId ? await ctx.pool.context() : {};
      if (!request.force) return (context.models || settings.models || []).map(descriptor);
      const credentials = await ctx.pool.credentials();
      const session = String(credentials?.session || "").trim();
      if (!session) throw new Error("MonkeyCode catalog refresh requires an account session");
      const region = regionStore.byChannel(channel);
      const base = String(settings.baseUrl || region.siteOrigin).replace(/\/+$/, "");
      const url = settings.modelsUrl || `${base}/api/v1/users/models`;
      const response = await ctx.pool.network().fetch(url, { method: "GET", redirect: "error", signal: ctx.signal,
        headers: { "User-Agent": settings.userAgent || "monkeycode-local-proxy", Origin: region.siteOrigin,
          Referer: `${region.siteOrigin}/`, Accept: "application/json", Cookie: `monkeycode_ai_session=${session}` } });
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > 4 * 1024 * 1024) throw new Error("MonkeyCode catalog response exceeds limit");
      let payload; try { payload = text ? JSON.parse(text) : null; } catch { throw new Error("MonkeyCode catalog returned invalid JSON"); }
      if (!response.ok) throw new Error(`MonkeyCode catalog HTTP ${response.status}`);
      const source = payload?.data && typeof payload.data === "object" ? payload.data : payload;
      const rows = Array.isArray(source) ? source : Array.isArray(source?.models) ? source.models : [];
      const seen = new Set();
      const models = rows.flatMap(row => {
        if (!row || typeof row !== "object" || typeof row.model !== "string" || !row.model.trim()) return [];
        const id = row.provider ? `${row.provider}/${row.model}` : row.model;
        if (seen.has(id.toLowerCase())) return [];
        seen.add(id.toLowerCase());
        const contextLength = Math.max(0, Math.trunc(Number(row.context_limit) || 0));
        const maxOutputTokens = Math.max(0, Math.trunc(Number(row.output_limit) || 0));
        return [{ id, name: String(row.display_name || row.model), contextLength, maxOutputTokens,
          capabilities: { tools: true, images: false, reasoning: row.thinking_enabled === true },
          routing: { upstreamId: String(row.id || ""), interfaceType: String(row.interface_type || ""),
            model: row.model, cliName: endpoints.cliNameFor(row.interface_type) } }];
      });
      if (!models.length) throw new Error("MonkeyCode model catalog is empty or invalid");
      return models.map(descriptor);
    },
    async *invoke(request, ctx) {
      const secrets = await ctx.pool.credentials();
      const session = String(secrets?.session || "").trim();
      if (!session) throw publicFailure({ status: 401 });
      const context = await ctx.pool.context();
      const imageId = String(context.identity?.imageId || settings.imageId || "").trim();
      if (!imageId) throw forwardError({ code: "IMAGE_ID_REQUIRED", message: "MonkeyCode 账号缺少镜像 id，请先在官网运行一次任务后重试", category: "upstream", scope: "invocation", replay: "safe", status: 400 });
      const models = Array.isArray(context.models) ? context.models : [];
      const target = modelTarget(models, request.model || request.input?.model);
      if (!target) throw forwardError({ code: "MODEL_NOT_FOUND", message: "MonkeyCode 模型目录中没有请求的模型，请先刷新模型清单", category: "upstream", scope: "invocation", replay: "safe", status: 503 });
      const prompt = task.buildPrompt(request.input?.messages);
      const section = settings;
      const region = regionStore.byChannel(channel);
      const fetcher = ctx.pool.network().fetch;
      const deps = { httpJson: (url, options) => httpJson(fetcher, url, options), streamIdleMs: Number(settings.streamIdleMs) || 0, verbose: () => {} };
      const taskId = await task.createTask({ region, section, deps, session, prompt, target, imageId });
      const bridge = createEventBridge();
      const runner = stream.runTaskStream({ region, section, deps, session, taskId,
        prompt: prompt.prompt, requestedModel: request.model, includeUsage: request.input?.stream_options?.include_usage === true,
        emit: event => bridge.send(event), signal: ctx.signal, webSocket: ctx.pool.network().webSocket }).then(() => bridge.finish(), error => bridge.finish(error));
      try {
        for await (const event of bridge.events()) {
          if (event.type === "delta" && !hasContent(event.delta || {})) continue;
          yield event.type === "usage" ? { ...event, mode: "snapshot" } : event;
        }
        await runner;
      } catch (error) {
        await runner.catch(() => {});
        throw publicFailure(error);
      }
    },
  };
}

module.exports = { createMonkeyCode };
