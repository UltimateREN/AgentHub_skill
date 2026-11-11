"use strict";
const crypto = require("node:crypto");
const { descriptor, privateValue } = require("../../model-descriptor.cjs");
const { sse, errorDetail } = require("../../network/sse.cjs");
const { parseRateResetMs } = require("../../execution/upstream-errors.cjs");
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
    acceptLanguage: "zh-CN",
  },
  workbuddy_ai: {
    chatUrl: "https://www.workbuddy.ai/v2/chat/completions",
    consoleChatUrl: "https://www.workbuddy.ai/console/chat/completions",
    // 平台段（第二段）必须写国际版产品名 `WorkBuddy AI`：官方客户端按地区切品牌，
    // 国际号送 CN 的 `WorkBuddy` 会被上游判成网关，回 403 code 11140 request illegal。
    // 依据：号池 rules.cjs「平台段必须 WorkBuddy AI，送错触发 403 code 11140」；
    //      示例项目 workbuddy2api headers.go defaultWorkBuddyUAFor 同款 realm 切换。
    userAgent: "WorkBuddy/5.9.4 WorkBuddy AI/5.9.4 CLI/2.165.0",
    ideName: "WorkBuddy",
    clientVersion: "5.9.4",
    deploymentType: "SaaS",
    acceptLanguage: "en-US",
  },
});

/** 国际版固定域：不回退登录会话里的 CN 域，否则等于把 CN 身份送去 AI 站 */
const INTL_DOMAIN = "www.workbuddy.ai";

// ===== 上游业务码语义 =====
// 依据示例项目 Agent2Providers crates/providers/src/providers/workbuddy/errors.rs：
// WB 的业务错误大多发生在 **HTTP 200 + SSE/JSON 错误体**里，只按 HTTP 状态分类必然误判。
const TRANSIENT_CODES = new Set([14003, 6001, 6002, 6005, 6006]); // 短时限流：约 30s
const EXHAUSTED_CODES = new Set([14001, 14012, 14013, 14014, 14018, 14019]); // 额度耗尽：次日重置
const FATAL_CODES = new Set([14015, 14016, 14017, 11101, 11133, 11158]); // 请求/权限不可修复
const CONTENT_CODES = new Set([11128]); // 内容审核拦截
const RATE_MARKERS = ["rate limit", "rate-limiting", "rate-limited", "too many requests", "请求过于频繁", "限流"];
const TOO_LONG_MARKERS = ["too long", "too many tokens", "context length", "maximum context", "request entity too large", "输入过长", "内容过长", "上下文过长"];

/** 次日 00:00（UTC+8）：额度类重置口径，对齐 errors.rs 的 next_day_reset */
function nextDayReset() {
  const day = 86400000, offset = 8 * 3600000, now = Date.now();
  return Math.floor((now + offset) / day) * day + day - offset;
}

/** 业务码：WB 会把它埋进 /data、/error、/response/data，深度 6 内找第一个 >=1000 的 code */
function businessNode(node, depth = 6) {
  if (!node || depth <= 0 || typeof node !== "object") return null;
  const code = Number(node.code);
  if (Number.isFinite(code) && code >= 1000) return node;
  for (const key of ["data", "error", "response"]) {
    const found = businessNode(node[key], depth - 1);
    if (found) return found;
  }
  return null;
}
function nodeMessage(node) {
  if (!node || typeof node !== "object") return "";
  for (const key of ["message", "msg", "displayMsg"]) {
    const text = node[key];
    if (typeof text === "string" && text.trim()) return text.trim();
  }
  const nested = node.error && (node.error.message || node.error.msg);
  return typeof nested === "string" ? nested.trim() : "";
}
/** 上游错误体归一：{ code(数字), message(文本) }，body 允许是对象 / JSON 文本 / 纯文本 */
function errorInfo(body) {
  let node = body;
  if (typeof body === "string") {
    try { node = JSON.parse(body); } catch { return { code: 0, message: body.slice(0, 500) }; }
  }
  const business = businessNode(node);
  const code = Number(business?.code ?? node?.code ?? 0) || 0;
  const message = nodeMessage(business) || nodeMessage(node) || (typeof node === "string" ? node.slice(0, 500) : "");
  return { code, message };
}

/**
 * WB 业务码 → 错误语义。
 * kind 与号池 classify.cjs / 示例项目 errors.rs 对齐，供下面映射成协议的 category/scope；
 * 这里**绝不产出数字 code**——协议层 identifier() 只接受字符串，数字会让每次上游报错都退化成
 * 笼统的 UPSTREAM_FAILED，同时丢掉账号冷却所依赖的 category/scope。
 */
