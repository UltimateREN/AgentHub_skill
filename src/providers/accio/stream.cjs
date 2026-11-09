/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-21
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 反代网关 · Accio 上游 SSE 的解析与翻译（ADK 信封 → OpenAI Chat chunk）
//
// 上游的流：每帧一个 JSON（键名两种写法都接受 —— 客户端自己的 fromJSON 就是 camelCase / snake_case 双读的）：
//   data: {"content":{"role":"model","parts":[{"text":"你"}]},"partial":true}
//   data: {"content":{"role":"model","parts":[{"thought":true,"text":"想一想…"}]}}
//   data: {"content":{"role":"model","parts":[{"functionCall":{"id":"call_1","name":"read","argsJson":"{\"path\":\""}}]}}
//   data: {"turnComplete":true,"finishReason":"STOP","usageMetadata":{"promptTokenCount":10,...}}
//   data: [DONE]
//
// 三处与 OpenAI 不同，必须在这里处理：
//   1. 思考是 part 上的标记（{"thought":true,"text":…}）→ 翻成 delta.reasoning_content；
//   2. 工具调用参数是字符串（args_json），且可能分片到达（tool_config 的 streamFunctionCallArguments
//      就是让上游这么发的）→ 按「名字相同且已有内容仍是合法 JSON 就开新调用」的规则聚合；
//   3. 业务错误写在帧里（error_code / error_message），HTTP 常是 200 → 首帧预读与流内都要判。
"use strict";

const protocol = require("./protocol.cjs");

// 双写取值：先 camelCase 再 snake_case
function field(value, camel, snake) {
  const v = value && (value[camel] !== undefined && value[camel] !== null ? value[camel] : value[snake]);
  return v === undefined || v === null ? undefined : v;
}
function textField(value, camel, snake) {
  const v = field(value, camel, snake);
  return typeof v === "string" ? v.trim() : "";
}
function boolField(value, camel, snake) {
  return field(value, camel, snake) === true;
}

// 单个 part → {kind:"text"|"thought"|"function_call"|"other", ...}
function parsePart(part) {
  const thought = !!(part && part.thought);
  const functionCall = part && (part.functionCall || part.function_call);
  if (functionCall) {
    let args = "";
    const raw = functionCall.argsJson !== undefined ? functionCall.argsJson : functionCall.args_json;
    if (typeof raw === "string") args = raw;
    else if (raw !== undefined && raw !== null) args = JSON.stringify(raw);
    else if (functionCall.args !== undefined) {
      args = typeof functionCall.args === "string" ? functionCall.args : JSON.stringify(functionCall.args || {});
    }
    return { kind: "function_call", id: textField(functionCall, "id", "id"), name: textField(functionCall, "name", "name"), args };
  }
  if (part && typeof part.text === "string") {
    return thought ? { kind: "thought", text: part.text } : { kind: "text", text: part.text };
  }
  return { kind: "other" };
}

