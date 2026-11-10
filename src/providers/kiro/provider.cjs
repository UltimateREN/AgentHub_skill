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
// Kiro（kiro.dev / AWS AI IDE）：**会话 JSON + AWS event stream（二进制帧）**。
// 依据 Agent2Providers `kiro/eventstream.rs` 与 `events.rs` 模块头。
//
// ── AWS event stream 帧结构 ──────────────────────────────────
//   [0..4)   total length（含所有字段）
//   [4..8)   headers length
//   [8..12)  prelude CRC（不校验）
//   [12..12+headers)
//   [..total-4) payload
//   [total-4..total) message CRC（不校验）
// 每个 header 是 `名称长度(1) 名称 类型(1) 值`：
//   0=true / 1=false（无字节）、2=byte、3=short、4=int、5=long、8=timestamp、
//   9=uuid、6=bytes（2 字节长度）、7=string（2 字节长度）。
// 我们只关心类型 7 的字符串：`:message-type` / `:event-type` / `:exception-type` / `:error-code`。
//
// ── 纯 JS 实现，不引新依赖（红线）──────────────────────────────
"use strict";
const crypto = require("node:crypto");
const os = require("node:os");
const { descriptor } = require("../../model-descriptor.cjs");
const { forwardError } = require("../../../sdk/provider-protocol.cjs");

const RUNTIME_BASE = "https://runtime.{region}.kiro.dev";
const STATIC_MODELS = [
  ["auto", "Auto"],
  ["claude-sonnet-4.5", "Claude Sonnet 4.5"], ["claude-haiku-4.5", "Claude Haiku 4.5"],
  ["claude-opus-4.1", "Claude Opus 4.1"], ["deepseek-v3.2", "DeepSeek V3.2"],
  ["glm-5", "GLM-5"], ["kimi-k2.5", "Kimi K2.5"], ["minimax-m2.5", "MiniMax M2.5"],
  ["qwen3-coder", "Qwen3-Coder"],
];

function fail(status, code, message, scope = "invocation", retryable = false) {
  return forwardError({
    code, message: String(message || "Kiro 模型执行失败").slice(0, 1024),
    category: code === "AUTH_REQUIRED" ? "auth" : code === "RATE_LIMITED" ? "rate" : "upstream",
    scope, replay: "unknown", retryable,
    status: status >= 400 && status <= 599 ? status : 502,
  });
}
function classify(status, detail) {
  const text = String(detail || "").slice(0, 2048);
  if (status === 401 || status === 403) return fail(401, "AUTH_REQUIRED", "Kiro 凭据被拒，请重新登录", "account");
  if (/ThrottlingException|TooManyRequests/i.test(text)) return fail(429, "RATE_LIMITED", "Kiro 上游限流", "account", true);
  if (/ServiceUnavailable|InternalServer/i.test(text)) return fail(503, "TEMPORARILY_UNAVAILABLE", "Kiro 上游暂不可用", "service", true);
  if (status === 429) return fail(429, "RATE_LIMITED", "Kiro 上游限流", "account", true);
  if (status === 400 || status === 422) return fail(400, "INVALID_REQUEST", "Kiro 拒绝了该请求（参数不合法）");
  return fail(status >= 400 && status <= 599 ? status : 502, "UPSTREAM_FAILED", "Kiro 模型执行失败", "invocation", status >= 500);
}

function ideUserAgent() {
  const hex = crypto.createHash("sha256").update(`agenthub:${os.hostname()}`).digest("hex");
  return `KiroIDE-1.1.70-${hex}`;
}

