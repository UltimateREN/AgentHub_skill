/**
 * ============================================================
 *  作者：UltimateREN
 *  日期：2026-11-09
 *  版权声明：本代码归 UltimateREN 所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 增强网关 · Trae 聊天请求体：**白名单信封** + 原生工具消息整形。
//
// ── 为什么必须是白名单，而不是「原样透传 + 改几个字段」────────────
// Trae 的 /api/agent/v3/llm_utils_chat 认的是它自己的信封：多带的字段会被**拒绝**
// （不是忽略）。客户端（Codex CLI / Cline / Claude Code）发来的 body 里有一堆
// OpenAI 通用字段 —— stream_options、response_format、logprobs、user、metadata、
// parallel_tool_calls、reasoning、service_tier…… 原样转发就是把它们当垃圾塞给上游。
// 所以这里按上游认的键逐个取，取不到就不写。
//
// ── 五处整形，每处都有它非做不可的理由（对照 Agent2Providers trae/payload.rs）──
//   ① tools[].function.parameters 必须是 **JSON 字符串**：上游按字符串收，
//      传对象会被判成参数格式错误。
//   ② 历史 assistant.tool_calls 要改成 function_call：上游的历史回放只认这个键名，
//      且 function_call.name 必填 —— 没名字的调用整条剔除。
//   ③ role: "developer" → "system"：上游角色枚举里没有 developer。
//   ④ 孤儿 tool 结果（tool_call_id 指向不存在的调用）必须丢掉：上游会对不上账。
//   ⑤ tool 结果不能是空 content：上游拒绝空工具结果，补 "(no output)"。
//      工具结果里的图片要提到整组之后的 user 消息里（上游 tool 消息不收图片块）。
"use strict";

/** 上游认的采样参数（白名单，逐个取数字） */
const SAMPLING_KEYS = Object.freeze(["temperature", "top_p", "presence_penalty", "frequency_penalty", "seed", "n"]);

const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const text = (v) => (typeof v === "string" ? v.trim() : "");

/** ① tool_choice 折算成上游要的裸字符串；"none" 还要连带删掉 tools/functions */
function normalizeToolChoice(body) {
  if (!Object.hasOwn(body, "tool_choice")) return;
  const suppress = () => { delete body.tools; delete body.functions; };
  const choice = body.tool_choice;
  if (typeof choice === "string") {
    if (choice.trim().toLowerCase() === "none") { delete body.tool_choice; suppress(); }
    return;
  }
  if (!isObject(choice)) { delete body.tool_choice; return; }
  const kind = text(choice.type).toLowerCase();
  if (kind === "none") { delete body.tool_choice; suppress(); return; }
  if (kind === "auto" || kind === "required") { body.tool_choice = kind; return; }
  if (kind === "function") {
    const name = text(choice.function?.name) || text(choice.name);
    body.tool_choice = name || "auto";
    return;
  }
  delete body.tool_choice;
}

/** ② tools[].function.parameters 对象 → JSON 字符串；形状不对的工具整条剔除 */
function normalizeTools(body) {
  if (!Array.isArray(body.tools)) return;
  if (!body.tools.length) return;
  const kept = [];
  for (const item of body.tools) {
    if (!isObject(item) || !isObject(item.function)) continue;
    const fn = { ...item.function };
    if (!text(fn.name)) continue;
    if (isObject(fn.parameters)) fn.parameters = JSON.stringify(fn.parameters);
    else if (typeof fn.parameters === "string") { /* 已是字符串，原样 */ }
    else if (fn.parameters == null) fn.parameters = JSON.stringify({ type: "object", properties: {} });
    else continue;
    kept.push({ ...item, function: fn });
  }
  if (!kept.length) delete body.tools;
  else body.tools = kept;
}

/**
 * ③ 角色归一 + assistant.tool_calls → function_call + 字符串 content → text 块
 * 返回需要整条丢弃的消息下标（纯 tool_calls 但全被剔除、又没有正文的 assistant 占位）。
 */
function normalizeMessages(body) {
  if (!Array.isArray(body.messages)) return [];
  const drop = new Set();
  body.messages.forEach((msg, index) => {
    if (!isObject(msg)) return;
    if (msg.role === "developer") msg.role = "system";
    const contentValue = msg.content;
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
      const kept = [];
      for (const call of msg.tool_calls) {
        if (!isObject(call)) continue;
        const next = { ...call };
        if (isObject(next.function)) { next.function_call = next.function; delete next.function; }
        // 上游要求 function_call.name 必填：没名字的调用整条剔除
        if (!text(next.function_call?.name)) continue;
        kept.push(next);
      }
      if (kept.length) msg.tool_calls = kept;
      else {
        delete msg.tool_calls;
        const blank = contentValue === undefined || contentValue === null || contentValue === "";
        if (blank) drop.add(index);
      }
    }
    // 字符串正文 → [{type:"text",text}]；已是数组（多模态）原样透传（不猜上游要什么形状）
    if (typeof contentValue === "string") msg.content = [{ type: "text", text: contentValue }];
  });
  return [...drop];
}

