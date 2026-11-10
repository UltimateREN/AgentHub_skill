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
// Command Code（api.commandcode.ai）执行器：**无状态转发 + 粘贴式 API Key**。
// 依据 Agent2Providers `crates/providers/src/providers/commandcode/`（endpoints.rs /
// credentials.rs / models.rs / plan.rs / mod.rs 模块头）与 Agent2API
// `core/protocol/ai_sdk_ndjson.rs`（NDJSON 事件词表）。
//
// ── 上游三处硬事实 ────────────────────────────────────────────
//   1. 生成走 `POST /alpha/generate`，请求体是**自有 8 键信封**
//      （config / memory / taste / skills / permissionMode / [threadId] / mode / params），
//      不是 OpenAI 的 {model, messages}；
//   2. 响应是 **NDJSON**（一行一个 JSON 事件），且 **HTTP 恒 200** ——
//      认证失败 / 限流 / 余额不足都在流内 `{"type":"error"}` 表达；
//   3. 发正式请求前先上报「设备指纹 + 生命周期」两条预请求（best-effort，失败不影响）。
//
// ── 本家没有的东西（如实声明）──────────────────────────────────
//   · 没有续期（静态 key）、没有网页登录、不做签到、不查余额。
"use strict";
const crypto = require("node:crypto");
const { descriptor } = require("../../model-descriptor.cjs");
const { errorDetail } = require("../../network/sse.cjs");
const { forwardError } = require("../../../sdk/provider-protocol.cjs");

const BASE_URL = "https://api.commandcode.ai";
/** 已实现的 wire 协议版本（自称值必须与代码里的字段形状一致，不写 npm 最新版） */
const PROTOCOL_VERSION = "1.53.1";
const CLI_USER_AGENT = "cli";
const CLI_ENVIRONMENT = "production";
const DEFAULT_MODEL = "deepseek/deepseek-v4-flash";
const DEFAULT_MAX_TOKENS = 64000;
const MAX_TOKENS_CAP = 200000;
const MIN_SESSION_ID_LENGTH = 8;
/** 固定项目目录：真机 cwd 会泄露宿主路径，且逐请求变化会破坏前缀缓存 */
const DEVICE_PROJECT_DIR = "C:\\Users\\dev\\projects\\app";
const DEVICE_PLATFORM = "win32";
/** 内容拦截文案（命中按 ContentBlocked 处理：不罚账号） */
const CONTENT_BLOCK_RE = /blocked by security policy|unapproved channel|illegal api invocation/i;
/** 体积超限的假成功：HTTP 429 + 81113（必须先于限流判掉，折成 413） */
const TOO_LARGE_CODE = 81113;

/** 内置兜底清单（models.rs FALLBACK_MODELS，26 项） */
const FALLBACK_MODELS = [
  ["claude-sonnet-4-6", "Claude Sonnet 4.6"], ["claude-opus-4-8", "Claude Opus 4.8"],
  ["claude-opus-4-7", "Claude Opus 4.7"], ["claude-haiku-4-5-20251001", "Claude Haiku 4.5"],
  ["gpt-5.5", "GPT-5.5"], ["gpt-5.4", "GPT-5.4"], ["gpt-5.4-mini", "GPT-5.4 Mini"],
  ["gpt-5.3-codex", "GPT-5.3 Codex"],
  ["deepseek/deepseek-v4-pro", "DeepSeek V4 Pro"], ["deepseek/deepseek-v4-flash", "DeepSeek V4 Flash"],
  ["moonshotai/Kimi-K2.6", "Kimi K2.6"], ["moonshotai/Kimi-K2.5", "Kimi K2.5"],
  ["zai-org/GLM-5.1", "GLM 5.1"], ["zai-org/GLM-5", "GLM 5"],
  ["MiniMaxAI/MiniMax-M3", "MiniMax M3"], ["MiniMaxAI/MiniMax-M2.7", "MiniMax M2.7"],
  ["MiniMaxAI/MiniMax-M2.5", "MiniMax M2.5"],
  ["Qwen/Qwen3.6-Max-Preview", "Qwen 3.6 Max Preview"], ["Qwen/Qwen3.6-Plus", "Qwen 3.6 Plus"],
  ["Qwen/Qwen3.7-Max", "Qwen 3.7 Max"],
  ["stepfun/Step-3.7-Flash", "Step 3.7 Flash"], ["stepfun/Step-3.5-Flash", "Step 3.5 Flash"],
  ["xiaomi/mimo-v2.5-pro", "MiMo V2.5 Pro"], ["xiaomi/mimo-v2.5", "MiMo V2.5"],
  ["google/gemini-3.5-flash", "Gemini 3.5 Flash"], ["google/gemini-3.1-flash-lite", "Gemini 3.1 Flash Lite"],
];