/** 解析一个 AWS event stream 帧头（返回 null 表示数据还不够一帧） */
function readFrame(buffer) {
  if (buffer.length < 12) return null;
  const total = buffer.readUInt32BE(0);
  const headersLength = buffer.readUInt32BE(4);
  if (total < 16 || total > 16 * 1024 * 1024) throw new Error("AWS event stream 帧长度非法");
  if (buffer.length < total) return null;
  const headerEnd = 12 + headersLength;
  const headers = {};
  let offset = 12;
  while (offset < headerEnd) {
    const nameLength = buffer.readUInt8(offset);
    offset += 1;
    const name = buffer.subarray(offset, offset + nameLength).toString("utf8");
    offset += nameLength;
    const type = buffer.readUInt8(offset);
    offset += 1;
    let value = "";
    if (type === 0) value = true;
    else if (type === 1) value = false;
    else if (type === 2) { value = buffer.readInt8(offset); offset += 1; }
    else if (type === 3) { value = buffer.readInt16BE(offset); offset += 2; }
    else if (type === 4) { value = buffer.readInt32BE(offset); offset += 4; }
    else if (type === 5) { value = Number(buffer.readBigInt64BE(offset)); offset += 8; }
    else if (type === 8) { value = Number(buffer.readBigInt64BE(offset)); offset += 8; }
    else if (type === 9) { value = buffer.subarray(offset, offset + 16).toString("hex"); offset += 16; }
    else if (type === 6) { const len = buffer.readUInt16BE(offset); offset += 2; value = buffer.subarray(offset, offset + len).toString("hex"); offset += len; }
    else if (type === 7) { const len = buffer.readUInt16BE(offset); offset += 2; value = buffer.subarray(offset, offset + len).toString("utf8"); offset += len; }
    else throw new Error(`AWS event stream 头类型未知：${type}`);
    headers[name] = value;
  }
  const payload = buffer.subarray(headerEnd, total - 4);
  return {
    frame: {
      messageType: String(headers[":message-type"] || ""),
      eventType: String(headers[":event-type"] || ""),
      exceptionType: String(headers[":exception-type"] || ""),
      errorCode: String(headers[":error-code"] || ""),
      payload,
    },
    rest: buffer.subarray(total),
  };
}
function frameIsError(frame) {
  return frame.messageType === "exception" || frame.messageType === "error"
    || ["error", "throttlingError", "validationError", "serviceUnavailableError", "internalServerException"].includes(frame.eventType);
}
function frameErrorText(frame) {
  const text = frame.payload.toString("utf8");
  try {
    const value = JSON.parse(text);
    return String(value.message || value.Message || value.errorMessage || text).slice(0, 512);
  } catch { return text.slice(0, 512); }
}

/* ── 请求构造（对照 Agent2Providers kiro/request.rs）────────────────────
 * Kiro 的会话模型与 OpenAI Chat 不是一一对应，几条硬规则都在上游 400 里踩出来：
 *   1. 首尾必须是 userInputMessage：开头的 assistant / 只有工具结果的 user 会被删掉，
 *      结尾是 assistant 时补一条空 user；
 *   2. 每个 tool call 必须有 result：缺的补一条 error 结果，多出来的丢掉；
 *   3. 工具名只收 [a-zA-Z0-9_-]{1,64}，toolUseId 只收 [a-zA-Z0-9_.:-]{1,64}；
 *   4. 工具参数 schema 的根必须是 object；
 *   5. 只带最新一组图片（历史旧图每轮重传会白烧额度）；
 *   6. 空消息用 "Please proceed with the task."。
 * 不做这些归一，带工具的 Coding Agent 第二轮就会被上游拒。 */
