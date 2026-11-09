"use strict";
const { descriptor } = require("../../model-descriptor.cjs");
const { sse, errorDetail } = require("../../network/sse.cjs");
const { forwardError } = require("../../../sdk/runtime/provider.cjs");
const { hasContent } = require("../../../sdk/provider-protocol.cjs");

function failure(status, detail = "", seen = false) {
  const text = String(detail || "").slice(0, 2048);
  const quota = status === 402 || /insufficient|credit|quota|balance|积分|余额|欠费|40201/i.test(text);
  const auth = status === 401 || status === 403;
  const rate = status === 429 || /\b(?:4008|6004)\b/.test(text);
  return forwardError({
    code: quota ? "QUOTA_EXHAUSTED" : auth ? "AUTH_REQUIRED" : rate ? "RATE_LIMITED" : "UPSTREAM_FAILED",
    message: quota ? "Lobster 积分不足" : auth ? "Lobster 登录态无效，请在号池检查凭据" : rate ? "Lobster 上游请求受限" : "Lobster 模型执行失败",
    category: quota ? "quota" : auth ? "auth" : rate ? "rate" : "upstream",
    scope: quota || auth ? "account" : rate ? "account-model" : "invocation",
    replay: seen ? "unsafe" : "unknown", retryable: rate || !seen && status >= 500,
    status: quota ? 402 : auth ? 401 : rate ? 429 : status >= 400 && status <= 599 ? status : 502,
  });
}

function createThinkSplitter() {
  let inThink = false, pending = "";
  const split = (content, tag) => {
    for (let n = Math.min(content.length, tag.length - 1); n > 0; n--) if (content.endsWith(tag.slice(0, n))) return n;
    return 0;
  };
  return content => {
    if (typeof content !== "string" || !content) return { reasoning: "", content: "" };
    let buffer = pending + content, reasoning = "", output = "";
    pending = "";
    for (;;) {
      const tag = inThink ? "</think>" : "<think>";
      const index = buffer.indexOf(tag);
      if (index >= 0) {
        if (inThink) reasoning += buffer.slice(0, index); else output += buffer.slice(0, index);
        buffer = buffer.slice(index + tag.length);
        inThink = !inThink;
        continue;
      }
      const keep = split(buffer, tag);
      const ready = keep ? buffer.slice(0, -keep) : buffer;
      if (inThink) reasoning += ready; else output += ready;
      if (keep) pending = buffer.slice(-keep);
      break;
    }
    return { reasoning, content: output };
  };
}

function rewriteBody(model, input) {
  const body = { ...(input || {}), model: String(model || input?.model || "") };
  body.stream = true;
  body.stream_options = { ...(body.stream_options || {}), include_usage: true };
  if (body.tool_choice == null || body.tool_choice === "" || body.tool_choice === "none") delete body.tool_choice;
  delete body.conversation_id;
  delete body.conversationId;
  delete body.prompt_cache_key;
  // role: "developer" → "system"：上游不认 OpenAI 新版角色，带它的请求会被上游网关
  // 以 HTTP 502「角色信息不正确」拒绝（system / user 均 200）。两者在 OpenAI 规范里
  // 语义相同，按 system 下发。这是实测结论（Agent2Providers lobsterai/chat.rs 第 1 条），
  // 不是风格偏好 —— 缺这一步时 Codex CLI / Cline 这类发 developer 的客户端会稳定失败。
  if (Array.isArray(body.messages)) {
    body.messages = body.messages.map((message) => (
      message && typeof message === "object" && message.role === "developer"
        ? { ...message, role: "system" }
        : message
    ));
  }
  return body;
}
function parse(raw) {
  try { const data = JSON.parse(raw); return data && typeof data === "object" && !Array.isArray(data) ? data : null; }
  catch { return null; }
}
function usageEvent(usage) {
  if (!usage || typeof usage !== "object") return null;
  const prompt = Number(usage.prompt_tokens ?? usage.input_tokens) || 0;
  const completion = Number(usage.completion_tokens ?? usage.output_tokens) || 0;
  const total = Number(usage.total_tokens) || 0;
  return { type: "usage", mode: "snapshot", usage: { ...usage, prompt_tokens: prompt, completion_tokens: completion, total_tokens: total } };
}

