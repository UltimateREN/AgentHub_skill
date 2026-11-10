/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-11-10
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// Antigravity（Google AI IDE）：**Cloud Code Assist 信封 + Gemini SSE**。
// 依据 Agent2Providers `antigravity/antigravity_outbound.rs` 模块头（请求信封逐字段）。
//
// ── 信封（agent 路径）───────────────────────────────────────
// {
//   project?          cloudaicompanionProject（缺失不发该键）
//   model             上游真名
//   userAgent         "antigravity"（企业账号 → "jetski"）
//   requestId         agent/<ts_ms>/<8hex>
//   request: {
//     systemInstruction, tools（单组 functionDeclarations）,
//     generationConfig: { temperature, topP, topK, maxOutputTokens,
//                         thinkingConfig: { includeThoughts, thinkingBudget } },
//     sessionId, contents: [{ role: "user"|"model", parts }]
//   }
// }
// **agent 路径不发 requestType**（两参考矛盾，发了有假 429 风险）。
//
// ── 响应 ───────────────────────────────────────────────────
// SSE，每帧 `{"response":{candidates:[{content:{parts:[{text, thought, thoughtSignature}]}}], usageMetadata}}`。
// `thought: true` 的 part 是思考增量；`thoughtSignature` 要随历史回传（本版透传，不重建缓存）。
"use strict";
const crypto = require("node:crypto");
const { descriptor } = require("../../model-descriptor.cjs");
const { sse, errorDetail } = require("../../network/sse.cjs");
const { forwardError } = require("../../../sdk/provider-protocol.cjs");

const V1_ENVS = ["sandbox", "daily", "prod"];
const KNOWN_STABLE_VERSION = "4.3.0";
const STATIC_MODELS = [
  ["gemini-3-pro", "Gemini 3 Pro"], ["gemini-3-flash", "Gemini 3 Flash"],
  ["gemini-2.5-pro", "Gemini 2.5 Pro"], ["gemini-2.5-flash", "Gemini 2.5 Flash"],
  ["claude-sonnet-4.5", "Claude Sonnet 4.5"],
];
const DEFAULT_THINKING_BUDGET = 10000;
const MAX_OUTPUT_DEFAULT = 40960;
/** contents 必须以 user 结尾时补的那句（Manager TRANSIT_DEFENSE_FALLBACK_TEXT 逐字） */
const FALLBACK_USER_TEXT = "Please continue your analysis.";
/** 历史工具调用缺签名时补的官方哨兵（Google 文档认可的跳过校验值） */
const SKIP_SIGNATURE_SENTINEL = "skip_thought_signature_validator";
/** Claude 历史轮缺思考块时补的占位正文（Manager 同款） */
const CLAUDE_THOUGHT_PLACEHOLDER = "...";

function fail(status, code, message, scope = "invocation", retryable = false) {
  return forwardError({
    code, message: String(message || "Antigravity 模型执行失败").slice(0, 1024),
    category: code === "AUTH_REQUIRED" ? "auth" : code === "RATE_LIMITED" ? "rate" : "upstream",
    scope, replay: "unknown", retryable,
    status: status >= 400 && status <= 599 ? status : 502,
  });
}
function classify(status, detail) {
  const text = String(detail || "").slice(0, 2048);
  if (status === 401 || status === 403) return fail(401, "AUTH_REQUIRED", "Antigravity 凭据被拒，请重新授权", "account");
  if (/RESOURCE_EXHAUSTED|quota|429/.test(text) && (status === 429 || status === 200)) return fail(429, "RATE_LIMITED", "Antigravity 上游限流", "account", true);
  if (status === 429) return fail(429, "RATE_LIMITED", "Antigravity 上游限流", "account", true);
  if (status === 400 || status === 422) return fail(400, "INVALID_REQUEST", "Antigravity 拒绝了该请求（参数不合法）");
  return fail(status >= 400 && status <= 599 ? status : 502, "UPSTREAM_FAILED", "Antigravity 模型执行失败", "invocation", status >= 500);
}
/** UA：必须含 antigravity，版本不低于 4.3.0（低版本会被按老客户端处理，分段模型 404） */
function sanitizeUserAgent(raw) {
  const text = String(raw || "").trim();
  const base = text && /antigravity/i.test(text) ? text : `antigravity/${KNOWN_STABLE_VERSION}`;
  const m = /antigravity\/([0-9]+)\.([0-9]+)\.([0-9]+)/i.exec(base);
  if (!m) return `antigravity/${KNOWN_STABLE_VERSION}`;
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const [lowMajor, lowMinor, lowPatch] = KNOWN_STABLE_VERSION.split(".").map(Number);
  const older = major < lowMajor || (major === lowMajor && (minor < lowMinor || (minor === lowMinor && patch < lowPatch)));
  return older ? base.replace(/antigravity\/[0-9.]+/i, `antigravity/${KNOWN_STABLE_VERSION}`) : base;
}
function v1Base(env) {
  return `https://${env}-cloudcode-pa.googleapis.com/v1internal`;
}
/** schema 清洗：type 转小写、去掉上游不认的键、空对象补 properties */
function cleanSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return { type: "object", properties: {} };
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (["additionalProperties", "$schema", "$id", "definitions", "$defs", "strict"].includes(key)) continue;
    if (key === "type" && typeof value === "string") { out.type = value.toLowerCase(); continue; }
    if (["properties", "items"].includes(key) && value && typeof value === "object") {
      if (key === "properties") {
        out.properties = {};
        for (const [name, sub] of Object.entries(value)) out.properties[name] = cleanSchema(sub);
      } else out.items = cleanSchema(value);
      continue;
    }
    out[key] = value;
  }
  if (!out.type) out.type = "object";
  if (out.type === "object" && !out.properties) out.properties = {};
  return out;
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((p) => p && ["text", "input_text", "output_text"].includes(p.type)).map((p) => String(p.text || "")).join("");
}