const PROCEED = "Please proceed with the task.";
const NO_RESULT = "Tool use was interrupted and did not produce a result.";
const RESULT_LIMIT = 250000;

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part && ["text", "input_text", "output_text"].includes(part.type))
    .map((part) => String(part.text || "")).join("\n\n");
}
function joinNonEmpty(left, right) {
  if (!left) return right;
  if (!right) return left;
  return `${left}\n\n${right}`;
}
function toolName(name) {
  const text = String(name || "");
  if (/^[A-Za-z0-9_-]{1,64}$/.test(text)) return text;
  const hash = crypto.createHash("sha256").update(text).digest("hex").slice(0, 12);
  const head = text.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64 - 1 - hash.length);
  return `${head}_${hash}`;
}
function toolId(id) {
  const text = String(id || "");
  if (/^[A-Za-z0-9_.:-]{1,64}$/.test(text)) return text;
  const hash = crypto.createHash("sha256").update(text).digest("base64url").slice(0, 32);
  return `t_${hash}`;
}
function argumentsValue(raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try { const parsed = JSON.parse(raw); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed; } catch { /* 非法 JSON → 空对象 */ }
  }
  return {};
}
function inputSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return { type: "object", properties: {} };
  if (!Object.keys(schema).length) return { type: "object", properties: {} };
  if (schema.type === undefined) return { type: "object", ...schema };
  if (Array.isArray(schema.type)) {
    const nullableObject = schema.type.length > 0 && schema.type.every((kind) => kind === "object" || kind === "null");
    if (nullableObject) return { ...schema, type: "object" };
  }
  return schema;
}
/** data URL → { format, bytes }；只发内联 base64（外链图没有字节可发） */
function splitDataUrl(url) {
  const text = String(url || "");
  if (!text.startsWith("data:")) return null;
  const comma = text.indexOf(",");
  if (comma < 0) return null;
  const meta = text.slice(5, comma);
  if (!/;base64/i.test(meta)) return null;
  const media = meta.split(";")[0] || "image/png";
  const raw = media.startsWith("image/") ? media.slice(6) : "png";
  const format = ["jpg", "jpeg"].includes(raw.toLowerCase()) ? "jpeg"
    : ["webp", "gif", "png"].includes(raw.toLowerCase()) ? raw.toLowerCase() : "png";
  const bytes = text.slice(comma + 1);
  return bytes ? { format, bytes } : null;
}
function pushImage(images, url) {
  const parsed = splitDataUrl(url);
  if (!parsed) return;
  // 上游的 Base64 上限 5 MiB：超了先试纯 JS 缩图（仅 PNG），失败/非 PNG 才跳过。
  // 缩图是尽力而为，任何异常都不该打断对话 —— fitImage 内部已兜住并回 null。
  const fitted = require("./image-fit.cjs").fitImage(parsed);
  if (!fitted) return;
  images.push({ format: fitted.format, source: { bytes: fitted.bytes } });
}

