"use strict";
const crypto = require("node:crypto");
const { descriptor, privateValue } = require("../../model-descriptor.cjs");
const { sse } = require("../../network/sse.cjs");
const { forwardError, hasContent } = require("../../../sdk/provider-protocol.cjs");

const DEFAULTS = Object.freeze({
  workbuddy: { chatUrl: "https://codebuddy.cn/api/v2/chat/completions", consoleChatUrl: "https://codebuddy.cn/api/console/chat/completions", origin: "https://www.codebuddy.cn", userAgent: "WorkBuddy/5.6.2", ideName: "WorkBuddy" },
  workbuddy_ai: { chatUrl: "https://www.workbuddy.ai/api/v2/chat/completions", consoleChatUrl: "https://www.workbuddy.ai/api/console/chat/completions", origin: "https://www.workbuddy.ai", userAgent: "WorkBuddy AI/5.6.2", ideName: "WorkBuddy AI" },
});
function stable(value, purpose) { return crypto.createHash("sha256").update(`agenthub:${purpose}:${value || "anon"}`).digest("hex").slice(0, 36); }
function errorFor(status, code, message, scope = "invocation") {
  return forwardError({ code, message, category: status === 401 ? "auth" : status === 429 ? "rate" : "upstream", scope, replay: status === 401 || status === 429 || status >= 500 ? "safe" : "unknown", retryable: status === 401 || status === 429 || status >= 500, status });
}
function cleanText(value, settings) {
  let result = String(value);
  const map = settings.templateMap && typeof settings.templateMap === "object" ? settings.templateMap : {};
  for (const [from, to] of Object.entries(map)) if (from) result = result.split(from).join(String(to));
  return result.replace(/x-anthropic-billing-header:[^;\n]*;?\s*/gi, "").replace(/\bcc_[a-z0-9_]+=[^;\n]*;?\s*/gi, "").replace(/x-anthropic-billing-header/gi, "x-anthropic-billing-hdr");
}
function rewrite(model, input, account, settings, channel) {
  const out = { ...(input || {}), model: String(model), stream: true, stream_options: { ...((input || {}).stream_options || {}), include_usage: true } };
  if (out.max_completion_tokens != null && out.max_tokens == null) out.max_tokens = out.max_completion_tokens;
  delete out.max_completion_tokens;
  if (out.tool_choice === "none") { delete out.tools; delete out.functions; delete out.tool_choice; }
  else if (out.tool_choice && typeof out.tool_choice === "object") out.tool_choice = out.tool_choice.function?.name || (out.tool_choice.type === "any" || out.tool_choice.type === "required" ? "required" : "auto");
  const messages = Array.isArray(out.messages) ? out.messages : [];
  const valid = new Set(messages.filter(m => m?.role === "assistant" && Array.isArray(m.tool_calls)).flatMap(m => m.tool_calls.filter(x => x?.id).map(x => String(x.id))));
  out.messages = messages.map(message => {
    const item = { ...message };
    if (String(item.role).toLowerCase() === "developer") item.role = "system";
    if (item.role === "tool" && !valid.has(String(item.tool_call_id || ""))) return null;
    if (typeof item.content === "string") item.content = cleanText(item.content, settings);
    if (Array.isArray(item.tool_calls)) item.tool_calls = item.tool_calls.filter(x => x?.id && valid.has(String(x.id)));
    return item;
  }).filter(Boolean);
  if (channel === "workbuddy_ai" && out.messages.length && out.messages[0].role !== "system") out.messages.unshift({ role: "system", content: "You are a helpful assistant." });
  out.conversation_id ||= crypto.createHash("sha256").update(JSON.stringify(out.messages.slice(-3))).digest("hex").slice(0, 32);
  out.prompt_cache_key ||= `${account?.uid || account?.accountId || "anon"}:${out.conversation_id}`;
  return out;
}
function headers(channel, account, secrets, settings, url) {
  const base = { ...DEFAULTS[channel], ...(settings || {}) };
  const uid = String(account?.uid || account?.accountId || "");
  const origin = base.origin;
  return { "content-type": "application/json", accept: "application/json, text/event-stream", "accept-language": channel === "workbuddy_ai" ? "en-US" : "zh-CN", "user-agent": base.userAgent, origin, referer: origin + "/", "x-requested-with": "XMLHttpRequest", "x-codebuddy-request": "1", authorization: `Bearer ${secrets.token}`, "x-agent-purpose": "conversation", "x-ide-name": base.ideName, "x-ide-type": base.ideName, "x-ide-version": base.clientVersion || "5.6.2", "x-product": base.ideName, ...(uid ? { "x-user-id": uid, "x-machine-id": stable(uid, "machine"), "x-session-id": stable(uid, "session") } : { "x-no-user-id": "1" }), ...(channel === "workbuddy_ai" ? { "x-no-enterprise-id": "1", "x-domain": "www.workbuddy.ai" } : { "x-no-enterprise-id": "1", "x-no-department-info": "1" }), referer: url };
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
    workbuddy: { modelsUrl: "https://copilot.tencent.com/console/enterprises/personal/models", modelsV3Url: "https://copilot.tencent.com/v3/config" },
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
      const headersFor = url => headers(channel, account, secrets, base, url);
      const fetcher = ctx.pool.network().fetch;
      const results = await Promise.all([base.modelsUrl, base.modelsV3Url].filter(Boolean).map(async (url, index) => {
        const response = await getJson(fetcher, url, { method: "GET", headers: headersFor(url), signal: ctx.signal });
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
      const body = rewrite(upstreamModel, request.input, account, settings, channel); const base = { ...DEFAULTS[channel], ...settings };
      let response; let last;
      for (const url of [base.chatUrl, base.consoleChatUrl].filter(Boolean)) {
        response = await ctx.pool.network().fetch(url, { method: "POST", redirect: "error", signal: ctx.signal, headers: headers(channel, account, secrets, settings, url), body: JSON.stringify(body) });
        if (response.status !== 404 && response.status !== 405) break; last = response;
      }
      if (!response || response.status === 404 || response.status === 405) throw errorFor(response?.status || 502, "UPSTREAM_FAILED", `WorkBuddy 上游请求失败 HTTP ${response?.status || 0}`);
      if (!response.ok) throw errorFor(response.status, response.status === 401 ? "AUTH_REQUIRED" : response.status === 429 ? "RATE_LIMITED" : "UPSTREAM_FAILED", "WorkBuddy 上游请求失败", response.status === 401 ? "account" : response.status === 429 ? "account-model" : "invocation");
      yield* invokeStream(response, ctx.signal);
    } };
}
module.exports = { createWorkBuddy, rewrite };
