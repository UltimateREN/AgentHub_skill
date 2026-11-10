"use strict";
const crypto = require("node:crypto");
const { descriptor, privateValue } = require("../../model-descriptor.cjs");
const { sse } = require("../../network/sse.cjs");
const { forwardError, hasContent } = require("../../../sdk/provider-protocol.cjs");

// 事实来源：本机官方桌面端 CN 5.9.3 / AI 5.9.4 的 main/server.js
// buildVlmGatewayHeaders + applyGatewayHeaders + /v3/config，以及示例项目 Agent2Providers。
// 端点/客户端版本随桌面端升级而变，settings 可按渠道覆盖，不要在这里抄第二份假值。
const DEFAULTS = Object.freeze({
  workbuddy: {
    chatUrl: "https://www.workbuddy.cn/v2/chat/completions",
    consoleChatUrl: "https://copilot.tencent.com/v2/chat/completions",
    userAgent: "WorkBuddy/5.9.3 WorkBuddy/5.9.3 CLI/2.165.0",
    ideName: "WorkBuddy",
    clientVersion: "5.9.3",
    deploymentType: "SaaS",
  },
  workbuddy_ai: {
    chatUrl: "https://www.workbuddy.ai/v2/chat/completions",
    consoleChatUrl: "https://www.workbuddy.ai/console/chat/completions",
    userAgent: "WorkBuddy/5.9.4 WorkBuddy/5.9.4 CLI/2.165.0",
    ideName: "WorkBuddy",
    clientVersion: "5.9.4",
    deploymentType: "SaaS",
  },
});
function errorFor(status, code, message, scope = "invocation") {
  return forwardError({ code, message, category: status === 401 ? "auth" : status === 429 ? "rate" : "upstream", scope, replay: status === 401 || status === 429 || status >= 500 ? "safe" : "unknown", retryable: status === 401 || status === 429 || status >= 500, status });
}
function cleanText(value, settings) {
  let result = String(value);
  const map = settings.templateMap && typeof settings.templateMap === "object" ? settings.templateMap : {};
  for (const [from, to] of Object.entries(map)) if (from) result = result.split(from).join(String(to));
  return result.replace(/x-anthropic-billing-header:[^;\n]*;?\s*/gi, "").replace(/\bcc_[a-z0-9_]+=[^;\n]*;?\s*/gi, "").replace(/x-anthropic-billing-header/gi, "x-anthropic-billing-hdr");
}
function rewrite(model, input, account, settings) {
  const out = { ...(input || {}), model: String(model), stream: true };
  if (!out.stream_options || typeof out.stream_options !== "object" || Array.isArray(out.stream_options)) out.stream_options = { include_usage: true };
  if (out.max_tokens == null && Number.isInteger(out.max_completion_tokens) && out.max_completion_tokens > 0) out.max_tokens = out.max_completion_tokens;
  delete out.max_completion_tokens;
  const choice = out.tool_choice;
  const choiceType = choice && typeof choice === "object" && !Array.isArray(choice) ? String(choice.type || "").toLowerCase() : "";
  if (choice === "none" || choiceType === "none") { delete out.tools; delete out.functions; delete out.tool_choice; }
  else if (typeof choice === "string") { /* 上游只认字符串；原样保留 */ }
  else if (choiceType === "auto" || choiceType === "required") out.tool_choice = choiceType;
  else if (choiceType === "function") out.tool_choice = String(choice.function?.name || choice.name || "auto");
  else if (choice !== undefined) delete out.tool_choice;
  const messages = Array.isArray(out.messages) ? out.messages : [];
  const valid = new Set(messages.filter(m => m?.role === "assistant" && Array.isArray(m.tool_calls)).flatMap(m => m.tool_calls.filter(x => x?.id).map(x => String(x.id))));
  out.messages = messages.map(message => {
    const item = { ...message };
    if (String(item.role).toLowerCase() === "developer") item.role = "system";
    if (item.role === "tool" && !valid.has(String(item.tool_call_id || ""))) return null;
    if (typeof item.content === "string") item.content = cleanText(item.content, settings);
    else if (Array.isArray(item.content)) item.content = item.content.map(part => part && part.type === "image_url"
      && typeof part.image_url === "string" && part.image_url ? { ...part, image_url: { url: part.image_url } } : part);
    if (Array.isArray(item.tool_calls)) item.tool_calls = item.tool_calls.filter(x => x?.id && valid.has(String(x.id)));
    return item;
  }).filter(Boolean);
  const first = out.messages[0];
  if (out.messages.length && !(first && String(first.role).toLowerCase() === "system")) {
    out.messages.unshift({ role: "system", content: "你是一个得力助手" });
  }
  out.conversation_id ||= crypto.randomUUID();
  if (!out.prompt_cache_key) {
    const uid = String(account?.uid || account?.accountId || "");
    const hash = crypto.createHash("sha256").update(`${uid}|${out.conversation_id}`).digest("hex").slice(0, 32);
    out.prompt_cache_key = `wb2a-${(uid.slice(0, 8) || "-")}-${hash}`;
  }
  return out;
}
function headers(channel, account, secrets, settings, { conversation = true } = {}) {
  const base = { ...DEFAULTS[channel], ...(settings || {}) };
  const uid = String(account?.uid || account?.accountId || "");
  const traceId = crypto.randomBytes(16).toString("hex");
  const spanId = crypto.randomBytes(8).toString("hex");
  const parentSpanId = crypto.randomBytes(8).toString("hex");
  const result = {
    "content-type": "application/json",
    accept: "application/json",
    "user-agent": base.userAgent,
    "x-requested-with": "XMLHttpRequest",
    "x-codebuddy-request": "1",
    authorization: `Bearer ${secrets.token}`,
    "x-agent-intent": "craft",
    "x-agent-type": "main",
    ...(channel === "workbuddy" ? { "x-agent-runtime": "local-agent" } : {}),
    "x-agent-purpose": "conversation",
    "x-ide-name": base.ideName,
    "x-ide-type": base.ideName,
    "x-ide-version": base.clientVersion,
    "x-private-data": "true",
    "x-product": base.deploymentType || "SaaS",
    "x-trace-id": traceId,
    traceparent: `00-${traceId}-${spanId}-01`,
    b3: `${traceId}-${spanId}-1-${parentSpanId}`,
    "x-b3-traceid": traceId,
    "x-b3-spanid": spanId,
    "x-b3-parentspanid": parentSpanId,
    "x-b3-sampled": "1",
  };
  if (conversation) {
    result["x-conversation-id"] = crypto.randomUUID();
    result["x-conversation-request-id"] = crypto.randomUUID();
    result["x-conversation-message-id"] = crypto.randomUUID();
  }
  result["x-request-id"] = crypto.randomUUID();
  if (uid) result["x-user-id"] = uid;
  if (account?.enterpriseId) {
    result["x-enterprise-id"] = String(account.enterpriseId);
    result["x-tenant-id"] = String(account.enterpriseId);
  }
  if (account?.domain) result["x-domain"] = String(account.domain);
  return result;
}
async function* invokeStream(response, signal) {
  let seen = false, finish = "stop";
  for await (const raw of sse(response, signal)) {
    if (!raw || raw === "[DONE]") continue;
    let data; try { data = JSON.parse(raw); } catch { continue; }
    if (data.error) throw errorFor(Number(data.error.code) === 402 ? 402 : Number(data.error.code) === 4008 || Number(data.error.code) === 6004 ? 429 : 502, Number(data.error.code) || "UPSTREAM_FAILED", String(data.error.message || "WorkBuddy 上游请求失败"), Number(data.error.code) === 402 || Number(data.error.code) === 4008 ? "account-model" : "invocation");
    const choice = data.choices?.[0];
    if (choice?.delta && Object.keys(choice.delta).length && hasContent(choice.delta)) { seen = true; yield { type: "delta", delta: choice.delta }; }
    if (data.usage) yield { type: "usage", mode: "snapshot", usage: data.usage };
    if (choice?.finish_reason) finish = choice.finish_reason;
  }
  if (!seen) throw errorFor(502, "EMPTY_UPSTREAM", "WorkBuddy 上游返回空响应");
  yield { type: "finish", reason: finish };
}
function createWorkBuddy(settings = {}) {
  const catalogDefaults = {
    workbuddy: { modelsUrl: "https://www.workbuddy.cn/console/enterprises/personal/models", modelsV3Url: "https://www.workbuddy.cn/v3/config" },
    workbuddy_ai: { modelsUrl: "https://www.workbuddy.ai/console/enterprises/personal/models", modelsV3Url: "https://www.workbuddy.ai/v3/config" },
  };
  async function getJson(fetcher, url, options) {
    const response = await fetcher(url, { ...options, redirect: "error" });
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > 4 * 1024 * 1024) throw new Error("WorkBuddy catalog response exceeds limit");
    let data; try { data = JSON.parse(text); } catch { throw new Error("WorkBuddy catalog response is invalid JSON"); }
    return { ok: response.ok, status: response.status, data };
  }
  function mapCatalogModel(item) {
    if (!item || typeof item !== "object") return null;
    const id = item.id || item.model || item.name;
    if (typeof id !== "string" || !id || /^(nes-|completion-|codewise-)/i.test(id)) return null;
    const maxOutputTokens = Number(item.maxOutputTokens ?? item.max_output_tokens) || 0;
    if (maxOutputTokens > 0 && maxOutputTokens <= 256) return null;
    const tags = Array.isArray(item.tags) ? item.tags.map(String) : [];
    if (tags.some(tag => /text-to-image|image-gen|embedding/i.test(tag))) return null;
    const caps = { tools: !!(item.supportsToolCall ?? item.supports_tool_call), reasoning: !!(item.supportsReasoning ?? item.supports_reasoning) };
    const images = item.supportsImages ?? item.supports_images;
    if (typeof images === "boolean") caps.images = images;
    return { id, name: String(item.name || item.display_name || id), rate: Number.isFinite(Number(item.credits)) ? Number(item.credits) : null,
      capabilities: caps, contextLength: Number(item.maxInputTokens ?? item.max_input_tokens ?? item.context_length) || 0,
      maxOutputTokens, routing: { upstreamModel: String(item.model || item.id || id) } };
  }
  return { id: "workbuddy", channels: ["workbuddy", "workbuddy_ai"], requiredFeatures: ["explicit-retry-policy@1", "attempt-reservation@1"],
    async listModels(request, ctx) {
      const context = request.grantId ? await ctx.pool.context() : {};
      if (!request.force) return (context.models || []).map(descriptor);
      const channel = request.channel;
      const defaults = catalogDefaults[channel];
      if (!defaults) throw new Error("Unsupported WorkBuddy catalog channel");
      const base = { ...defaults, ...(settings.channels?.[channel] || settings) };
      const secrets = await ctx.pool.credentials();
      if (!secrets?.token) throw new Error("WorkBuddy catalog requires an account token");
      const account = context;
      const headersFor = () => headers(channel, account, secrets, base, { conversation: false });
      const fetcher = ctx.pool.network().fetch;
      const results = await Promise.all([base.modelsUrl, base.modelsV3Url].filter(Boolean).map(async (url, index) => {
        const response = await getJson(fetcher, url, { method: "GET", headers: headersFor(), signal: ctx.signal });
        if (!response.ok) return { authoritative: index === 1, models: [] };
        const rows = response.data?.data?.models || response.data?.models || response.data?.data || [];
        return { authoritative: index === 1, models: Array.isArray(rows) ? rows.map(mapCatalogModel).filter(Boolean) : [] };
      }));
      const merged = new Map();
      for (const result of results) for (const model of result.models) {
        const key = model.id.toLowerCase();
        if (!merged.has(key) || result.authoritative) merged.set(key, model);
      }
      if (!merged.size) throw new Error("WorkBuddy model catalog is empty or unavailable");
      return [...merged.values()].map(descriptor);
    },
    async *invoke(request, ctx) {
      const secrets = await ctx.pool.ensureCredentials("preflight");
      if (!secrets?.token) throw errorFor(401, "AUTH_REQUIRED", "WorkBuddy 登录态已失效，请在号池检查凭据", "account");
      const channel = request.channel; if (!DEFAULTS[channel]) throw errorFor(400, "INVALID_CHANNEL", "WorkBuddy 渠道无效");
      const account = await ctx.pool.context();
      // 对外 id 与上游发送名可能不同，目录把真实发送名放在 routing 里。
      const key = String(request.model || "").toLowerCase();
      const entry = (Array.isArray(account.models) ? account.models : []).find(item => String(item?.id || "").toLowerCase() === key);
      const upstreamModel = String(privateValue(entry, "upstreamModel") || request.model);
      const body = rewrite(upstreamModel, request.input, account, settings); const base = { ...DEFAULTS[channel], ...settings };
      const requestHeaders = headers(channel, account, secrets, settings);
      let response; let last;
      for (const url of [base.chatUrl, base.consoleChatUrl].filter(Boolean)) {
        response = await ctx.pool.network().fetch(url, { method: "POST", redirect: "error", signal: ctx.signal, headers: requestHeaders, body: JSON.stringify(body) });
        if (response.status !== 404 && response.status !== 405) break; last = response;
      }
      if (!response || response.status === 404 || response.status === 405) throw errorFor(response?.status || 502, "UPSTREAM_FAILED", `WorkBuddy 上游请求失败 HTTP ${response?.status || 0}`);
      if (!response.ok) throw errorFor(response.status, response.status === 401 ? "AUTH_REQUIRED" : response.status === 429 ? "RATE_LIMITED" : "UPSTREAM_FAILED", "WorkBuddy 上游请求失败", response.status === 401 ? "account" : response.status === 429 ? "account-model" : "invocation");
      yield* invokeStream(response, ctx.signal);
    } };
}
module.exports = { createWorkBuddy, rewrite };
