"use strict";
const crypto = require("node:crypto");
const { descriptor } = require("../../model-descriptor.cjs");
const { sse } = require("../../network/sse.cjs");
const { forwardError, hasContent } = require("../../../sdk/provider-protocol.cjs");
const catalog = require("./catalog.cjs");
const payload = require("./payload.cjs");
const catalogs = new Map();

const DEFAULTS = Object.freeze({
  chatUrl: "https://trae-api-cn.mchost.guru/api/agent/v3/llm_utils_chat",
  modelsUrl: "https://trae-api-cn.mchost.guru/api/ide/v1/get_detail_param",
  batchModelsUrl: "https://trae-api-cn.mchost.guru/api/ide/v1/batch_get_detail_param",
  userAgent: "TraeClient/TTNet", appId: "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8",
  ideVersion: "0.1.50", ideVersionCode: "20260811", deviceBrand: "CREFG-XX",
  osVersion: "Windows 11 Home China",
});

function ids(account) {
  const seed = String(account?.accountId || account?.uid || "anon");
  const hash = crypto.createHash("sha256").update(`agenthub:device:${seed}`).digest();
  let deviceId = String((hash[0] % 9) + 1);
  for (let i = 1; i < 15; i++) deviceId += String(hash[i] % 10);
  return { deviceId, machineId: crypto.createHash("sha256").update(`agenthub:machine:${seed}`).digest("hex") };
}
function norm(value) { return String(value).toLowerCase().replace(/_/g, "-"); }
function setting(settings, key, fallback) { return settings?.[key] === undefined ? fallback : settings[key]; }
function mapModel(model, settings) {
  const map = settings.modelMap || {};
  const key = Object.keys(map).find(item => item === model || norm(item) === norm(model));
  const value = key ? map[key] : null;
  return Array.isArray(value) && value.length >= 2 ? { configName: String(value[0]), modelName: String(value[1]) } : { configName: String(model), modelName: String(model) };
}
function headers(account, secrets, settings, url) {
  const c = { ...DEFAULTS, ...settings }; const { deviceId, machineId } = ids(account);
  const token = String(secrets?.token || ""); const trace = crypto.randomBytes(16).toString("hex");
  return { "content-type": "application/json", accept: "text/event-stream", "user-agent": c.userAgent,
    authorization: `Cloud-IDE-JWT ${token}`, "x-ide-token": token, "x-cloudide-token": token,
    "x-app-id": c.appId, "x-app-version": "default", "x-app-version-code": c.ideVersionCode,
    "x-ide-version": c.ideVersion, "x-ide-version-code": c.ideVersionCode, "x-ide-version-type": "stable",
    "x-device-type": "windows", "x-device-brand": c.deviceBrand, "x-device-cpu": "Intel", "x-device-id": deviceId,
    "x-machine-id": machineId, "x-os-version": c.osVersion, "request-traffic-type": "prod", "package-type": "stable_cn",
    "x-lgw-req-sdk-type": "3", "x-lscbd-aid": "787976", "x-lscbd-platform": "windows", "x-ss-dp": "787976",
    "app-version": c.ideVersion, "x-custom-trace-id": trace, "x-request-id": `req_${crypto.randomUUID().replace(/-/g, "")}`,
    ...(account?.uid ? { "x-uid": String(account.uid) } : {}), referer: url };
}
function rewrite(model, input, account, settings, route) {
  const c = { ...DEFAULTS, ...settings };
  const target = route || mapModel(model, settings);
  const { deviceId, machineId } = ids(account);
  // 白名单信封 + 五处工具整形全在 payload.cjs 里（原样透传会把 OpenAI 通用字段
  // 一起塞给上游，Trae 对多带的字段是**拒绝**而不是忽略）。
  return payload.prepareBody(input, {
    ...target,
    function: target.function || settings.functionMap?.[model] || "solo_work_lite",
    maxWindow: Number(input.context_length) || 168000,
  }, {
    sessionId: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
    fields: {
      conversation_id: crypto.randomUUID(),
      user_id: String(account?.uid || ""),
      device_id: deviceId,
      machine_id: machineId,
      project_id: crypto.randomUUID(),
      workspace_id: "e04cdd",
      mode: "FunctionCall",
      ide_version: c.ideVersion,
      ide_version_code: c.ideVersionCode,
      app_id: c.appId,
      package_type: "stable_cn",
    },
  });
}
async function requestCatalog(url, body, account, token, settings, ctx) {
  const requestHeaders = headers(account, { token }, settings, url);
  requestHeaders.accept = "application/json";
  const response = await ctx.pool.network().fetch(url, { method: "POST", headers: requestHeaders, body: JSON.stringify(body), signal: ctx.signal, redirect: "error" });
  const raw = await response.text();
  if (Buffer.byteLength(raw, "utf8") > 4 * 1024 * 1024) throw new Error("Trae catalog response exceeds limit");
  if (!response.ok) throw Object.assign(new Error("Trae catalog request failed"), { status: response.status });
  try { return JSON.parse(raw); } catch { throw new Error("Trae catalog response is invalid JSON"); }
}
async function fetchCatalog(account, token, settings, ctx) {
  const config = { ...DEFAULTS, ...settings };
  const batchBody = { functions: catalog.FUNCTIONS, agent_type: "", current_config_info: { config_name: "", is_custom_model: false },
    mode_type: 0, access_type: 0, ab_force_vids: "", ab_autotest_advanced_mode: 0, show_custom_model: true };
  let groups = [];
  try {
    const payload = await requestCatalog(config.batchModelsUrl, batchBody, account, token, settings, ctx);
    const rows = payload?.function_configs || payload?.data?.function_configs;
    if (Array.isArray(rows)) groups = rows;
  } catch { /* Per-function requests below recover from older or partial batch endpoints. */ }
  const listed = new Set(groups.map(group => String(group?.function || "")));
  const missing = catalog.FUNCTIONS.filter(name => !listed.has(name));
  const replies = await Promise.all(missing.map(async name => {
    const url = config.modelsUrl;
    const body = { function: name, config_names: null, need_prompt: false, current_config_info: null,
      poly_prompt: true, mode_type: null, agent_type: null };
    try {
      const payload = await requestCatalog(url, body, account, token, settings, ctx);
      const rows = payload?.config_info_list || payload?.data?.config_info_list;
      return Array.isArray(rows) ? { function: name, config_info_list: rows } : null;
    } catch { return null; }
  }));
  groups.push(...replies.filter(Boolean));
  const models = catalog.normalize({ function_configs: groups });
  const key = crypto.createHash("sha256").update(`${account.uid || account.accountId || ""}:${token}`).digest("hex");
  catalogs.delete(key); catalogs.set(key, { models, expiresAt: Date.now() + 60 * 60 * 1000 });
  while (catalogs.size > 256) catalogs.delete(catalogs.keys().next().value);
  return models;
}
/**
 * 「输入过大」词表（大小写不敏感；中文原样匹配）。
 *
 * 这条判定的意义不是文案好看，而是**别冷却健康账号**：同一个超大 body 换任何
 * 账号都会被拒，把它算成账号错误会连着拖垮整条链（示例项目 trae/errors.rs 同款表）。
 */