function fail(status, code, message, scope = "invocation", retryable = false) {
  return forwardError({
    code, message: String(message || "Command Code 模型执行失败").slice(0, 1024),
    category: code === "AUTH_REQUIRED" ? "auth" : code === "QUOTA_EXHAUSTED" ? "quota"
      : code === "RATE_LIMITED" ? "rate" : "upstream",
    scope, replay: "unknown", retryable,
    status: status >= 400 && status <= 599 ? status : 502,
  });
}

/** 上游错误事件 → 本机错误。状态码映射照抄 ai_sdk_ndjson.rs 的 map_upstream_status：
 *  402（付费失败）→ 429 让下游退避；403（权限/风控）→ 401 让上层换账号。 */
function classify(status, detail) {
  const text = String(detail || "").slice(0, 2048);
  // 体积超限的假成功：HTTP 429 + 81113 → 折成 413（请求级，不冷却账号）
  if (/\b81113\b/.test(text)) return fail(413, "REQUEST_TOO_LARGE", "请求体积超过上游上限（Command Code 81113），请缩短上下文后重试");
  if (CONTENT_BLOCK_RE.test(text)) return fail(400, "CONTENT_BLOCKED", "内容被上游安全策略拦截（不扣账号配额）", "invocation", false);
  if (status === 400 || status === 422) return fail(400, "INVALID_REQUEST", "Command Code 拒绝了该请求（参数不合法）");
  if (status === 401 || status === 403) return fail(401, "AUTH_REQUIRED", "Command Code API Key 无效或已被吊销", "account");
  if (status === 402) return fail(429, "QUOTA_EXHAUSTED", "Command Code 余额不足（按限流处置）", "account", true);
  if (status === 404) return fail(404, "NOT_FOUND", "Command Code 端点不存在（上游可能已改版）");
  if (status === 429) return fail(429, "RATE_LIMITED", "Command Code 上游限流", "account", true);
  if (status === 503) return fail(503, "TEMPORARILY_UNAVAILABLE", "Command Code 上游暂不可用", "service", true);
  return fail(status >= 400 && status <= 599 ? status : 502, "UPSTREAM_FAILED", "Command Code 模型执行失败", "invocation", status >= 500);
}

/** 真值判定（与网关 protocol::is_truthy 同口径） */
function isTruthy(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value.length > 0;
  return true;
}
function hasCacheControl(block) {
  return !!(block && typeof block === "object" && isTruthy(block.cache_control));
}

/** 会话标识：客户端头 → session_id → prompt_cache_key（≥8）→ 按内容派生 UUID */
function sessionIdOf(model, systemBlocks, messages, input, headers, apiKey) {
  const header = (name) => String(headers?.[name] || "").trim();
  for (const name of ["x-session-id", "x-claude-code-session-id"]) {
    const value = header(name);
    if (value) return value;
  }
  const fromBody = String(input?.session_id || "").trim();
  if (fromBody) return fromBody;
  const cacheKey = String(input?.prompt_cache_key || "").trim();
  if (cacheKey.length >= MIN_SESSION_ID_LENGTH) return cacheKey;
  // 派生：sha1(key\0model\0system 各块文本\0首个非 user 消息之前的连续 user 文本\0)
  // key 必须是**上游 API Key**，不是客户端打到本网关的 Authorization——后者是网关
  // 自己的密钥，会让同一网关 Key 下的所有会话被派生成同一个 threadId。
  const userPrefix = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== "object") continue;
    if (String(message.role || "") !== "user") break;
    userPrefix.push(textOf(message.content));
  }
  const seed = [
    String(apiKey || ""),
    String(model || ""),
    systemBlocks.map((block) => String(block.text || "")).join("\u0000"),
    userPrefix.join("\u0000"),
    "",
  ].join("\u0000");
  const digest = crypto.createHash("sha1").update(seed).digest();
  // 前 16 字节 + 置 UUID 版本位（v5 形态）后格式化
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function isWireUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ""));
}
function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part && ["text", "input_text", "output_text"].includes(part.type))
    .map((part) => String(part.text || "")).join("");
}

