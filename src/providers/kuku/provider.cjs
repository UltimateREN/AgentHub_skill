"use strict";
const { descriptor } = require("../../model-descriptor.cjs");
const { randomUUID } = require("node:crypto");
// Kuku model execution only. Login, Cookie parsing, model management, balance,
// check-in, claim and account switching remain owned by the AgentHub core.
const endpoints = require("./endpoints.cjs");
const chat = require("./chat.cjs");
const request = require("./request.cjs");
const session = require("./session.cjs");
const { sse } = require("../../network/sse.cjs");
const { forwardError } = require("../../../sdk/runtime/provider.cjs");
const { hasContent } = require("../../../sdk/provider-protocol.cjs");
const engine = require("./engine.cjs");
const { createEventBridge } = require("../../execution/event-bridge.cjs");

function collectCatalogNames(value, output = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectCatalogNames(item, output);
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (["model_name", "modelname", "modelid"].includes(key.toLowerCase()) && typeof child === "string" && child.trim()) {
        output.add(child.trim());
      } else {
        collectCatalogNames(child, output);
      }
    }
  }
  return [...output].sort((left, right) => left.localeCompare(right));
}

async function fetchCatalog(ctx, credential) {
  const network = ctx.pool.network();
  const fetcher = network.fetch.bind(network);
  const deps = {
    httpJson: (url, options) => httpJson(fetcher, url, options, ctx.signal),
    exchangeStoken: (bduss, ptoken) => engine.exchangeStoken(bduss, ptoken, {
      httpJson: (url, options) => httpJson(fetcher, url, options, ctx.signal),
    }),
    engineAvailable: () => engine.engineAvailable(),
  };
  const triple = await session.ensureTriple(credential, deps, true);
  const url = `${endpoints.baseUrl()}${endpoints.PATHS.modelList}?${endpoints.WEB_QUERY}${session.tokenQuery(triple)}`;
  const response = await httpJson(fetcher, url, {
    method: "GET",
    headers: request.requestHeaders(credential, "application/json, text/plain, */*"),
  }, ctx.signal);
  if (!response.ok) throw classify({ status: response.status }, false);
  if (!response.data || Number(response.data?.status?.code) !== 0) {
    throw Object.assign(new Error("Kuku 模型目录响应缺少成功状态"), { status: 502 });
  }
  const names = collectCatalogNames(response.data.data);
  if (!names.length) throw Object.assign(new Error("Kuku 模型目录为空或格式无法识别"), { status: 502 });
  return names.map(id => descriptor({ id, name: id }));
}

function httpJson(fetcher, url, options = {}, signal) {
  return fetcher(url, { ...options, signal, redirect: "error" }).then(async response => {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > 4 * 1024 * 1024) throw new Error("Kuku response exceeds limit");
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* Provider layer classifies malformed data. */ }
    return { ok: response.ok, status: response.status, data, text };
  });
}

async function fetchStream(fetcher, url, options, signal, firstByteMs, onHeaders) {
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal]);
  let fired = false;
  const timer = setTimeout(() => { fired = true; controller.abort(); }, Math.max(1000, Number(firstByteMs) || 30000));
  try {
    const response = await fetcher(url, { ...options, signal: combined, redirect: "error" });
    await onHeaders?.(response);
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 2048);
      throw Object.assign(new Error(`Kuku upstream HTTP ${response.status}: ${detail}`), { status: response.status });
    }
    return { resp: response, cancelTimer: () => clearTimeout(timer), budgetFired: () => fired };
  } catch (error) {
    clearTimeout(timer);
    if (fired) throw forwardError({ code: "FIRST_BYTE_TIMEOUT", message: "Kuku 上游首事件超时", category: "network", scope: "invocation", replay: "unknown", retryable: false, status: 504 });
    throw error;
  }
}