function classifyWorkBuddy(status, body) {
  const httpStatus = Math.min(599, Math.max(400, Number(status) || 502));
  const { code, message } = errorInfo(body);
  const text = message.toLowerCase();
  if (Number(status) === 401 || code === 12153) return { kind: "relogin", status: 401, code, message };
  // 11140 同码两义：账号级风控拦停（request illegal / 账号异常）与模型级限流（rate-limiting）。
  // 只有明确带限流文案时才按限流处理，其余一律按账号级风控——宁可冷却一次，也不要让已被
  // 上游拦掉的账号被反复重试（号池 workbuddy-switch-probe.cjs 同样以 11140 判账号被拦）。
  if (code === 11140 && !RATE_MARKERS.some(marker => text.includes(marker)))
    return { kind: "account_blocked", status: 403, code, message };
  // 11102 = 该账号不支持此模型：换号或换模型都能解决，不能当不可修复的 Fatal
  if (code === 11102 || text.includes("service info not found")) return { kind: "model_blocked", status: 404, code, message };
  if (FATAL_CODES.has(code)) return { kind: "bad_params", status: Number(status) >= 400 ? Number(status) : 400, code, message };
  if (Number(status) === 413 || code === 11115 || code === 4001 || TOO_LONG_MARKERS.some(marker => text.includes(marker)))
    return { kind: "prompt_too_long", status: 413, code, message };
  if (CONTENT_CODES.has(code)) return { kind: "content_blocked", status: 400, code, message };
  if (Number(status) === 402 || EXHAUSTED_CODES.has(code))
    return { kind: "credit", status: 402, code, message, resetMs: nextDayReset() };
  const rate = Number(status) === 429 || code === 4008 || (code >= 6000 && code <= 6008) || code === 10105 || code === 14003
    || RATE_MARKERS.some(marker => text.includes(marker));
  if (rate) {
    // 6004 是模型级限流（换模型即可用），其余按账号级；时长优先取上游文案，取不到交给宿主退避
    const modelLevel = code === 6004 || code === 10105;
    const resetMs = TRANSIENT_CODES.has(code) ? Date.now() + 30000
      : parseRateResetMs(message) || 0;
    return { kind: modelLevel ? "model_rate" : "rate", status: 429, code, message, ...(resetMs ? { resetMs } : {}) };
  }
  if (Number(status) >= 500) return { kind: "server", status: 502, code, message };
  return { kind: "fatal", status: httpStatus, code, message };
}

// kind → [category, scope, 默认 HTTP 状态, 是否可换号重试]
// category 必须在协议白名单内；scope 决定宿主是否冷却账号（forwarder.applyExtensionFailure
// 只处理 account / account-model 两种 scope）。
const KIND_SHAPE = Object.freeze({
  relogin: ["auth", "account", 401, true],
  account_blocked: ["account", "account", 403, false],
  credit: ["quota", "account", 402, true],
  rate: ["rate", "account", 429, true],
  model_rate: ["rate", "account-model", 429, true],
  model_blocked: ["model", "account-model", 404, true],
  prompt_too_long: ["model", "invocation", 413, false],
  content_blocked: ["model", "invocation", 400, false],
  bad_params: ["model", "invocation", 400, false],
  slow: ["network", "invocation", 504, true],
  server: ["upstream", "account", 502, true],
  fatal: ["upstream", "invocation", 502, false],
});

/** 上游错误 → 协议错误。code 恒为字符串（`UPSTREAM_<KIND>`），并带齐 category/scope/status/retryable */
function upstreamError(status, body, { contentSeen = false, retryAfterMs = 0 } = {}) {
  const cls = classifyWorkBuddy(status, body);
  const [category, scope, fallbackStatus, retryable] = KIND_SHAPE[cls.kind] || KIND_SHAPE.fatal;
  const rejected = Number(status) >= 400 && Number(status) < 500;
  const resetMs = Number(cls.resetMs) || (retryAfterMs > 0 ? Date.now() + retryAfterMs : 0);
  const wait = resetMs > Date.now() ? Math.min(86400000, resetMs - Date.now()) : 0;
  return forwardError({
    code: `UPSTREAM_${cls.kind.toUpperCase()}`,
    message: cls.message
      ? `WorkBuddy 上游返回 ${Number(status) || 0}（code=${cls.code}）：${cls.message.slice(0, 200)}`
      : `WorkBuddy 上游返回 ${Number(status) || 0}，未给出错误说明`,
    category, scope,
    status: fallbackStatus || Math.min(599, Math.max(400, Number(status) || 502)),
    retryable: retryable && !contentSeen,
    replay: contentSeen ? "unsafe" : rejected || cls.kind === "relogin" ? "safe" : "unknown",
    ...(wait ? { retryAfterMs: wait } : {}),
  });
}

/** 本地（非上游）错误：code 强制字符串，避免同样撞上协议层的类型断言 */
function errorFor(status, code, message, scope = "invocation") {
  const num = Math.min(599, Math.max(400, Number(status) || 502));
  return forwardError({
    code: String(code || "UPSTREAM_FAILED"),
    message: String(message || "WorkBuddy 请求失败"),
    category: num === 401 ? "auth" : num === 429 ? "rate" : num === 402 ? "quota" : "upstream",
    scope,
    replay: num === 401 || num === 429 || num >= 500 ? "safe" : "unknown",
    retryable: num === 401 || num === 429 || num >= 500,
    status: num,
  });
}