/** 一条 assistant tool_call 的真实签名（客户端回传字段 / 本进程缓存） */
function callSignature(call, cache) {
  for (const value of [call?.extra_content?.google?.thought_signature, call?.thought_signature, call?.thoughtSignature]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const id = String(call?.id || "");
  return id && cache?.has(id) ? cache.get(id) : "";
}
/** 工具结果正文 → `functionResponse.response`（Gemini 要求是对象） */
function toolResultValue(text) {
  try {
    const value = JSON.parse(text);
    if (value && typeof value === "object") return value;
    if (value !== null && value !== undefined) return { result: value };
  } catch { /* 非 JSON */ }
  return { result: String(text || "") };
}
/** Claude 的历史轮要以思考块开头（否则多轮必 400）；已有带签名的思考块就不动 */
function ensureClaudeThinking(contents) {
  for (const turn of contents) {
    if (!turn || turn.role !== "model" || !Array.isArray(turn.parts)) continue;
    const first = turn.parts[0];
    const already = first && first.thought === true && typeof first.thoughtSignature === "string" && first.thoughtSignature.trim();
    if (already) continue;
    turn.parts.unshift({ text: CLAUDE_THOUGHT_PLACEHOLDER, thought: true, thoughtSignature: SKIP_SIGNATURE_SENTINEL });
  }
}
/** Gemini / GPT-OSS 的 functionCall 缺签名时补官方哨兵 */
function fillMissingSignatures(contents) {
  for (const turn of contents) {
    if (!turn || turn.role !== "model" || !Array.isArray(turn.parts)) continue;
    for (const part of turn.parts) {
      if (part && part.functionCall && !(typeof part.thoughtSignature === "string" && part.thoughtSignature.trim())) {
        part.thoughtSignature = SKIP_SIGNATURE_SENTINEL;
      }
    }
  }
}

/** Chat → Antigravity 信封 */
function buildEnvelope(input, model, { project = "", enterprise = false, signatureOf = () => "" } = {}) {
  const messages = Array.isArray(input?.messages) ? input.messages : [];
  const system = messages.filter((m) => m && (m.role === "system" || m.role === "developer")).map((m) => textOf(m.content)).filter(Boolean).join("\n\n");
  const contents = [];
  // tool_call_id → 工具名：functionResponse.name 必须与 functionCall 的一致；
  // OpenAI 的 tool 消息只有 tool_call_id，没有 name，不建表就会发出空名字。
  const toolNames = new Map();
  for (const message of messages) {
    if (!message || message.role !== "assistant" || !Array.isArray(message.tool_calls)) continue;
    for (const call of message.tool_calls) {
      const id = String(call && call.id || "").trim();
      const name = String(call && call.function && call.function.name || "").trim();
      if (id && name) toolNames.set(id, name);
    }
  }
  const pushTurn = (role, parts) => {
    if (!parts.length) return;
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  };
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const role = String(message.role || "user");
    if (role === "system" || role === "developer") continue;
    if (role === "tool") {
      const id = String(message.tool_call_id || "");
      const name = toolNames.get(id) || String(message.name || "") || "tool";
      const response = { name, response: toolResultValue(textOf(message.content)) };
      if (id) response.id = id;
      // functionResponse 的 role 必须是 user（上游硬约束）
      pushTurn("user", [{ functionResponse: response }]);
      continue;
    }
    if (role === "assistant") {
      const parts = [];
      const text = textOf(message.content);
      if (text) parts.push({ text });
      for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        if (!call || !call.function) continue;
        let args = {};
        try { args = JSON.parse(String(call.function.arguments || "{}")); } catch { args = {}; }
        if (!args || typeof args !== "object" || Array.isArray(args)) args = {};
        const fn = { name: String(call.function.name || ""), args };
        if (call.id) fn.id = String(call.id);
        const part = { functionCall: fn };
        const signature = callSignature(call, null) || String(signatureOf(call.id) || "");
        if (signature) part.thoughtSignature = signature;
        parts.push(part);
      }
      pushTurn("model", parts);
      continue;
    }
    const parts = [];
    const text = textOf(message.content);
    if (text) parts.push({ text });
    for (const part of Array.isArray(message.content) ? message.content : []) {
      if (part && part.type === "image_url" && part.image_url?.url) {
        const url = String(part.image_url.url);
        const m = /^data:([^;]+);base64,(.*)$/.exec(url);
        if (m) parts.push({ inlineData: { mimeType: m[1], data: m[2] } });
      }
    }
    pushTurn("user", parts);
  }
  if (!contents.length) contents.push({ role: "user", parts: [{ text: "..." }] });
  if (contents[0].role !== "user") contents.unshift({ role: "user", parts: [{ text: "..." }] });
  if (contents[contents.length - 1].role !== "user") contents.push({ role: "user", parts: [{ text: FALLBACK_USER_TEXT }] });
  // 历史签名规则：Claude 每轮要以思考块开头；Gemini / GPT-OSS 的 functionCall 缺签名补哨兵。
  if (/^claude/i.test(String(model || ""))) ensureClaudeThinking(contents);
  else if (/^(gemini|gpt-oss)/i.test(String(model || ""))) fillMissingSignatures(contents);

  const budget = Number(input?.reasoning_budget) > 0 ? Number(input.reasoning_budget) : DEFAULT_THINKING_BUDGET;
  const maxOutput = Math.max(Number(input?.max_tokens) || MAX_OUTPUT_DEFAULT, budget + 8192);
  const request = {
    contents,
    generationConfig: {
      temperature: Number.isFinite(Number(input?.temperature)) ? Number(input.temperature) : 1.0,
      topP: 1.0,
      topK: 40,
      maxOutputTokens: maxOutput,
      thinkingConfig: { includeThoughts: true, thinkingBudget: budget },
    },
    sessionId: String(Math.floor(Math.random() * 2 ** 31) * -1),
  };
  if (system) request.systemInstruction = { role: "user", parts: [{ text: system }] };
  const tools = Array.isArray(input?.tools) ? input.tools.filter((t) => t && t.function && t.function.name) : [];
  const toolChoiceNone = String(input?.tool_choice || "") === "none";
  if (tools.length && !toolChoiceNone) {
    const seen = new Set();
    const declarations = [];
    for (const tool of tools) {
      const name = String(tool.function.name);
      if (seen.has(name)) continue;
      seen.add(name);
      declarations.push({
        name,
        ...(tool.function.description ? { description: String(tool.function.description) } : {}),
        parameters: cleanSchema(tool.function.parameters),
      });
    }
    // 单分组（上游硬约束）
    request.tools = [{ functionDeclarations: declarations }];
    request.toolConfig = { functionCallingConfig: { mode: "VALIDATED" } };
  }
  const envelope = {
    model: String(model || ""),
    userAgent: enterprise ? "jetski" : "antigravity",
    requestId: `agent/${Date.now()}/${crypto.randomBytes(4).toString("hex")}`,
    request,
  };
  if (project) envelope.project = project;
  return envelope;
}

