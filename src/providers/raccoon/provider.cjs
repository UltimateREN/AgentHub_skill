"use strict";
const crypto = require("node:crypto");
const { descriptor } = require("../../model-descriptor.cjs");
const { sse, errorDetail } = require("../../network/sse.cjs");
const { forwardError, hasContent } = require("../../../sdk/provider-protocol.cjs");
const DEFAULTS = Object.freeze({ chatUrl: "https://xiaohuanxiong.com/api/web/llm/v2/chat/completions", clientName: "raccoon-ai", clientVersion: "1.0.35" });
function identity(context) { const seed = crypto.createHash("sha256").update(`agenthub:raccoon:${context?.uid || context?.accountId || "anon"}`).digest("hex"); const uuid = `${seed.slice(0, 8)}-${seed.slice(8, 12)}-4${seed.slice(13, 16)}-a${seed.slice(17, 20)}-${seed.slice(20, 32)}`; return { deviceId: context?.identity?.deviceId || uuid, osVersion: context?.identity?.osVersion || "10.0.26200", platform: context?.identity?.platform || "desktop-windows-x64", channel: context?.identity?.clientChannel || "stable", officeIdentity: context?.identity?.officeIdentity || "" }; }
function modelName(model, settings) { return /^raccoon-chat(-ml)?$/i.test(String(model || "")) ? String(settings.defaultModel || "raccoon-chat-ml-5-5") : String(model || ""); }
function rewriteBody(model, input, settings = {}) { const out = { ...(input || {}), model: modelName(model, settings), stream: true, stream_options: { ...(input?.stream_options || {}), include_usage: true } }; if (!out.max_tokens && !out.max_completion_tokens) out.max_tokens = 80000; if (out.max_completion_tokens != null && out.max_tokens == null) out.max_tokens = Number(out.max_completion_tokens) || 80000; delete out.max_completion_tokens; delete out.conversation_id; delete out.conversationId; delete out.prompt_cache_key; if (/glm[-._]?5[-._]?3/i.test(out.model)) { const effort = String(out.reasoning_effort || "").toLowerCase(); if (["off", "none", "minimal", "disabled", "false", "0"].includes(effort)) out.reasoning_effort = "low"; else if (effort && !["low", "high", "max"].includes(effort)) out.reasoning_effort = "high"; delete out.thinking; delete out.enable_thinking; } return out; }
function headers(context, secrets, settings, sessionId, turnId, title) { const cfg = { ...DEFAULTS, ...settings }; const idn = identity(context); const latin = Array.from(String(title || "")).map(ch => /[\x20-\x7e]/.test(ch) ? ch : encodeURIComponent(ch)).join(""); const h = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${secrets.token}`, "x-client-name": cfg.clientName, "x-client-platform": idn.platform, "x-client-version": cfg.clientVersion, "x-client-os-version": idn.osVersion, "x-client-channel": idn.channel, "x-client-device-id": idn.deviceId, "X-RACCOON-Session-ID": sessionId, "X-RACCOON-Turn-ID": turnId, "X-RACCOON-Title": latin, "X-RACCOON-Call-Kind": "chat" }; if (idn.officeIdentity && idn.officeIdentity !== "personal") h["X-Org-Code"] = idn.officeIdentity; return h; }
function failure(status, message, seen = false) { const auth = status === 401 || status === 403; const quota = status === 402; const rate = status === 429; return forwardError({ code: auth ? "AUTH_REQUIRED" : quota ? "QUOTA_EXHAUSTED" : rate ? "RATE_LIMITED" : "UPSTREAM_FAILED", message: auth ? "小浣熊登录态无效，请在号池检查凭据" : quota ? "小浣熊积分不足" : rate ? "小浣熊上游请求受限" : message || "小浣熊模型执行失败", category: auth ? "auth" : quota ? "quota" : rate ? "rate" : "upstream", scope: auth || quota || rate ? "account" : "invocation", replay: seen ? "unsafe" : "unknown", retryable: !seen && (rate || status >= 500), status: status >= 400 && status <= 599 ? status : 502 }); }
function parseCatalog(payload) {
  const root = payload?.data && typeof payload.data === "object" ? payload.data : payload;
  const categories = Array.isArray(root?.categories) ? root.categories : [];
  const seen = new Set(), models = [];
  for (const category of categories) {
    if (category?.type && category.type !== "chat") continue;
    for (const item of Array.isArray(category?.models) ? category.models : []) {
      const id = String(item?.name || item?.model_name || "").trim();
      if (!id || id.length > 160 || /[\x00-\x1f\x7f]/.test(id) || seen.has(id)) continue;
      seen.add(id);
      const display = String(item.display_name || (String(item.description || "").length <= 64 ? item.description : "") || id).trim();
      const params = item.params && typeof item.params === "object" ? item.params : {};
      const integer = (...values) => { const value = values.map(Number).find(Number.isSafeInteger); return value === undefined || value < 0 ? 0 : value; };
      const tags = Array.isArray(item.tags) ? item.tags.map(value => String(value).toLowerCase()) : [];
      const capabilities = { tools: true };
      const images = item.supports_images ?? item.supportImage;
      if (typeof images === "boolean") capabilities.images = images;
      else if (tags.some(tag => ["vision", "image", "image-understanding"].includes(tag))) capabilities.images = true;
      const reasoning = item.supports_reasoning ?? item.supportThinking;
      if (typeof reasoning === "boolean") capabilities.reasoning = reasoning;
      const row = { id, name: display, capabilities,
        contextLength: integer(item.context_window, item.contextWindow, params.context_window, params.contextWindow),
        maxOutputTokens: integer(item.max_tokens, item.maxTokens, params.max_tokens, params.maxTokens) };
      const rate = Number(item.billing_effective_multiplier ?? item.billing_multiplier);
      if (Number.isFinite(rate) && rate >= 0) row.rate = rate;
      models.push(row);
    }
  }
  return models;
}
function catalogError(status, code, message) {
  return forwardError({ code, message, category: status === 401 || status === 403 ? "auth" : "upstream",
    scope: status === 401 || status === 403 ? "account" : "service", replay: "safe", retryable: status >= 500,
    status: status >= 400 && status <= 599 ? status : 502 });
}
function createRaccoon(settings = {}) { return { id: "raccoon", channels: ["raccoon"], async listModels(request, ctx) {
  const context = request.grantId ? await ctx.pool.context() : {};
  if (request.force !== true) return (context.models || []).map(descriptor);
  const secrets = await ctx.pool.credentials(), token = String(secrets?.token || "").trim();
  if (!token) throw catalogError(401, "AUTH_REQUIRED", "小浣熊登录态无效，请在号池检查凭据");
  const base = String(settings.catalogBase || settings.llmBase || "https://xiaohuanxiong.com/api/web/llm/v2").replace(/\/+$/, "");
  let response;
  try { response = await ctx.pool.network().fetch(`${base}/model_catalog`, { method: "GET", redirect: "error", signal: ctx.signal,
    headers: { Accept: "application/json", authorization: `Bearer ${token}`, ...(context.identity?.officeIdentity && context.identity.officeIdentity !== "personal" ? { "X-Org-Code": String(context.identity.officeIdentity) } : {}) } }); }
  catch { throw catalogError(502, "CATALOG_REFRESH_FAILED", "小浣熊上游模型目录请求失败"); }
  if (!response.ok) throw catalogError(response.status, response.status === 401 || response.status === 403 ? "AUTH_REQUIRED" : "CATALOG_REFRESH_FAILED", `小浣熊上游模型目录请求失败（HTTP ${response.status}）`);
  let text, payload;
  try { text = await response.text(); if (Buffer.byteLength(text, "utf8") > 4 * 1024 * 1024) throw new Error("limit"); payload = JSON.parse(text); }
  catch { throw catalogError(502, "CATALOG_INVALID", "小浣熊上游模型目录格式无法解析"); }
  const models = parseCatalog(payload);
  if (!models.length) throw catalogError(502, "EMPTY_CATALOG", "小浣熊上游未返回 chat 模型目录");
  return models.map(descriptor);
}, async *invoke(request, ctx) { const secrets = await ctx.pool.credentials(); if (!String(secrets?.token || "").trim()) throw failure(401); const context = await ctx.pool.context(); const messages = Array.isArray(request.input?.messages) ? request.input.messages : []; const seed = crypto.createHash("sha256").update(`raccoon:${context.uid || context.accountId}:${request.input?.conversation_id || JSON.stringify(messages)}`).digest("hex"); const sessionId = `${seed.slice(0, 8)}-${seed.slice(8, 12)}-4${seed.slice(13, 16)}-a${seed.slice(17, 20)}-${seed.slice(20, 32)}`; const response = await ctx.pool.network().fetch(String(settings.chatUrl || DEFAULTS.chatUrl), { method: "POST", redirect: "error", signal: ctx.signal, headers: headers(context, secrets, settings, sessionId, crypto.randomUUID(), messages.find(item => item?.role === "user" && typeof item.content === "string")?.content?.replace(/\s+/g, " ").trim().slice(0, 20)), body: JSON.stringify(rewriteBody(request.model, request.input, settings)) }); if (!response.ok) throw failure(response.status, await errorDetail(response)); let seen = false, finish = "stop"; try { for await (const raw of sse(response, ctx.signal)) { if (!raw || raw === "[DONE]") continue; let frame; try { frame = JSON.parse(raw); } catch { continue; } if (frame.error || frame.code && frame.code !== 200) throw failure(Number(frame.error?.code || frame.code) === 401 ? 401 : Number(frame.error?.code || frame.code) === 429 ? 429 : 502, frame.error?.message || frame.message, seen); const choice = frame.choices?.[0]; const delta = choice?.delta || choice?.message; if (delta && hasContent(delta)) { seen = true; yield { type: "delta", delta }; } if (choice?.finish_reason) finish = String(choice.finish_reason); if (frame.usage) yield { type: "usage", mode: "snapshot", usage: { ...frame.usage, prompt_tokens: Number(frame.usage.prompt_tokens || frame.usage.input_tokens || 0), completion_tokens: Number(frame.usage.completion_tokens || frame.usage.output_tokens || 0), total_tokens: Number(frame.usage.total_tokens || 0) } }; } } finally { try { await response.body?.cancel(); } catch {} } if (!seen) throw failure(502, "小浣熊上游返回空响应"); yield { type: "finish", reason: finish }; } }; }
module.exports = { createRaccoon, rewriteBody, parseCatalog };