/** 任意值 → 文本（与参考实现 string_value 同口径） */
function stringValue(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try { return JSON.stringify(value); } catch { return String(value); }
}
/** data:<mime>;base64,… → mime（不是 data URL 时为空） */
function dataUrlMime(url) {
  const text = String(url || "");
  if (!text.startsWith("data:")) return "";
  const rest = text.slice(5);
  const hit = rest.search(/[;]/);
  if (hit < 0) return "";
  return rest.slice(0, hit).trim();
}
/** user 内容 → 块数组（字符串转 text 块；image_url → CC 的 image 块） */
function userContent(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content)) {
    return content.filter((part) => part && typeof part === "object").map((part) => {
      if (part.type === "image_url") {
        const url = String(part.image_url?.url || "");
        const block = { type: "image", image: url };
        const mime = dataUrlMime(url);
        if (mime) block.mimeType = mime;
        return block;
      }
      return part;
    });
  }
  if (content != null) return [{ type: "text", text: stringValue(content) }];
  return [];
}
/** assistant 内容 → 块数组。次序是硬要求：`[reasoning, text, tool-call]`——
 *  CC 在思考模式下会校验 reasoning 是否随历史回传，丢弃或换序会让多轮直接失败。 */
function assistantContent(message) {
  const parts = [];
  const reasoning = message && message.reasoning_content;
  const hasReasoning = typeof reasoning === "string" ? reasoning.length > 0
    : reasoning != null && reasoning !== false && reasoning !== 0 && reasoning !== "";
  if (hasReasoning) parts.push({ type: "reasoning", text: stringValue(reasoning) });
  const content = message && message.content;
  if (typeof content === "string") {
    if (content) parts.push({ type: "text", text: content });
  } else if (Array.isArray(content)) {
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      if (item.type === "text") parts.push(item);
      else if (item.type === "reasoning" && !hasReasoning) parts.push(item);
    }
  }
  for (const call of Array.isArray(message && message.tool_calls) ? message.tool_calls : []) {
    if (!call || typeof call !== "object") continue;
    const fn = call.function || {};
    let input = {};
    if (typeof fn.arguments === "string") {
      try { const parsed = JSON.parse(fn.arguments); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) input = parsed; } catch { input = {}; }
    } else if (fn.arguments && typeof fn.arguments === "object" && !Array.isArray(fn.arguments)) {
      input = fn.arguments;
    }
    parts.push({
      type: "tool-call",
      toolCallId: String(call.id || ""),
      toolName: String(fn.name || ""),
      input,
    });
  }
  return parts;
}
/** 工具结果正文：只取 text 块、用 `\n` 拼接（参考实现 toWireToolOutput） */
function toolOutputValue(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter((part) => part && part.type === "text")
      .map((part) => String(part.text || "")).join("\n");
  }
  return content == null ? "" : stringValue(content);
}

/** 消息 → CC 的块数组形态（`content` 恒为块数组：字符串会整条丢失） */
function convertMessages(messages) {
  // tool_call_id → 工具名：tool-result 必须回填 toolName；不重命名
  const toolNames = new Map();
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || message.role !== "assistant" || !Array.isArray(message.tool_calls)) continue;
    for (const call of message.tool_calls) {
      const id = String(call && call.id || "").trim();
      const name = String(call && call.function && call.function.name || "").trim();
      if (id && name) toolNames.set(id, name);
    }
  }
  const out = [];
  for (const source of Array.isArray(messages) ? messages : []) {
    if (!source || typeof source !== "object") continue;
    const role = String(source.role || "user");
    if (role === "system" || role === "developer") continue; // system 提到 params 顶层
    if (role === "tool") {
      const callId = String(source.tool_call_id || "");
      const name = toolNames.get(callId) || String(source.name || "");
      out.push({ role: "tool", content: [{
        type: "tool-result",
        toolCallId: callId,
        toolName: name,
        output: { type: "text", value: toolOutputValue(source.content) },
      }] });
      continue;
    }
    if (role === "assistant") {
      out.push({ role: "assistant", content: assistantContent(source) });
      continue;
    }
    // 未知 role 归一成 user（CC 对未知 role 会整条拒）
    out.push({ role: "user", content: userContent(source.content) });
  }
  return out;
}

/** system 块（非末块补 \n；全空时发空格占位 —— 缺省会让上游注入 ~7.5K 默认提示词） */
function systemBlocksOf(messages) {
  const blocks = [];
  for (const source of Array.isArray(messages) ? messages : []) {
    if (!source || typeof source !== "object") continue;
    const role = String(source.role || "");
    if (role !== "system" && role !== "developer") continue;
    const text = textOf(source.content);
    if (!text) continue;
    blocks.push({ type: "text", text });
  }
  for (let i = 0; i < blocks.length - 1; i++) blocks[i].text = `${blocks[i].text}\n`;
  if (!blocks.length) blocks.push({ type: "text", text: " " });
  return blocks;
}