/** 会话 JSON：messages → conversationState（history + currentMessage） */
function buildConversation(input, model, profileArn) {
  const messages = Array.isArray(input?.messages) ? input.messages : [];
  const systemParts = [];
  const entries = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const role = String(message.role || "user");
    if (role === "system" || role === "developer") {
      const text = contentText(message.content);
      if (text.trim()) systemParts.push(text);
      continue;
    }
    if (role === "assistant") {
      const assistant = { content: contentText(message.content), toolUses: [] };
      for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        const fn = call && call.function ? call.function : {};
        const name = String(fn.name || "");
        if (!name) continue;
        assistant.toolUses.push({
          name: toolName(name),
          toolUseId: toolId(call.id || name),
          input: argumentsValue(fn.arguments),
        });
      }
      if (!assistant.content && !assistant.toolUses.length) continue;
      const previous = entries[entries.length - 1];
      if (previous && previous.assistant) {
        previous.assistant.content = joinNonEmpty(previous.assistant.content, assistant.content);
        previous.assistant.toolUses.push(...assistant.toolUses);
      } else {
        entries.push({ assistant });
      }
      continue;
    }
    // user / tool 都归成一条 userInputMessage
    const user = { content: "", images: [], toolResults: [], tools: [], modelId: model };
    if (role === "tool") {
      const callId = String(message.tool_call_id || "");
      let output = contentText(message.content);
      if (!output) output = "(no output)";
      if (output.length > RESULT_LIMIT) output = `${output.slice(0, RESULT_LIMIT)}\n… (cut)`;
      user.toolResults.push({
        toolUseId: toolId(callId),
        status: message.is_error === true ? "error" : "success",
        content: [{ text: output }],
      });
      if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part && part.type === "image_url" && part.image_url?.url) pushImage(user.images, part.image_url.url);
        }
      }
    } else {
      user.content = contentText(message.content);
      if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (!part || typeof part !== "object") continue;
          if (part.type === "image_url" && part.image_url?.url) pushImage(user.images, part.image_url.url);
          else if (part.type === "input_image" && part.image_url) pushImage(user.images, part.image_url);
        }
      }
    }
    const previous = entries[entries.length - 1];
    if (previous && previous.user) {
      previous.user.content = joinNonEmpty(previous.user.content, user.content);
      previous.user.images.push(...user.images);
      previous.user.toolResults.push(...user.toolResults);
    } else {
      entries.push({ user });
    }
  }

  // 首条必须是 user；开头的 assistant 与「只有工具结果」的 user 删掉。
  while (entries.length && !entries[0].user) entries.shift();
  while (entries.length && entries[0].user && entries[0].user.content === "" && entries[0].user.toolResults.length) entries.shift();
  if (entries[0]?.user) entries[0].user.toolResults = [];
  // 末条必须是 user（它是要被回答的那条）。
  if (!entries.length || !entries[entries.length - 1].user) {
    entries.push({ user: { content: "", images: [], toolResults: [], tools: [], modelId: model } });
  }

  // 工具调用与结果配对：缺的补 error，多出来的丢掉。
  for (let index = 1; index < entries.length; index++) {
    const user = entries[index].user;
    if (!user) continue;
    const calls = entries[index - 1]?.assistant?.toolUses || [];
    const answered = new Set();
    const kept = [];
    for (const result of user.toolResults) {
      if (!answered.has(result.toolUseId) && calls.some((call) => call.toolUseId === result.toolUseId)) {
        answered.add(result.toolUseId);
        kept.push(result);
      }
    }
    for (const call of calls) {
      if (!answered.has(call.toolUseId)) {
        answered.add(call.toolUseId);
        kept.push({ toolUseId: call.toolUseId, status: "error", content: [{ text: NO_RESULT }] });
      }
    }
    user.toolResults = kept;
  }

  // 空消息补一句（Kiro 拒绝空 content）。
  for (const entry of entries) {
    if (entry.user && !entry.user.content && !entry.user.toolResults.length) entry.user.content = PROCEED;
  }
  // 只保留最新一组图片。
  let latestImages = -1;
  entries.forEach((entry, index) => { if (entry.user && entry.user.images.length) latestImages = index; });
  entries.forEach((entry, index) => { if (entry.user && index !== latestImages) entry.user.images = []; });

  // 指令 + 结构化输出 + 思考预算：拼到第一条 user 正文前（Kiro 不收 systemPrompt 字段）。
  let system = systemParts.join("\n\n");
  const format = input?.response_format || input?.output_format;
  if (format && typeof format === "object") {
    if (format.type === "json_object") system = joinNonEmpty(system, "Respond with a single JSON object and nothing else.");
    else {
      const schema = format.json_schema?.schema || format.schema;
      if (schema && typeof schema === "object") system = joinNonEmpty(system, `Respond with a single JSON value and nothing else, matching this JSON schema:\n${JSON.stringify(schema)}.`);
    }
  }
  const effort = String(input?.reasoning_effort || input?.reasoning?.effort || "");
  const budgetFromEffort = { low: 10000, medium: 20000, high: 30000, xhigh: 50000, max: 50000 }[effort] || 0;
  const budget = budgetFromEffort || Math.min(Math.max(Number(input?.thinking?.budget_tokens) || 0, 0), 50000);
  if (budget > 0 && /claude|think|auto/i.test(model)) {
    system = joinNonEmpty(`<thinking_mode>enabled</thinking_mode><max_thinking_length>${budget}</max_thinking_length>`, system);
  }
  if (system && entries[0]?.user) entries[0].user.content = `${system}\n\n${entries[0].user.content}`;

  // 工具声明：本次给的 + 历史里用到但这次没给的（Kiro 会拒绝未知工具）。
  const tools = [];
  const offered = new Set();
  for (const tool of Array.isArray(input?.tools) ? input.tools : []) {
    const fn = tool && tool.function ? tool.function : tool;
    const name = String(fn?.name || "");
    if (!name) continue;
    const mapped = toolName(name);
    if (offered.has(mapped)) continue;
    offered.add(mapped);
    tools.push({ toolSpecification: {
      name: mapped,
      description: String(fn.description || name),
      inputSchema: { json: inputSchema(fn.parameters || fn.input_schema) },
    } });
  }
  for (const entry of entries) {
    for (const call of entry.assistant?.toolUses || []) {
      if (offered.has(call.name)) continue;
      offered.add(call.name);
      tools.push({ toolSpecification: { name: call.name, description: "Tool", inputSchema: { json: { type: "object", properties: {} } } } });
    }
  }
  const current = entries[entries.length - 1].user;
  if (tools.length) current.tools = tools;

  const toUser = (user) => {
    const object = { content: user.content, modelId: user.modelId || model, origin: "KIRO_CLI" };
    if (user.images.length) object.images = user.images;
    const context = {};
    if (user.tools.length) context.tools = user.tools;
    if (user.toolResults.length) context.toolResults = user.toolResults;
    if (Object.keys(context).length) object.userInputMessageContext = context;
    return object;
  };
  const history = [];
  for (const entry of entries.slice(0, -1)) {
    if (entry.user) history.push({ userInputMessage: toUser(entry.user) });
    else if (entry.assistant) {
      const value = { content: entry.assistant.content };
      if (entry.assistant.toolUses.length) value.toolUses = entry.assistant.toolUses;
      history.push({ assistantResponseMessage: value });
    }
  }
  const state = {
    chatTriggerType: "MANUAL",
    agentTaskType: "vibe",
    conversationId: crypto.randomUUID(),
    currentMessage: { userInputMessage: toUser(current) },
  };
  if (history.length) state.history = history;
  const out = { conversationState: state, agentMode: "vibe" };
  if (profileArn) out.profileArn = profileArn;
  return out;
}