const INPUT_TOO_LARGE_MARKERS = Object.freeze([
  "too long", "too many tokens", "context length", "maximum context", "context window",
  "request entity too large", "input too large", "输入过长", "内容过长", "上下文过长",
  "上下文长度", "超出模型上限",
]);

function tooLarge(message) {
  const lower = String(message || "").toLowerCase();
  return INPUT_TOO_LARGE_MARKERS.some((marker) => lower.includes(marker));
}

/**
 * Trae 的错误分类（HTTP 状态 + 流内业务码统一走这张表）。
 *
 * 码表来自实测 + 参考实现 v0.12.51：
 *   · 1005 / 4008  → 套餐或模型额度用尽（换账号，冷却）
 *   · 4001 / 4023  → 模型在当前 function 通道不可用（换通道 / 换号，不算账号坏）
 *   · 1001 / 401 / 20101 → 会话失效（重新登录）
 *   · 4011         → 软限流
 *   · 413 / 过大文案 → **请求级**，绝不冷却账号
 *
 * 顺序敏感：413 与「过大」判定必须在 plan 匹配之前 —— 否则一个恰好带
 * "1005…plan" 字样的超大请求会被判成 12 小时硬冷却。
 */
function classifyTrae(status, code, message, seen = false) {
  const text = String(message || "").slice(0, 1024);
  const replay = seen ? "unsafe" : "safe";
  if (status === 413 || tooLarge(text)) return forwardError({ code: "INPUT_TOO_LARGE", message: "请求内容超出 Trae 上游上限，请缩短上下文或附件", category: "upstream", scope: "invocation", replay, retryable: false, status: 413 });
  if ([1005, 4008].includes(code)) return forwardError({ code: "PLAN_LIMIT", message: "Trae 套餐或该模型额度已用尽", category: "quota", scope: "account", replay, retryable: true, status: 429 });
  if ([4001, 4023].includes(code)) return forwardError({ code: "MODEL_UNAVAILABLE", message: "该模型在当前 Trae 通道不可用", category: "upstream", scope: "account-model", replay, retryable: false, status: 404 });
  if ([1001, 401, 20101].includes(code) || status === 401) return forwardError({ code: "AUTH_REQUIRED", message: "Trae 登录态无效，请在号池检查凭据", category: "auth", scope: "account", replay, retryable: false, status: 401 });
  if (code === 4011 || status === 429) return forwardError({ code: "RATE_LIMITED", message: "Trae 上游请求受限", category: "rate", scope: "account", replay, retryable: true, status: 429 });
  if (status === 404) return forwardError({ code: "MODEL_NOT_FOUND", message: "Trae 上游没有该模型", category: "model", scope: "account-model", replay, retryable: false, status: 404 });
  if (status >= 500) return forwardError({ code: "UPSTREAM_FAILED", message: "Trae 上游服务异常", category: "upstream", scope: "invocation", replay, retryable: true, status: 502 });
  return forwardError({ code: "UPSTREAM_FAILED", message: text || "Trae 上游请求失败", category: "upstream", scope: "invocation", replay, retryable: false, status: status >= 400 && status <= 599 ? status : 502 });
}