/** tools：恒下发（无工具时空数组）、**没有 type 字段**、名字不重写。
 *  入站是 OpenAI 形态（`{type:"function", function:{name,parameters}}`），也兼容
 *  已经摊平的 `{name,input_schema}`——只认顶层 `name` 会把 OpenAI 工具整批丢掉。 */
function convertTools(tools) {
  if (!Array.isArray(tools)) return [];
  const out = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    const fn = tool.function && typeof tool.function === "object" ? tool.function : tool;
    const name = String(fn.name || "").trim();
    if (!name) continue;
    const description = String(fn.description || "").trim();
    const schema = fn.parameters || fn.input_schema || tool.input_schema || tool.parameters;
    out.push({
      name,
      ...(description ? { description } : {}),
      input_schema: schema && typeof schema === "object" ? schema : { type: "object", properties: {} },
    });
  }
  return out;
}

/** tool_choice：只认 auto/any/tool；`none` → 清空 tools 且不下发 tool_choice（发 none 会 400） */
function toolChoiceOf(choice) {
  if (choice === null || choice === undefined) return { mode: "keep" };
  if (typeof choice === "string") {
    if (choice === "none") return { mode: "disable" };
    if (["auto", "any"].includes(choice)) return { mode: "keep", value: { type: choice } };
    return { mode: "keep" };
  }
  if (typeof choice === "object") {
    if (choice.type === "none") return { mode: "disable" };
    if (choice.type === "auto" || choice.type === "any") return { mode: "keep", value: { type: choice.type } };
    const name = choice.function?.name || choice.name;
    if (choice.type === "tool" || choice.type === "function" || name) return { mode: "keep", value: { type: "tool", name: String(name || "") } };
  }
  return { mode: "keep" };
}

function maxTokensOf(input) {
  const asked = Number(input?.max_tokens ?? input?.max_completion_tokens);
  if (!Number.isFinite(asked) || asked <= 0) return DEFAULT_MAX_TOKENS;
  return Math.min(Math.trunc(asked), MAX_TOKENS_CAP);
}

/** 8 键信封 + params 逐字段改写（plan.rs build） */
function buildEnvelope(input, sessionId, apiKey) {
  const body = input || {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const model = String(body.model || "").trim() || DEFAULT_MODEL;
  const system = systemBlocksOf(messages);
  const params = {
    model,
    messages: convertMessages(messages),
    max_tokens: maxTokensOf(body),
    stream: true, // 上游只支持流；非流式由下游聚合
    system,
  };
  if (Number.isFinite(Number(body.temperature))) params.temperature = Number(body.temperature);
  if (body.reasoning_effort) params.reasoning_effort = String(body.reasoning_effort);
  let tools = convertTools(body.tools);
  const choice = toolChoiceOf(body.tool_choice);
  if (choice.mode === "disable") tools = [];
  else if (choice.value) params.tool_choice = choice.value;
  params.tools = tools;
  if (typeof body.parallel_tool_calls === "boolean") params.parallel_tool_calls = body.parallel_tool_calls;
  // 缓存断点：客户端打过就保留；否则 prompt_cache_key 落在 system 最后一块
  const cacheKey = String(body.prompt_cache_key || "").trim();
  const marked = system.some(hasCacheControl) || params.messages.some((m) => Array.isArray(m.content) && m.content.some(hasCacheControl));
  if (cacheKey && !marked) system[system.length - 1].cache_control = { type: "ephemeral" };

  const envelope = {
    config: {
      workingDir: DEVICE_PROJECT_DIR,
      date: new Date().toISOString().slice(0, 10),
      environment: DEVICE_PLATFORM,
      structure: [],
      isGitRepo: false,
      currentBranch: "",
      mainBranch: "",
      gitStatus: "",
      recentCommits: [],
    },
    memory: null, taste: null, skills: null,
    permissionMode: "standard",
    ...(isWireUuid(sessionId) ? { threadId: sessionId } : {}),
    mode: "agent",
    params,
  };
  void apiKey;
  return envelope;
}

/** CLI 客户端头（生成 / 指纹 / 生命周期 / 目录共用同一张表） */
function cliHeaders(token, sessionId, zdr) {
  return {
    "Content-Type": "application/json",
    "User-Agent": CLI_USER_AGENT,
    "x-command-code-version": PROTOCOL_VERSION,
    "x-cli-environment": CLI_ENVIRONMENT,
    "x-project-slug": slugifyProjectPath(DEVICE_PROJECT_DIR),
    "x-taste-learning": "false", // 字面量字符串，不是布尔
    // 零数据留存是**条件头**：只有客户端明确带 `x-cmd-zdr: 1` 才下发
    ...(zdr ? { "x-cmd-zdr": "1" } : {}),
    ...(sessionId ? { "x-session-id": sessionId } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    traceparent: `00-${crypto.randomBytes(16).toString("hex")}-${crypto.randomBytes(8).toString("hex")}-01`,
  };
}
/** CLI 的 slug 规则：整串小写、非字母数字折成 `-`、去首尾 `-`，空则 `root` */
function slugifyProjectPath(text) {
  const out = String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return out || "root";
}

/** 读 NDJSON 行（一行一个 JSON 事件，无 `data:` 前缀） */
async function* ndjson(response, signal) {
  const body = response.body;
  if (!body || typeof body.getReader !== "function") return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) yield line;
      }
    }
    const tail = (buffer + decoder.decode()).trim();
    if (tail) yield tail;
  } finally {
    try { await reader.cancel(); } catch { /* 已关闭 */ }
  }
}

