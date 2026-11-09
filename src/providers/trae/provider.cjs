"use strict";
const crypto = require("node:crypto");
const { descriptor } = require("../../model-descriptor.cjs");
const { sse } = require("../../network/sse.cjs");
const { forwardError, hasContent } = require("../../../sdk/provider-protocol.cjs");
const catalog = require("./catalog.cjs");
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
  const c = { ...DEFAULTS, ...settings }; const target = route || mapModel(model, settings); const { deviceId, machineId } = ids(account);
  const body = { ...input, messages: (input.messages || []).map(message => {
    const item = { ...message }; if (typeof item.content === "string") item.content = [{ type: "text", text: item.content }];
    if (item.role === "assistant" && Array.isArray(item.tool_calls)) item.tool_calls = item.tool_calls.filter(x => x?.function?.name).map(x => ({ id: x.id, type: "function", function_call: { name: x.function.name, arguments: typeof x.function.arguments === "string" ? x.function.arguments : JSON.stringify(x.function.arguments || {}) } }));
    return item;
  }), config_name: target.configName, model: target.configName, stream: true, function: target.function || settings.functionMap?.[model] || "solo_work_lite",
    ...(target.modelName ? { model_name: target.modelName } : {}),
    max_tokens: Math.min(Number(input.max_tokens || input.max_completion_tokens) > 0 ? Number(input.max_tokens || input.max_completion_tokens) : 4096,
      Number(target.maxTokens) > 0 ? Number(target.maxTokens) : Number.MAX_SAFE_INTEGER),
    conversation_id: crypto.randomUUID(), user_id: String(account?.uid || ""), session_id: crypto.randomUUID(), device_id: deviceId,
    machine_id: machineId, project_id: crypto.randomUUID(), workspace_id: "e04cdd", prompt_max_tokens: Number(input.context_length) || 168000,
    mode: "FunctionCall", ide_version: c.ideVersion, ide_version_code: c.ideVersionCode, app_id: c.appId, package_type: "stable_cn" };
  if (body.tool_choice === "none") { delete body.tool_choice; delete body.tools; delete body.functions; }
  return body;
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
function error(status, code, message, scope = "invocation") {
  return forwardError({ code, message, category: status === 401 ? "auth" : status === 429 ? "rate" : "upstream", scope,
    replay: "safe", retryable: status >= 500 || status === 429, status });
}
function createTrae(settings = {}) {
  return { id: "trae", channels: ["trae"], requiredFeatures: ["explicit-retry-policy@1", "attempt-reservation@1"],
    async listModels(request, ctx) {
      const context = request.grantId ? await ctx.pool.context() : {};
      if (request.force !== true) return (context.models || []).map(descriptor);
      const credentials = await ctx.pool.credentials(), token = String(credentials?.token || "").trim();
      if (!token) throw error(401, "AUTH_REQUIRED", "Trae 登录态无效，请在号池检查凭据", "account");
      return (await fetchCatalog(context, token, settings, ctx)).map(descriptor);
    },
    async *invoke(request, ctx) {
      const secrets = await ctx.pool.ensureCredentials("preflight"); if (!secrets?.token) throw error(401, "AUTH_REQUIRED", "Trae 登录态无效，请在号池检查凭据", "account");
      const account = await ctx.pool.context(); const c = { ...DEFAULTS, ...settings }; const url = c.chatUrl;
      const cacheKey = crypto.createHash("sha256").update(`${account.uid || account.accountId || ""}:${secrets.token}`).digest("hex");
      let currentCatalog = catalogs.get(cacheKey);
      if (currentCatalog?.expiresAt <= Date.now()) { catalogs.delete(cacheKey); currentCatalog = null; }
      if (!currentCatalog) {
        try { currentCatalog = { models: await fetchCatalog(account, secrets.token, settings, ctx), expiresAt: Date.now() + 60 * 60 * 1000 }; }
        catch { currentCatalog = null; }
      }
      const modelEntry = catalog.findModel(currentCatalog?.models, request.model);
      const configured = modelEntry?.routes?.[0];
      const route = modelEntry ? (modelEntry.maxOf ? modelEntry.route : configured) : undefined;
      const payload = JSON.stringify(rewrite(request.model, request.input || {}, account, settings, route));
      const response = await ctx.pool.network().fetch(url, { method: "POST", headers: headers(account, secrets, settings, url), body: payload, signal: ctx.signal, redirect: "error" });
      if (!response.ok) throw error(response.status, response.status === 401 ? "AUTH_REQUIRED" : response.status === 429 ? "RATE_LIMITED" : "UPSTREAM_FAILED", "Trae 上游请求失败", response.status === 401 ? "account" : "invocation");
      let seen = false, finish = "stop";
      try { for await (const raw of sse(response, ctx.signal)) {
        if (!raw || raw === "[DONE]") continue; let data; try { data = JSON.parse(raw); } catch { continue; }
        const event = data.event || data.type || ""; const delta = {};
        if (event === "output" || event === "thought") { if (typeof data.response === "string") delta.content = data.response; if (typeof data.reasoning_content === "string") delta.reasoning_content = data.reasoning_content; }
        if (data.tool_calls) delta.tool_calls = data.tool_calls;
        if (hasContent(delta)) { seen = true; yield { type: "delta", delta }; }
        if (event === "token_usage") yield { type: "usage", mode: "snapshot", usage: { prompt_tokens: Number(data.prompt_tokens || 0), completion_tokens: Number(data.completion_tokens || 0), total_tokens: Number(data.total_tokens || 0) } };
        if (event === "done" || event === "turn_completion") finish = data.finish_reason || data.finishReason || "stop";
        if (event === "error") { const code = Number(data.code); throw error(code === 4008 ? 429 : code === 4001 ? 404 : 502, code === 4008 ? "RATE_LIMITED" : code === 4001 ? "MODEL_NOT_FOUND" : "UPSTREAM_FAILED", String(data.message || "Trae 上游返回错误"), code === 4008 ? "account" : "invocation"); }
      } } finally { try { await response.body?.cancel(); } catch {} }
      if (!seen) throw error(502, "EMPTY_UPSTREAM", "Trae 上游返回空响应"); yield { type: "finish", reason: finish };
    } };
}
module.exports = { createTrae, rewrite, mapModel, fetchCatalog };
