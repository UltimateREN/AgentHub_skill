/**
 * ============================================================
 *  作者：UltimateREN
 *  日期：2026-11-10
 *  版权声明：本代码归 UltimateREN 所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// AStudio（科大讯飞 Astron Studio）：**OpenAI Responses 协议**，插件自己做翻译层。
// 依据 Agent2Providers `astudio/responses.rs` 与 `chat.rs` 模块头。
//
// ── 为什么入站 Chat、出站 Responses ────────────────────────
// 桌面端写进 acode 内核的是 `wire_api = responses`，直连
// `/model-gateway/v1/responses`。网关对外只讲 Chat，所以这一层做两件事：
//   1. 把 messages 折成 Responses 的 `input` 项（含 function_call /
//      function_call_output），system 提成 `instructions`；
//   2. 把 Responses 的 SSE 事件（`response.output_text.delta` 一族）翻回 chat 帧。
"use strict";
const { descriptor } = require("../../model-descriptor.cjs");
const { sse, errorDetail } = require("../../network/sse.cjs");
const { forwardError, hasContent } = require("../../../sdk/provider-protocol.cjs");

const RESPONSES_URL = "https://astronstudio-api-volces-prod.xf-yun.com/model-gateway/v1/responses";

function fail(status, code, message, scope = "invocation", retryable = false) {
  return forwardError({
    code, message: String(message || "AStudio 模型执行失败").slice(0, 1024),
    category: code === "AUTH_REQUIRED" ? "auth" : code === "RATE_LIMITED" ? "rate" : "upstream",
    scope, replay: "unknown", retryable,
    status: status >= 400 && status <= 599 ? status : 502,
  });
}
function classify(status, detail) {
  const text = String(detail || "").slice(0, 2048);
  if (status === 401 || status === 403) return fail(401, "AUTH_REQUIRED", "AStudio 凭据被拒，请重新登录或粘贴", "account");
  if (/积分不足|insufficient|quota/i.test(text)) return fail(429, "QUOTA_EXHAUSTED", "AStudio 积分不足", "account", true);
  if (status === 429) return fail(429, "RATE_LIMITED", "AStudio 上游限流", "account", true);
  if (status === 400 || status === 422) return fail(400, "INVALID_REQUEST", "AStudio 拒绝了该请求（参数不合法）");
  return fail(status >= 400 && status <= 599 ? status : 502, "UPSTREAM_FAILED", "AStudio 模型执行失败", "invocation", status >= 500);
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part && ["text", "input_text", "output_text"].includes(part.type))
    .map((part) => String(part.text || "")).join("\n\n");
}
function userContent(content) {
  if (typeof content === "string") return [{ type: "input_text", text: content }];
  const items = [];
  for (const part of Array.isArray(content) ? content : []) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text" || part.type === "input_text") items.push({ type: "input_text", text: String(part.text || "") });
    else if (part.type === "image_url" && part.image_url?.url) items.push({ type: "input_image", image_url: String(part.image_url.url) });
    else if (part.type === "input_image" && part.image_url) items.push({ type: "input_image", image_url: String(part.image_url) });
  }
  return items.length ? items : [{ type: "input_text", text: "" }];
}

/** Chat 请求 → Responses 请求（instructions + input + tools + reasoning.effort） */
function buildRequest(input, model) {
  const body = input || {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const instructions = messages.filter((m) => m && (m.role === "system" || m.role === "developer"))
    .map((m) => contentText(m.content)).filter(Boolean).join("\n\n");
  const items = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const role = String(message.role || "user");
    if (role === "system" || role === "developer") continue;
    if (role === "tool") {
      items.push({ type: "function_call_output", call_id: String(message.tool_call_id || ""), output: contentText(message.content) });
      continue;
    }
    if (role === "assistant") {
      const text = contentText(message.content);
      if (text) items.push({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
      for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        if (!call || !call.function) continue;
        items.push({ type: "function_call", call_id: String(call.id || ""), name: String(call.function.name || ""), arguments: String(call.function.arguments || "{}") });
      }
      continue;
    }
    items.push({ type: "message", role: "user", content: userContent(message.content) });
  }
  const payload = {
    model: String(model || body.model || ""),
    input: items,
    stream: true,
    ...(instructions ? { instructions } : {}),
  };
  if (body.max_tokens != null || body.max_completion_tokens != null) payload.max_output_tokens = Number(body.max_tokens ?? body.max_completion_tokens) || 4096;
  if (Number.isFinite(Number(body.temperature))) payload.temperature = Number(body.temperature);
  if (Number.isFinite(Number(body.top_p))) payload.top_p = Number(body.top_p);
  if (Array.isArray(body.tools) && body.tools.length) {
    payload.tools = body.tools.filter((tool) => tool && tool.function && tool.function.name).map((tool) => ({
      type: "function", name: String(tool.function.name),
      ...(tool.function.description ? { description: String(tool.function.description) } : {}),
      parameters: tool.function.parameters || { type: "object", properties: {} },
    }));
  }
  if (body.reasoning_effort) payload.reasoning = { effort: String(body.reasoning_effort) };
  if (body.response_format && typeof body.response_format === "object") {
    const schema = body.response_format.json_schema;
    if (schema) payload.text = { format: { type: "json_schema", name: String(schema.name || "output"), schema: schema.schema || {} } };
  }
  return payload;
}

function createAStudio(settings = {}) {
  const url = String(settings.responsesUrl || RESPONSES_URL);
  return {
    id: "astudio", channels: ["astudio"], requiredFeatures: ["execution-facts@1"],
    async listModels(request, ctx) {
      if (!request.grantId) return [];
      const context = await ctx.pool.context();
      return (context.models || []).map(descriptor);
    },
    async *invoke(request, ctx) {
      const credentials = await ctx.pool.credentials();
      const token = String(credentials?.token || "").trim();
      if (!token) throw fail(401, "AUTH_REQUIRED", "AStudio 模型凭据缺失", "account");
      const input = request.input || {};
      const payload = buildRequest(input, request.model);
      let response;
      try {
        await ctx.attempts?.report({ state: "planned", actualModel: payload.model });
        response = await ctx.pool.network().fetch(url, {
          method: "POST", redirect: "error", signal: ctx.signal,
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "text/event-stream" },
          body: JSON.stringify(payload),
        });
        await ctx.attempts?.report({ state: "responded", actualModel: payload.model });
      } catch (error) {
        if (ctx.signal?.aborted) throw fail(504, "UPSTREAM_TIMEOUT", "AStudio 请求已取消或超时");
        throw classify(502, error?.message);
      }
      if (!response.ok) throw classify(response.status, await errorDetail(response));
      let contentSeen = false;
      let finishReason = "stop";
      let usage = null;
      // 工具调用按 item_id 聚合（Responses 把参数拆成多段 delta）
      const calls = new Map();
      try {
        for await (const raw of sse(response, ctx.signal)) {
          if (!raw || raw === "[DONE]") continue;
          let frame;
          try { frame = JSON.parse(raw); } catch { continue; }
          if (!frame || typeof frame !== "object") continue;
          const type = String(frame.type || "");
          if (type === "error" || type === "response.failed") {
            const detail = JSON.stringify(frame.error || frame.response || frame);
            throw classify(Number(frame.error?.status) || 502, detail);
          }
          if (type === "response.output_text.delta") {
            const text = String(frame.delta ?? "");
            if (text) { contentSeen = true; yield { type: "delta", delta: { content: text } }; }
            continue;
          }
          if (type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") {
            const text = String(frame.delta ?? "");
            if (text) yield { type: "delta", delta: { reasoning_content: text } };
            continue;
          }
          if (type === "response.output_item.added" && frame.item?.type === "function_call") {
            const id = String(frame.item.id || frame.item.call_id || "");
            calls.set(id, { id: String(frame.item.call_id || id), name: String(frame.item.name || ""), arguments: "" });
            continue;
          }
          if (type === "response.function_call_arguments.delta") {
            const id = String(frame.item_id || frame.call_id || "");
            const entry = calls.get(id);
            if (entry) entry.arguments += String(frame.delta ?? "");
            continue;
          }
          if (type === "response.output_item.done" && frame.item?.type === "function_call") {
            const id = String(frame.item.id || frame.item.call_id || "");
            const entry = calls.get(id) || { id: String(frame.item.call_id || id), name: String(frame.item.name || ""), arguments: "" };
            if (!entry.arguments && frame.item.arguments) entry.arguments = String(frame.item.arguments);
            calls.set(id, entry);
            continue;
          }
          if (type === "response.completed") {
            const resp = frame.response || {};
            usage = resp.usage || usage;
            const reason = resp.status === "incomplete" ? "length" : "stop";
            finishReason = reason;
            continue;
          }
        }
        // 工具调用统一在收尾处下发（Responses 是整体事件）
        let index = 0;
        for (const entry of calls.values()) {
          if (!entry.name) continue;
          yield { type: "delta", delta: { tool_calls: [{
            index: index++, id: entry.id || `call_${index}`, type: "function",
            function: { name: entry.name, arguments: entry.arguments || "{}" },
          }] } };
          contentSeen = true;
        }
        if (usage) yield { type: "usage", mode: "snapshot", usage: {
          prompt_tokens: Number(usage.input_tokens) || 0,
          completion_tokens: Number(usage.output_tokens) || 0,
          total_tokens: Number(usage.total_tokens) || (Number(usage.input_tokens) || 0) + (Number(usage.output_tokens) || 0),
        } };
        if (!contentSeen) throw fail(502, "EMPTY_UPSTREAM_RESPONSE", "AStudio 返回空响应");
        yield { type: "finish", reason: calls.size ? "tool_calls" : finishReason };
      } finally {
        try { await response.body?.cancel(); } catch { /* 已关闭 */ }
      }
    },
  };
}

module.exports = { createAStudio, buildRequest, contentText, userContent, classify, RESPONSES_URL };