function createCommandCode(settings = {}) {
  const base = String(settings.base || BASE_URL).replace(/\/+$/, "");
  return {
    id: "commandcode", channels: ["commandcode"],
    requiredFeatures: ["execution-facts@1", "request-headers@1"],
    async listModels(request, ctx) {
      const context = request.grantId ? await ctx.pool.context() : {};
      if (request.force !== true) {
        const models = (context.models || []).map(descriptor);
        return models.length ? models : FALLBACK_MODELS.map(([id, name]) => ({ id, name }));
      }
      const credentials = await ctx.pool.credentials();
      const token = String(credentials?.token || "").trim();
      if (!token) throw fail(401, "AUTH_REQUIRED", "Command Code API Key 缺失", "account");
      const response = await ctx.pool.network().fetch(`${base}/provider/v1/models`, {
        method: "GET", redirect: "error", signal: ctx.signal,
        headers: { ...cliHeaders(token), Accept: "application/json" },
      });
      if (!response.ok) throw classify(response.status, await errorDetail(response));
      let data;
      try { data = JSON.parse(await response.text()); } catch { throw fail(502, "INVALID_CATALOG_RESPONSE", "Command Code 模型目录格式无法解析", "service"); }
      const rows = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
      const out = [];
      const seen = new Set();
      for (const row of rows) {
        const id = row && typeof row.id === "string" ? row.id.trim() : "";
        if (!id || seen.has(id.toLowerCase())) continue;
        seen.add(id.toLowerCase());
        // 上游不返回结构化能力位：工具与思考是一等字段 → true；图片位无依据 → false（少报）
        out.push({ id, name: String(row.name || id), rate: null, capabilities: { tools: true, reasoning: true, images: false }, contextLength: 0, maxOutputTokens: 0 });
      }
      if (!out.length) throw fail(502, "EMPTY_CATALOG", "Command Code 未返回可用模型目录", "service");
      return out;
    },
    async *invoke(request, ctx) {
      const credentials = await ctx.pool.credentials();
      const token = String(credentials?.token || "").trim();
      if (!token) throw fail(401, "AUTH_REQUIRED", "Command Code API Key 缺失", "account");
      const input = request.input || {};
      const headers = ctx.request?.headers || {};
      const zdr = String(headers["x-cmd-zdr"] || headers["X-Cmd-Zdr"] || "").trim() === "1";
      const sessionId = sessionIdOf(String(input.model || "").trim() || DEFAULT_MODEL, systemBlocksOf(input.messages), input.messages, input, headers, token);
      const envelope = buildEnvelope(input, sessionId, token);
      const model = envelope.params.model;
      await ctx.attempts?.report({ state: "planned", actualModel: model });
      // 预请求：设备指纹 + 生命周期（best-effort，失败不影响正式请求）
      for (const path of ["/alpha/fingerprint/record", "/alpha/lifecycle-events"]) {
        try {
          const pre = await ctx.pool.network().fetch(`${base}${path}`, {
            method: "POST", redirect: "error", signal: ctx.signal,
            headers: cliHeaders(token, sessionId, zdr), body: JSON.stringify({ sessionId, model }),
          });
          try { await pre.text(); } catch { /* 丢弃 */ }
        } catch { /* best-effort */ }
      }
      let response;
      try {
        response = await ctx.pool.network().fetch(`${base}/alpha/generate`, {
          method: "POST", redirect: "error", signal: ctx.signal,
          headers: cliHeaders(token, sessionId, zdr), body: JSON.stringify(envelope),
        });
      } catch (error) {
        if (ctx.signal?.aborted) throw fail(504, "UPSTREAM_TIMEOUT", "Command Code 请求已取消或超时");
        throw classify(502, error?.message);
      }
      await ctx.attempts?.report({ state: "responded", actualModel: model });
      if (!response.ok) throw classify(response.status, await errorDetail(response));
      let contentSeen = false;
      let finishReason = "stop";
      let sawFinish = false;
      let sawFinishStep = false;
      let usage = null;
      try {
        for await (const line of ndjson(response, ctx.signal)) {
          let event;
          try { event = JSON.parse(line); } catch { continue; }
          if (!event || typeof event !== "object") continue;
          const type = String(event.type || "");
          if (type === "text-delta") {
            const text = String(event.text ?? event.delta ?? "");
            if (text) { contentSeen = true; yield { type: "delta", delta: { content: text } }; }
            continue;
          }
          if (type === "reasoning-delta") {
            const text = String(event.text ?? event.delta ?? "");
            if (text) yield { type: "delta", delta: { reasoning_content: text } };
            continue;
          }
          if (type === "tool-call") {
            // 整体事件：id / name / arguments 一次给全（与 Anthropic 的宣告帧+参数帧不同）
            const args = typeof event.arguments === "string" ? event.arguments : JSON.stringify(event.arguments ?? {});
            yield { type: "delta", delta: { tool_calls: [{
              index: 0, id: String(event.toolCallId || event.id || crypto.randomUUID()),
              type: "function", function: { name: String(event.toolName || event.name || ""), arguments: args },
            }] } };
            contentSeen = true;
            continue;
          }
          if (type === "finish-step") {
            sawFinishStep = true;
            if (event.finishReason) finishReason = mapFinishReason(event.finishReason);
            if (event.usage) usage = event.usage;
            continue;
          }
          if (type === "finish") {
            sawFinish = true;
            if (event.finishReason) finishReason = mapFinishReason(event.finishReason);
            if (event.usage) usage = event.usage;
            continue;
          }
          if (type === "error") {
            const status = Number(event.statusCode ?? event.status);
            const detail = JSON.stringify(event);
            throw classify(Number.isFinite(status) ? status : 502, detail);
          }
          // 其余（start / start-step / text-start / text-end / reasoning-start /
          // reasoning-end / tool-input-* / tool-error / provider-metadata）无用户可见内容
        }
      } finally {
        try { await response.body?.cancel(); } catch { /* 已关闭 */ }
      }
      // 收尾时序：内容帧先于收尾帧；一个完成信号都没有 = 响应被截断（不补 finish）
      if (!sawFinish && !sawFinishStep) throw fail(502, "TRUNCATED_UPSTREAM_RESPONSE", "Command Code 响应在完成信号前中断");
      if (usage) yield { type: "usage", mode: "snapshot", usage: {
        prompt_tokens: Number(usage.promptTokens ?? usage.prompt_tokens) || 0,
        completion_tokens: Number(usage.completionTokens ?? usage.completion_tokens) || 0,
        total_tokens: Number(usage.totalTokens ?? usage.total_tokens) || 0,
      } };
      if (!contentSeen && finishReason === "stop") throw fail(502, "EMPTY_UPSTREAM_RESPONSE", "Command Code 返回空响应");
      yield { type: "finish", reason: finishReason };
    },
  };
}

/** 上游 finishReason → 本机词表（length 家族不止一个值；裸 error 归可重试连接失败） */
function mapFinishReason(value) {
  const text = String(value || "").toLowerCase();
  if (!text) return "stop";
  if (text === "max_output_tokens" || text === "model_context_window_exceeded") return "length";
  if (["stop", "length", "tool_calls", "content_filter", "function_call"].includes(text)) return text;
  if (text === "tool-call" || text === "tool-calls" || text === "tool_calls") return "tool_calls";
  if (text === "error" || /network|connection|upstream-error/.test(text)) return "stop";
  return "stop";
}

module.exports = { createCommandCode, buildEnvelope, sessionIdOf, classify, convertMessages, systemBlocksOf, convertTools, mapFinishReason, FALLBACK_MODELS, userContent, assistantContent };