/** 非 2xx：必须读回错误体再分类——不读 body 就等于把上游给的具体业务码整段丢掉 */
async function httpError(response, contentSeen = false) {
  let detail = "";
  try { detail = await errorDetail(response); } catch { /* 错误体读取失败仍按状态码分类 */ }
  const raw = Number(response.headers?.get?.("retry-after"));
  return upstreamError(response.status, detail, {
    contentSeen,
    retryAfterMs: Number.isFinite(raw) && raw > 0 ? Math.min(86400000, raw * 1000) : 0,
  });
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
/**
 * 请求头。settings 支持顶层与 `channels.<渠道>` 两种覆盖口径——两种都要认，
 * 否则「按渠道配 UA/端点」只在目录请求生效、聊天请求仍走默认值（半生效比不生效更难查）。
 */
function headers(channel, account, secrets, settings, { conversation = true, accept = "application/json" } = {}) {
  const base = { ...DEFAULTS[channel], ...(settings || {}), ...(settings?.channels?.[channel] || {}) };
  const uid = String(account?.uid || account?.accountId || "");
  const traceId = crypto.randomBytes(16).toString("hex");
  const spanId = crypto.randomBytes(8).toString("hex");
  const parentSpanId = crypto.randomBytes(8).toString("hex");
  const requestId = crypto.randomUUID();
  const result = {
    "content-type": "application/json",
    accept,
    "accept-language": base.acceptLanguage || (channel === "workbuddy_ai" ? "en-US" : "zh-CN"),
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
    // 官方客户端一次发送内的所有重试/工具调用复用同一个 request-id，且 X-Root-Request-ID 必带
    result["x-conversation-request-id"] = requestId;
    result["x-root-request-id"] = requestId;
    result["x-conversation-message-id"] = crypto.randomUUID();
  }
  result["x-request-id"] = requestId;
  if (uid) result["x-user-id"] = uid;
  // 身份头：官方客户端对「缺省」和「明确声明没有」区别对待——个人号必须显式声明
  // X-No-Enterprise-Id，否则上游会把缺失身份当成可疑信号（示例项目 workbuddy2api 实测）。
  if (account?.enterpriseId) {
    result["x-enterprise-id"] = String(account.enterpriseId);
    result["x-tenant-id"] = String(account.enterpriseId);
  } else {
    result["x-no-enterprise-id"] = "1";
  }
  // 域头按地区固定：国际号一律 .ai（不回退登录态里的 CN 域），CN 号沿用账号域
  if (channel === "workbuddy_ai") result["x-domain"] = INTL_DOMAIN;
  else if (account?.domain) result["x-domain"] = String(account.domain);
  else result["x-no-department-info"] = "1";
  return result;
}
async function* invokeStream(response, signal) {
  let seen = false, finish = "stop";
  for await (const raw of sse(response, signal)) {
    if (!raw || raw === "[DONE]") continue;
    let data; try { data = JSON.parse(raw); } catch { continue; }
    // 流内错误帧：HTTP 仍是 200，真实原因全在这个 error 节点里（6004/11140/11102 都在这里出现）
    if (data.error) throw upstreamError(502, data);
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
  const channelConfig = channel => ({ ...DEFAULTS[channel], ...(settings || {}), ...(settings?.channels?.[channel] || {}) });
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
      const base = { ...defaults, ...channelConfig(channel) };
      const secrets = await ctx.pool.credentials();
      if (!secrets?.token) throw new Error("WorkBuddy catalog requires an account token");
      const account = context;
      const headersFor = () => headers(channel, account, secrets, settings, { conversation: false });
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
      const body = rewrite(upstreamModel, request.input, account, settings); const base = channelConfig(channel);
      const requestHeaders = headers(channel, account, secrets, settings, { accept: "application/json, text/event-stream" });
      let response;
      for (const url of [base.chatUrl, base.consoleChatUrl].filter(Boolean)) {
        response = await ctx.pool.network().fetch(url, { method: "POST", redirect: "error", signal: ctx.signal, headers: requestHeaders, body: JSON.stringify(body) });
        if (response.status !== 404 && response.status !== 405) break;
      }
      if (!response) throw upstreamError(502, { message: "WorkBuddy 两个对话端点都没有响应" });
      if (response.status === 404 || response.status === 405)
        throw upstreamError(response.status, { message: `WorkBuddy 对话端点不可用 HTTP ${response.status}` });
      if (!response.ok) throw await httpError(response);
      yield* invokeStream(response, ctx.signal);
    } };
}
module.exports = { createWorkBuddy, rewrite, classifyWorkBuddy };