// usage 对象 → OpenAI 字段名（思考 token 计入输出）
function parseUsage(usage) {
  const number = (camel, snake) => {
    const v = field(usage, camel, snake);
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const prompt = number("promptTokenCount", "prompt_token_count");
  const completion = number("candidatesTokenCount", "candidates_token_count");
  const thoughts = number("thoughtsTokenCount", "thoughts_token_count");
  const explicit = number("totalTokenCount", "total_token_count");
  const total = explicit > 0 ? explicit : prompt + completion + thoughts;
  const cached = number("cachedContentTokenCount", "cached_content_token_count");
  const out = {
    prompt_tokens: prompt,
    completion_tokens: completion + thoughts,
    total_tokens: total,
  };
  if (cached > 0) out.prompt_tokens_details = { cached_tokens: cached };
  return out;
}

/**
 * 一帧 data: 的 JSON 文本 → Frame 或 null。
 * 解析失败 / [DONE] / 空帧返回 null（与客户端 processFrame 的「空帧返回 null」同一取向）。
 * Frame = { parts, turnComplete, finishReason, usage, errorCode, errorMessage }
 */
function parseFrame(data) {
  const trimmed = String(data || "").trim();
  if (!trimmed || trimmed === "[DONE]" || trimmed === "[done]") return null;
  let value;
  try { value = JSON.parse(trimmed); } catch { return null; }
  if (!value || typeof value !== "object") return null;
  const frame = {
    turnComplete: boolField(value, "turnComplete", "turn_complete"),
    finishReason: textField(value, "finishReason", "finish_reason"),
    errorCode: textField(value, "errorCode", "error_code"),
    errorMessage: textField(value, "errorMessage", "error_message"),
    parts: [],
    usage: null,
  };
  const usage = field(value, "usageMetadata", "usage_metadata");
  if (usage && typeof usage === "object") frame.usage = parseUsage(usage);
  const content = value.content;
  if (content && Array.isArray(content.parts)) {
    for (const part of content.parts) frame.parts.push(parsePart(part));
  }
  return frame;
}

function frameIsError(frame) {
  return !!(frame && (frame.errorCode || frame.errorMessage));
}
function frameErrorText(frame) {
  let text = "";
  if (frame.errorCode) text += `[${frame.errorCode}] `;
  text += frame.errorMessage;
  return text;
}

/**
 * 上游帧 → 客户端帧 的翻译状态（流式与非流式共用同一套累积规则）。
 * 解析与拆解只写一份：流式逐帧下发、非流式把产出聚合成一个完整 chat.completion。
 */
class Translator {
  constructor(responseId, modelName) {
    this.responseId = responseId;
    this.created = Math.floor(Date.now() / 1000);
    this.modelName = modelName;
    this.toolState = [];   // [{id,name,args,announced}]
    this.roleSent = false;
    this.usage = null;
    this.finishReason = null;
    this.content = "";
    this.reasoning = "";
    this.sawToolCall = false;
  }

  // 把一次 function_call part 并进累积表，返回它的 index（分片与「一次一个」的区分见模块头要点 2）
  accumulateCall(id, name, args) {
    const last = this.toolState[this.toolState.length - 1];
    const canExtend = !!last && (() => {
      if (id && last.id && id !== last.id) return false;
      if (name && last.name && name !== last.name) return false;
      let previousComplete = false, incomingComplete = false;
      try { if (last.args) { JSON.parse(last.args); previousComplete = true; } } catch { /* 续写中 */ }
      try { if (args) { JSON.parse(args); incomingComplete = true; } } catch { /* 续写中 */ }
      return !(previousComplete && incomingComplete);
    })();
    if (canExtend) {
      if (!last.id && id) last.id = id;
      if (!last.name && name) last.name = name;
      last.args += args;
      return this.toolState.length - 1;
    }
    this.toolState.push({ id: id || "", name: name || "", args: args || "", announced: false });
    return this.toolState.length - 1;
  }

  /**
   * 一帧 → 若干 delta（顺序即下发顺序）。
   * Delta = {kind:"content"|"reasoning"|"tool_call", ...}
   */
  consume(frame) {
    const out = [];
    if (!frame) return out;
    if (frame.usage) this.usage = frame.usage;
    if (frame.finishReason) this.finishReason = protocol.finishReason(frame.finishReason);
    for (const part of frame.parts) {
      if (part.kind === "text") {
        if (part.text) { this.content += part.text; out.push({ kind: "content", text: part.text }); }
      } else if (part.kind === "thought") {
        if (part.text) { this.reasoning += part.text; out.push({ kind: "reasoning", text: part.text }); }
      } else if (part.kind === "function_call") {
        const index = this.accumulateCall(part.id, part.name, part.args);
        const entry = this.toolState[index];
        const announce = !entry.announced;
        entry.announced = true;
        // 首帧（要报 id/name）或有参数可发时下发；首帧即使参数为空也发，否则客户端拿不到这个工具调用的名字
        if (announce || part.args) {
          this.sawToolCall = true;
          out.push({
            kind: "tool_call",
            index,
            id: announce && entry.id ? entry.id : undefined,
            name: announce && entry.name ? entry.name : undefined,
            arguments: part.args || undefined,
          });
        }
      }
    }
    return out;
  }

  // 流式的 role 帧是否该发（第一次产出 delta 前补一帧 role）
  takeRoleFrame() {
    if (this.roleSent) return false;
    this.roleSent = true;
    return true;
  }

  // 收尾的 finish_reason：上游给了就用它，没给按「有没有工具调用」推断
  finalFinishReason() {
    return this.finishReason || (this.sawToolCall ? "tool_calls" : "stop");
  }

  // 收尾的工具调用（非流式聚合用）
  finalToolCalls() {
    return this.toolState
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.name)
      .map(({ entry, index }) => ({
        index,
        id: entry.id || `call_${index}`,
        type: "function",
        function: { name: entry.name, arguments: entry.args || "{}" },
      }));
  }
}

// SSE 帧：data: {json}\n\n / 流结束帧 data: [DONE]\n\n
function sseFrame(value) {
  return `data: ${value}\n\n`;
}
function sseDone() {
  return "data: [DONE]\n\n";
}

// 逐行缓冲（跨分片半行拼接）；首帧预读换手时必须 takePending 交出半行尾巴，否则续传方会把后半截当新行、这一帧静默丢掉
class LineBuffer {
  constructor() { this.pending = ""; }
  push(chunk) {
    this.pending += String(chunk || "");
    const lines = [];
    let index;
    while ((index = this.pending.indexOf("\n")) >= 0) {
      const line = this.pending.slice(0, index + 1);
      this.pending = this.pending.slice(index + 1);
      lines.push(line.replace(/[\r\n]+$/, ""));
    }
    return lines;
  }
  takePending() {
    const p = this.pending;
    this.pending = "";
    return p;
  }
}

module.exports = { parseFrame, frameIsError, frameErrorText, parseUsage, Translator, sseFrame, sseDone, LineBuffer };