function classify(error, contentSeen) {
  if (error?.forwardError) return error;
  const status = Number(error?.status) || 502;
  const auth = status === 401 || status === 403;
  return forwardError({ code: auth ? "AUTH_REQUIRED" : "UPSTREAM_FAILED",
    message: auth ? "Kuku 登录态无效，请在号池检查凭据" : "Kuku 模型执行失败",
    category: auth ? "auth" : "upstream", scope: auth ? "account" : "invocation",
    replay: contentSeen ? "unsafe" : "unknown", retryable: status >= 500, status: status === 403 ? 401 : status });
}

function createKuku(settings = {}) {
  const regionSettings = { ...settings };
  if (settings.baseUrl) regionSettings.baseUrl = settings.baseUrl;
  return {
    id: "kuku", channels: ["kuku"],
    async listModels(request, ctx) {
      if (!request.grantId) return [];
      if (request.force === true) {
        const scoped = await ctx.pool.credentials();
        const credential = scoped && typeof scoped === "object" ? {
          bduss: scoped.bduss,
          stoken: scoped.stoken,
          extras: Array.isArray(scoped.extras) ? scoped.extras : [],
          ptoken: scoped.ptoken,
        } : null;
        if (!credential?.bduss) throw classify({ status: 401 }, false);
        return fetchCatalog(ctx, credential);
      }
      const context = await ctx.pool.context();
      return Array.isArray(context.models) ? context.models.map(descriptor) : [];
    },
    async *invoke(request, ctx) {
      const catalog = await ctx.pool.context();
      const allowedModels = Array.isArray(catalog?.models) ? catalog.models.map(item => String(item?.id || item || "")) : [];
      if (!allowedModels.some(item => item === request.model)) throw classify({ status: 404 }, false);
      const scoped = await ctx.pool.credentials();
      const credential = scoped && typeof scoped === "object" ? {
        bduss: scoped.bduss,
        stoken: scoped.stoken,
        extras: Array.isArray(scoped.extras) ? scoped.extras : [],
        ptoken: scoped.ptoken,
      } : null;
      if (!credential?.bduss) throw classify({ status: 401 }, false);
      endpoints.configure(regionSettings);
      const firstByteBudgetMs = payload => {
        const estimate = Math.ceil(String(payload || "").length / 3);
        return Math.min(Number(settings.firstByteMaxMs) || 180000,
          (Number(settings.firstByteBaseMs) || 30000) + Math.floor(estimate / 10000) * 1000);
      };
      let respondedReported = false;
      const reportResponded = async () => {
        if (respondedReported) return;
        respondedReported = true;
        await ctx.attempts?.report({ state: "responded", actualModel: request.model });
      };
      const deps = {
        uuid: randomUUID,
        httpJson: (url, options) => httpJson(ctx.pool.network().fetch.bind(ctx.pool.network()), url, options, ctx.signal),
        exchangeStoken: (bduss, ptoken) => engine.exchangeStoken(bduss, ptoken, { httpJson: (url, options) => httpJson(ctx.pool.network().fetch.bind(ctx.pool.network()), url, options, ctx.signal) }),
        engineAvailable: () => engine.engineAvailable(),
        async fetchStream(url, options) {
          return fetchStream(ctx.pool.network().fetch.bind(ctx.pool.network()), url, options, ctx.signal, options.firstByteMs, reportResponded);
        },
        firstByteBudgetMs,
        verbose() {},
        async pumpSse(response, onEvent) {
          for await (const raw of sse(response, ctx.signal)) onEvent("message", raw);
        },
      };
      let contentSeen = false;
      await ctx.attempts?.report({ state: "planned", actualModel: request.model });
      const bridge = createEventBridge();
      const runner = chat.runChat({ deps, credential, body: request.input, model: request.model,
        emit(event) { contentSeen ||= event.type === "delta" && hasContent(event.delta || {}); bridge.send(event); } })
        .then(() => bridge.finish(), error => bridge.finish(error));
      try {
        for await (const event of bridge.events()) yield event;
        await runner;
        if (!contentSeen) throw Object.assign(new Error("Kuku returned an empty response"), { status: 502 });
      } catch (error) { await runner.catch(() => {}); throw classify(error, contentSeen); }
    },
  };
}

module.exports = { createKuku, collectCatalogNames };