function createAntigravity(settings = {}) {
  const envs = Array.isArray(settings.envs) && settings.envs.length ? settings.envs : V1_ENVS;
  // 工具签名缓存：响应里的 thoughtSignature 按 tool call id 记住，下一轮历史回传时
  // 用它替换官方哨兵。Anthropic 形态的客户端不回传 extra_content，只能靠这张表。
  const signatures = new Map();
  const SIGNATURE_CACHE_MAX = 512;
  const rememberSignature = (id, signature) => {
    if (!id || !signature) return;
    if (signatures.size >= SIGNATURE_CACHE_MAX) signatures.delete(signatures.keys().next().value);
    signatures.set(String(id), String(signature));
  };
  const signatureOf = (id) => id && signatures.has(String(id)) ? signatures.get(String(id)) : "";
  return {
    id: "antigravity", channels: ["antigravity"], requiredFeatures: ["execution-facts@1"],
    async listModels(request, ctx) {
      if (!request.grantId) return [];
      const context = await ctx.pool.context();
      const models = (context.models || []).map(descriptor);
      return models.length ? models : STATIC_MODELS.map(([id, name]) => ({ id, name }));
    },
    async *invoke(request, ctx) {
      const credentials = await ctx.pool.credentials();
      const token = String(credentials?.token || "").trim();
      if (!token) throw fail(401, "AUTH_REQUIRED", "Antigravity 凭据缺失", "account");
      const envelope = buildEnvelope(request.input, request.model, { project: String(credentials?.project || ""), enterprise: credentials?.enterprise === true, signatureOf });
      const ua = sanitizeUserAgent();
      let response = null;
      let lastError = null;
      // 环境顺序：sandbox → daily → prod（聊天优先前两个以规避 prod 的 429）
      for (const env of envs) {
        try {
          response = await ctx.pool.network().fetch(`${v1Base(env)}:streamGenerateContent?alt=sse`, {
            method: "POST", redirect: "error", signal: ctx.signal,
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
              accept: "text/event-stream",
              "user-agent": ua,
              // 明确不发 x-goog-api-client（官方客户端出口不发）
            },
            body: JSON.stringify(envelope),
          });
        } catch (error) {
          if (ctx.signal?.aborted) throw fail(504, "UPSTREAM_TIMEOUT", "Antigravity 请求已取消或超时");
          lastError = classify(502, error?.message);
          continue;
        }
        if (response.ok) break;
        const detail = await errorDetail(response).catch(() => "");
        lastError = classify(response.status, detail);
        // 只有 429/5xx 才换环境重试；401/400 换环境也一样
        if (!(response.status === 429 || response.status >= 500)) break;
      }
      if (!response || !response.ok) throw lastError || fail(502, "UPSTREAM_FAILED", "Antigravity 模型执行失败");
      await ctx.attempts?.report({ state: "responded", actualModel: String(request.model || "") });
      let contentSeen = false;
      let finishReason = "stop";
      let usage = null;
      const toolCalls = [];
      try {
        for await (const raw of sse(response, ctx.signal)) {
          if (!raw || raw === "[DONE]") continue;
          let frame;
          try { frame = JSON.parse(raw); } catch { continue; }
          // 信封：缺省回退顶层
          const payload = frame && frame.response ? frame.response : frame;
          if (!payload || typeof payload !== "object") continue;
          if (payload.error) throw classify(Number(payload.error.code) === 429 ? 429 : 502, JSON.stringify(payload.error));
          const candidate = Array.isArray(payload.candidates) ? payload.candidates[0] : null;
          const parts = candidate?.content?.parts;
          if (Array.isArray(parts)) {
            for (const part of parts) {
              if (!part || typeof part !== "object") continue;
              if (typeof part.text === "string" && part.text) {
                if (part.thought === true) yield { type: "delta", delta: { reasoning_content: part.text } };
                else { contentSeen = true; yield { type: "delta", delta: { content: part.text } }; }
              }
              if (part.functionCall) {
                const id = String(part.functionCall.id || `call_${crypto.randomUUID().slice(0, 8)}`);
                const signature = typeof part.thoughtSignature === "string" ? part.thoughtSignature : "";
                if (signature) rememberSignature(id, signature);
                toolCalls.push({
                  id, signature,
                  name: String(part.functionCall.name || ""),
                  arguments: JSON.stringify(part.functionCall.args || {}),
                });
              }
            }
          }
          if (candidate?.finishReason) {
            const reason = String(candidate.finishReason);
            finishReason = /MAX_TOKENS/i.test(reason) ? "length" : "stop";
          }
          if (payload.usageMetadata) {
            const u = payload.usageMetadata;
            usage = {
              prompt_tokens: Number(u.promptTokenCount) || 0,
              completion_tokens: Number(u.candidatesTokenCount) || 0,
              total_tokens: Number(u.totalTokenCount) || (Number(u.promptTokenCount) || 0) + (Number(u.candidatesTokenCount) || 0),
            };
          }
        }
        let index = 0;
        for (const call of toolCalls) {
          if (!call.name) continue;
          yield { type: "delta", delta: { tool_calls: [{
            index: index++, id: call.id, type: "function",
            function: { name: call.name, arguments: call.arguments },
            // 上游签名随 tool_call 带回客户端：流式客户端会原样放进下一轮历史，
            // 非流式由网关聚合器保留；两条路都能让下一轮 functionCall 带上真签名。
            ...(call.signature ? { extra_content: { google: { thought_signature: call.signature } } } : {}),
          }] } };
          contentSeen = true;
        }
        if (usage) yield { type: "usage", mode: "snapshot", usage };
        if (!contentSeen) throw fail(502, "EMPTY_UPSTREAM_RESPONSE", "Antigravity 返回空响应");
        yield { type: "finish", reason: toolCalls.length ? "tool_calls" : finishReason };
      } finally {
        try { await response.body?.cancel(); } catch { /* 已关闭 */ }
      }
    },
  };
}

module.exports = { createAntigravity, buildEnvelope, cleanSchema, classify, sanitizeUserAgent, v1Base, STATIC_MODELS, V1_ENVS };