/** 兼容旧调用点：只给 HTTP 状态 / 插件码的路径按同一张表分类 */
function error(status, code, message) {
  return classifyTrae(status, 0, `${code ? `[${code}] ` : ""}${message || ""}`);
}

/** 该错误是否值得换一条目录路由（同模型在别的 function 通道）再试一次 */
function worthAnotherRoute(cause) {
  return cause?.code === "MODEL_UNAVAILABLE" || cause?.code === "PLAN_LIMIT";
}

function createTrae(settings = {}) {
  return { id: "trae", channels: ["trae"], requiredFeatures: ["explicit-retry-policy@1", "attempt-reservation@1"],
    async listModels(request, ctx) {
      const context = request.grantId ? await ctx.pool.context() : {};
      if (request.force !== true) return (context.models || []).map(descriptor);
      const credentials = await ctx.pool.credentials(), token = String(credentials?.token || "").trim();
      if (!token) throw classifyTrae(401, 0, "no token");
      return (await fetchCatalog(context, token, settings, ctx)).map(descriptor);
    },
    async *invoke(request, ctx) {
      let secrets = await ctx.pool.ensureCredentials("preflight");
      if (!secrets?.token) throw classifyTrae(401, 0, "no token");
      const account = await ctx.pool.context();
      const c = { ...DEFAULTS, ...settings };
      const url = c.chatUrl;
      const cacheKey = crypto.createHash("sha256").update(`${account.uid || account.accountId || ""}:${secrets.token}`).digest("hex");
      let currentCatalog = catalogs.get(cacheKey);
      if (currentCatalog?.expiresAt <= Date.now()) { catalogs.delete(cacheKey); currentCatalog = null; }
      if (!currentCatalog) {
        try { currentCatalog = { models: await fetchCatalog(account, secrets.token, settings, ctx), expiresAt: Date.now() + 60 * 60 * 1000 }; }
        catch { currentCatalog = null; }
      }
      const modelEntry = catalog.findModel(currentCatalog?.models, request.model);
      // 候选路由：Max 变体只认它自己那条；普通模型按目录顺序把所有 function 通道都试一遍。
      // 上游的 4001/4023 是「这个模型在这条通道不可用」而不是「账号坏了」—— 只试第一条
      // 会把一次可救的调用报成失败（示例项目 trae/errors.rs 的 retry_route 同款口径）。
      const routes = modelEntry
        ? (modelEntry.maxOf ? [modelEntry.route] : (Array.isArray(modelEntry.routes) && modelEntry.routes.length ? modelEntry.routes : []))
        : [];
      const candidates = routes.length ? routes : [undefined];
      let lastError, refreshed = false;
      for (const route of candidates) {
        const body = JSON.stringify(rewrite(request.model, request.input || {}, account, settings, route));
        let response;
        try {
          response = await ctx.pool.network().fetch(url, { method: "POST", headers: headers(account, secrets, settings, url), body, signal: ctx.signal, redirect: "error" });
        } catch (cause) {
          if (ctx.signal?.aborted) throw classifyTrae(504, 0, "cancelled");
          lastError = classifyTrae(502, 0, String(cause?.message || "network"));
          break;
        }
        if (!response.ok) {
          const detail = await response.text().catch(() => "");
          let data = {}; try { data = JSON.parse(detail); } catch { /* 非 JSON 错误体 */ }
          const code = Number(data?.code ?? data?.error?.code ?? data?.data?.code) || 0;
          const failure = classifyTrae(response.status, code, String(data?.message || data?.msg || detail || ""));
          // 401：手里这份 accessToken 多半是「服务端已吊销」而不是「过期」，不重发就白丢一次调用。
          // ensureCredentials 的 upstream-auth-expired 分支有 1 次预算，且宿主侧 single-flight。
          if (response.status === 401 && !refreshed) {
            refreshed = true;
            const next = await ctx.pool.ensureCredentials("upstream-auth-expired").catch(() => null);
            if (next?.token && next.token !== secrets.token) { secrets = next; lastError = failure; continue; }
          }
          lastError = failure;
          if (worthAnotherRoute(failure)) continue;
          throw failure;
        }
        let seen = false, finish = "stop";
        try {
          for await (const raw of sse(response, ctx.signal)) {
            if (!raw || raw === "[DONE]") continue;
            let data; try { data = JSON.parse(raw); } catch { continue; }
            const event = data.event || data.type || "";
            const delta = {};
            if (event === "output" || event === "thought") {
              if (typeof data.response === "string") delta.content = data.response;
              if (typeof data.reasoning_content === "string") delta.reasoning_content = data.reasoning_content;
            }
            if (data.tool_calls) delta.tool_calls = data.tool_calls;
            if (hasContent(delta)) { seen = true; yield { type: "delta", delta }; }
            if (event === "token_usage") yield { type: "usage", mode: "snapshot", usage: { prompt_tokens: Number(data.prompt_tokens || 0), completion_tokens: Number(data.completion_tokens || 0), total_tokens: Number(data.total_tokens || 0) } };
            if (event === "done" || event === "turn_completion") finish = data.finish_reason || data.finishReason || "stop";
            if (event === "error") {
              // 首帧前的错误仍可换通道/换号；已经吐过内容就只能如实报错（replay=unsafe）
              throw classifyTrae(200, Number(data.code) || 0, String(data.message || data.msg || "Trae 上游返回错误"), seen);
            }
          }
        } finally { try { await response.body?.cancel(); } catch { /* 流可能已关闭 */ } }
        if (!seen) { lastError = classifyTrae(502, 0, "empty response"); if (worthAnotherRoute(lastError)) continue; throw lastError; }
        yield { type: "finish", reason: finish };
        return;
      }
      throw lastError || classifyTrae(502, 0, "Trae 没有可用通道");
    } };
}
module.exports = { createTrae, rewrite, mapModel, fetchCatalog, classifyTrae, INPUT_TOO_LARGE_MARKERS };