/** ④ 丢掉引用了不存在的 tool_call 的 role=tool 消息，以及上一步标出的占位 */
function dropOrphanToolResults(body, dropIndexes = []) {
  if (!Array.isArray(body.messages)) return;
  const known = new Set();
  for (const msg of body.messages) {
    if (!isObject(msg) || msg.role !== "assistant" || !Array.isArray(msg.tool_calls)) continue;
    for (const call of msg.tool_calls) {
      const id = text(call?.id);
      if (id) known.add(id);
    }
  }
  const drop = new Set(dropIndexes);
  body.messages = body.messages.filter((msg, index) => {
    if (drop.has(index) || msg === null) return false;
    if (!isObject(msg) || msg.role !== "tool") return true;
    return known.has(text(msg.tool_call_id));
  });
}

/** ⑤ 工具结果不能为空：补占位文本；图片块提到整组之后的 user 消息里 */
function normalizeToolResults(body) {
  if (!Array.isArray(body.messages)) return;
  const out = [];
  let pendingImages = [];
  for (const msg of body.messages) {
    if (!isObject(msg)) continue;
    if (msg.role === "tool") {
      let parts = Array.isArray(msg.content) ? [...msg.content]
        : typeof msg.content === "string" && msg.content ? [{ type: "text", text: msg.content }]
          : [];
      parts = parts.filter((part) => {
        if (part?.type === "image_url") { pendingImages.push(part); return false; }
        return true;
      });
      const hasText = parts.some((part) => typeof part?.text === "string" && part.text);
      if (!hasText) parts.push({ type: "text", text: pendingImages.length ? "(the result's image follows)" : "(no output)" });
      out.push({ ...msg, content: parts });
      continue;
    }
    if (pendingImages.length) { out.push({ role: "user", content: pendingImages }); pendingImages = []; }
    const last = out[out.length - 1];
    // 相邻 assistant 合并（上游不接受连续两条 assistant）
    if (msg.role === "assistant" && last && last.role === "assistant") {
      for (const field of ["content", "tool_calls"]) {
        const merged = [...(Array.isArray(last[field]) ? last[field] : []), ...(Array.isArray(msg[field]) ? msg[field] : [])];
        if (merged.length) last[field] = merged;
      }
      continue;
    }
    out.push(msg);
  }
  if (pendingImages.length) out.push({ role: "user", content: pendingImages });
  body.messages = out;
}

/** 白名单信封：只写上游认的键。target 来自目录路由，extra 是渠道级常量。 */
function envelope(input, target, extra = {}) {
  const out = {};
  out.messages = input.messages;
  out.function = target.function;
  out.stream = true;
  out.config_name = target.configName;
  out.model = target.configName;
  if (target.modelName) out.model_name = target.modelName;
  if (extra.sessionId) out.session_id = extra.sessionId;
  if (extra.requestId) out.request_id = extra.requestId;
  if (Array.isArray(input.tools) && input.tools.length) {
    out.tools = input.tools;
    if (input.tool_choice !== undefined) out.tool_choice = input.tool_choice;
    if (typeof input.parallel_tool_calls === "boolean") out.parallel_tool_calls = input.parallel_tool_calls;
  }
  for (const key of SAMPLING_KEYS) {
    if (typeof input[key] === "number") out[key] = input[key];
  }
  const asked = Number(input.max_completion_tokens) > 0 ? Number(input.max_completion_tokens)
    : Number(input.max_tokens) > 0 ? Number(input.max_tokens) : 0;
  const native = Number(target.maxTokens) > 0 ? Number(target.maxTokens) : 0;
  const output = asked && native ? Math.min(asked, native) : asked || (native && target.maxWindow ? native : 0);
  if (output) out.max_tokens = output;
  if (target.maxWindow) out.user_message_context = { model_info: { prompt_max_tokens: Math.max(0, target.maxWindow - output) } };
  if (typeof input.stop === "string" || Array.isArray(input.stop)) out.stop = input.stop;
  // 其余渠道常量（conversation_id / user_id / device_id / ide_version…）由调用方补齐
  return { ...out, ...(extra.fields || {}) };
}

/** 一次做完五处整形，返回可直接发上游的 body */
function prepareBody(input, target, extra) {
  const body = { ...(input || {}) };
  normalizeToolChoice(body);
  normalizeTools(body);
  const drop = normalizeMessages(body);
  dropOrphanToolResults(body, drop);
  normalizeToolResults(body);
  return envelope(body, target, extra);
}

module.exports = { prepareBody, normalizeToolChoice, normalizeTools, normalizeMessages, dropOrphanToolResults, normalizeToolResults, SAMPLING_KEYS };