function createLobster(settings = {}) {
  const base = String(settings.base || "https://lobsterai-server.youdao.com/api/proxy/v1").replace(/\/+$/, "");
  const catalogBase = String(settings.catalogBase || "https://lobsterai-server.youdao.com").replace(/\/+$/, "");
  async function readCatalog(fetcher, url, token, signal) {
    const response = await fetcher(url, { method: "GET", redirect: "error", signal,
      headers: { accept: "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) } });
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > 4 * 1024 * 1024) throw new Error("Lobster catalog response exceeds limit");
    let data; try { data = JSON.parse(text); } catch { throw new Error("Lobster catalog returned invalid JSON"); }
    if (!response.ok) throw Object.assign(new Error(`Lobster catalog HTTP ${response.status}`), { status: response.status });
    return data;
  }
  function catalogRows(data) {
    const rows = data?.data?.models || data?.models || data?.data?.textModels || data?.textModels || data?.data;
    if (!Array.isArray(rows)) return [];
    return rows.flatMap(item => {
      if (!item || typeof item !== "object") return [];
      const id = item.id || item.modelId || item.model_id || item.name;
      if (typeof id !== "string" || !id.trim()) return [];
      const caps = {};
      const image = item.supportsImage ?? item.supportsImages ?? item.supports_images;
      const reasoning = item.supportsThinking ?? item.supportsReasoning ?? item.supports_reasoning;
      const tools = item.supportsToolCall ?? item.supports_tool_call;
      if (typeof image === "boolean") caps.images = image;
      if (typeof reasoning === "boolean") caps.reasoning = reasoning;
      if (typeof tools === "boolean") caps.tools = tools;
      const routing = {};
      for (const key of ["keyfrom", "routeId", "upstreamId"]) if (typeof item[key] === "string" && item[key].length <= 512) routing[key] = item[key];
      const rate = Number(item.costMultiplier ?? item.rate ?? item.points_multiplier);
      const contextLength = Number(item.contextWindow ?? item.context_window ?? item.contextLength) || 0;
      const maxOutputTokens = Number(item.maxOutputTokens ?? item.max_tokens) || 0;
      return [{ id, name: String(item.name || item.modelName || item.model_name || id),
        ...(Number.isFinite(rate) ? { rate } : {}), capabilities: caps, contextLength, maxOutputTokens,
        ...(Object.keys(routing).length ? { routing } : {}) }];
    });
  }
  const version = String(settings.clientVersion || "2026.9.23");
  const clientName = String(settings.clientName || "LobsterAI");
  return {
    id: "lobster", channels: ["lobster"], requiredFeatures: ["execution-facts@1"],
    async listModels(request, ctx) {
      const context = request.grantId ? await ctx.pool.context() : {};
      if (!request.force) return (context.models || []).map(descriptor);
      const fetcher = ctx.pool.network().fetch;
      let primaryError;
      try {
        const secrets = await ctx.pool.credentials();
        const token = String(secrets?.token || "").trim();
        if (!token) throw new Error("Lobster account token is unavailable");
        const data = await readCatalog(fetcher, settings.modelsUrl || `${catalogBase}/api/models/available`, token, ctx.signal);
        const models = catalogRows(data);
        if (models.length) return models.map(descriptor);
        throw new Error("Lobster authenticated model catalog is empty");
      } catch (error) { primaryError = error; }
      try {
        const data = await readCatalog(fetcher, settings.pricingCatalogUrl || `${catalogBase}/api/models/pricing-catalog`, "", ctx.signal);
        const models = catalogRows(data);
        if (models.length) return models.map(descriptor);
      } catch { /* Preserve the original authenticated failure below. */ }
      throw new Error(`Lobster model catalog refresh failed: ${String(primaryError?.message || "no usable models").slice(0, 180)}`);
    },
    async *invoke(request, ctx) {
      const credentials = await ctx.pool.credentials();
      const token = String(credentials?.token || "").trim();
      if (!token) throw failure(401);
      const model = String(request.model || request.input?.model || "");
      const payload = JSON.stringify(rewriteBody(model, request.input));
      const controller = new AbortController();
      const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;
      const timeoutMs = Math.max(1, Math.min(Number(settings.firstByteTimeoutMs) || 30000,
        Number.isFinite(ctx.deadlineAt) ? ctx.deadlineAt - Date.now() : 30000));
      const timer = setTimeout(() => controller.abort(new Error("Lobster first event timed out")), timeoutMs);
      timer.unref?.();
      let response, contentSeen = false, finishReason = "", upstreamError = null;
      const think = createThinkSplitter();
      const seenToolIndex = new Set();
      try {
        await ctx.attempts?.report({ state: "planned", actualModel: model });
        signal.throwIfAborted();
        response = await ctx.pool.network().fetch(`${base}/chat/completions`, { method: "POST", redirect: "error", signal,
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "text/event-stream, application/json",
            "user-agent": `${clientName}/${version}`, "X-LobsterAI-Client-Capabilities": settings.clientCapabilities || "kimi-k3-agentic-v1",
            "X-LobsterAI-Client-Version": version }, body: payload });
        await ctx.attempts?.report({ state: "responded", actualModel: model });
        if (!response.ok) throw failure(response.status, await errorDetail(response));
        for await (const raw of sse(response, signal)) {
          clearTimeout(timer);
          if (!raw || raw === "[DONE]") continue;
          const frame = parse(raw);
          if (!frame) continue;
          const error = frame.error;
          const code = Number(error?.code ?? frame.code) || 0;
          const detail = String(error?.message || frame.message || "");
          if (error || code && code !== 200) {
            upstreamError = failure(code === 40201 || /insufficient|credit|quota|balance|积分|余额|欠费/i.test(detail) ? 402 : code === 401 ? 401 : [4008, 6004].includes(code) ? 429 : 502,
              `${code} ${detail}`, contentSeen);
            continue;
          }
          if (upstreamError) continue;
          const choice = frame.choices?.[0];
          const delta = choice?.delta || choice?.message;
          if (delta && typeof delta === "object" && !Array.isArray(delta)) {
            const normalized = { ...delta };
            if (typeof normalized.content === "string") {
              const parts = think(normalized.content);
              delete normalized.content;
              if (parts.reasoning) { contentSeen = true; yield { type: "delta", delta: { reasoning_content: parts.reasoning } }; }
              if (parts.content) normalized.content = parts.content;
            }
            if (Array.isArray(normalized.tool_calls)) {
              normalized.tool_calls = normalized.tool_calls.map(tool => {
                const index = String(Number(tool?.index) || 0);
                if (tool?.function && seenToolIndex.has(index) && Object.hasOwn(tool.function, "name")) {
                  const fn = { ...tool.function }; delete fn.name; return { ...tool, function: fn };
                }
                seenToolIndex.add(index); return tool;
              });
            }
            if (hasContent(normalized)) { contentSeen = true; yield { type: "delta", delta: normalized }; }
            else if (normalized.content === "") yield { type: "delta", delta: { content: "" } };
          }
          if (choice?.finish_reason) finishReason = String(choice.finish_reason);
          const usage = usageEvent(frame.usage);
          if (usage) yield usage;
        }
        if (upstreamError) throw upstreamError;
        if (!contentSeen) throw failure(502, "empty response");
        yield { type: "finish", reason: finishReason };
      } catch (error) {
        if (error?.forwardError) throw error;
        if (signal.aborted) throw failure(504, "cancelled or timed out", contentSeen);
        throw failure(Number(error?.status) || 502, error?.message, contentSeen);
      } finally {
        clearTimeout(timer);
        try { await response?.body?.cancel(); } catch { /* Stream may already be closed. */ }
      }
    },
  };
}
module.exports = { createLobster, rewriteBody, createThinkSplitter };