function createKiro(settings = {}) {
  const runtimeTemplate = String(settings.runtimeBase || RUNTIME_BASE);
  return {
    id: "kiro", channels: ["kiro"], requiredFeatures: ["execution-facts@1"],
    async listModels(request, ctx) {
      if (!request.grantId) return [];
      const context = await ctx.pool.context();
      const models = (context.models || []).map(descriptor);
      return models.length ? models : STATIC_MODELS.map(([id, name]) => ({ id, name }));
    },
    async *invoke(request, ctx) {
      const credentials = await ctx.pool.credentials();
      const token = String(credentials?.token || "").trim();
      if (!token) throw fail(401, "AUTH_REQUIRED", "Kiro 凭据缺失", "account");
      const region = String(credentials?.region || "us-east-1");
      const profileArn = String(credentials?.profileArn || "");
      const model = String(request.model || "").trim();
      const body = buildConversation(request.input, model, profileArn);
      const url = `${runtimeTemplate.replace("{region}", region)}/generateAssistantResponse`;
      let response;
      try {
        await ctx.attempts?.report({ state: "planned", actualModel: model });
        response = await ctx.pool.network().fetch(url, {
          method: "POST", redirect: "error", signal: ctx.signal,
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            accept: "application/vnd.amazon.eventstream",
            "user-agent": ideUserAgent(),
          },
          body: JSON.stringify(body),
        });
        await ctx.attempts?.report({ state: "responded", actualModel: model });
      } catch (error) {
        if (ctx.signal?.aborted) throw fail(504, "UPSTREAM_TIMEOUT", "Kiro 请求已取消或超时");
        throw classify(502, error?.message);
      }
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw classify(response.status, text);
      }
      const reader = response.body.getReader();
      let buffer = Buffer.alloc(0);
      let contentSeen = false;
      let finishReason = "stop";
      let usage = null;
      // toolUseEvent 是**增量**流：同一 toolUseId 先来一条带 name 的宣告帧，
      // 后续帧只带 input 的片段。整帧当成完整工具调用会得到 N 个重复调用。
      let toolIndex = -1;
      let currentTool = "";
      let toolSeen = false;
      try {
        while (true) {
          if (ctx.signal?.aborted) break;
          const { done, value } = await reader.read();
          if (done) break;
          buffer = Buffer.concat([buffer, Buffer.from(value)]);
          while (true) {
            let parsed;
            try { parsed = readFrame(buffer); } catch (error) { throw fail(502, "INVALID_EVENT_STREAM", String(error.message || error)); }
            if (!parsed) break;
            buffer = parsed.rest;
            const frame = parsed.frame;
            if (frameIsError(frame)) throw classify(502, `${frame.exceptionType || frame.errorCode || frame.eventType}：${frameErrorText(frame)}`);
            if (!frame.payload.length) continue;
            let value;
            try { value = JSON.parse(frame.payload.toString("utf8")); } catch { continue; }
            switch (frame.eventType) {
              case "assistantResponseEvent": {
                const text = String(value.content || "");
                if (text) { contentSeen = true; yield { type: "delta", delta: { content: text } }; }
                break;
              }
              case "reasoningContentEvent": {
                const text = String(value.text || "");
                if (text) yield { type: "delta", delta: { reasoning_content: text } };
                break;
              }
              case "toolUseEvent": {
                const id = String(value.toolUseId || "");
                const name = String(value.name || "");
                if (id && id !== currentTool) {
                  currentTool = id;
                  toolIndex += 1;
                  toolSeen = true;
                  yield { type: "delta", delta: { tool_calls: [{
                    index: toolIndex, id, type: "function",
                    function: { name: name || "tool", arguments: "" },
                  }] } };
                }
                if (value.input !== undefined && value.input !== null) {
                  // input 可能是 JSON 片段字符串（流式）或完整对象（非流式兜底）
                  const text = typeof value.input === "string"
                    ? value.input
                    : Object.keys(value.input || {}).length ? JSON.stringify(value.input) : "";
                  if (text && toolIndex >= 0) {
                    yield { type: "delta", delta: { tool_calls: [{ index: toolIndex, function: { arguments: text } }] } };
                    contentSeen = true;
                  }
                }
                break;
              }
              case "metadataEvent":
              case "messageMetadataEvent": {
                if (value.stopReason) {
                  const reason = String(value.stopReason);
                  finishReason = /tool/i.test(reason) ? "tool_calls" : /max_tokens|context/i.test(reason) ? "length" : "stop";
                }
                if (value.tokenUsage && typeof value.tokenUsage === "object") {
                  const u = value.tokenUsage;
                  // 参考实现：uncachedInputTokens 只有 >0 才用，否则回落 inputTokens
                  // （用 `??` 会在 uncached=0 时把整段输入记成 0）。
                  const uncached = Number(u.uncachedInputTokens) || 0;
                  const inputTokens = uncached > 0 ? uncached : Number(u.inputTokens) || 0;
                  usage = {
                    prompt_tokens: inputTokens,
                    completion_tokens: Number(u.outputTokens) || 0,
                    total_tokens: inputTokens + (Number(u.outputTokens) || 0),
                  };
                }
                break;
              }
              case "contextUsageEvent": {
                // 上游通常只给百分比；不拿它编 token 数（宁缺勿错）
                break;
              }
              default:
                break;
            }
          }
        }
        try { await reader.cancel(); } catch { /* 已关闭 */ }
        if (usage) yield { type: "usage", mode: "snapshot", usage };
        if (!contentSeen && !toolSeen) throw fail(502, "EMPTY_UPSTREAM_RESPONSE", "Kiro 返回空响应");
        yield { type: "finish", reason: toolSeen ? "tool_calls" : finishReason };
      } finally {
        try { await response.body?.cancel(); } catch { /* 已关闭 */ }
      }
    },
  };
}

module.exports = { createKiro, buildConversation, readFrame, frameIsError, STATIC_MODELS, RUNTIME_BASE };
