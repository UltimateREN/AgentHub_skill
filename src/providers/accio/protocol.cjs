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
// 反代网关 · Accio 协议转换：OpenAI Chat Completions ↔ 阿里 ADK 的 Gemini 风格信封
//
// 上游（POST {llmBase}/generateContent，body 是 protobuf-JSON 的 snake_case 形态）：
//   { model, tenant, iai_tag, empid, request_id, message_id, token, contents, system_instruction,
//     tools:[{name,description,parameters_json}], temperature, max_output_tokens, top_p, stop_sequences,
//     tool_config:"{...}", include_thoughts, reasoning_effort, properties:{normalized_response,reasoning_effort} }
//
// 四个必须照抄的点（都是上游的实际约束，不是取舍）：
//   1. tool_config 是 JSON 字符串（内容 {"functionCallingConfig":{"streamFunctionCallArguments":true}}）——工具参数才能流式吐出来；
//   2. function_call.args_json / function_response.response_json 也是字符串（里面才是 JSON 本体）——写成本体对象上游认不出参数；
//   3. system_instruction 是字符串，不是 {parts:[…]} 那种 Content；
//   4. 思考档位走 properties.reasoning_effort（map<string,string>，值必须字符串）；对 protocol=responses/openai 的
//      OpenAI 系模型，顶层 reasoning_effort 要留空（Gemini 系放 properties 是硬 400）。
//
// 媒体（图片）：OpenAI image_url 为 data: 开头的 data URI → inline_data{mime_type,data}；
// 其余远程 URL → file_data{mime_type,file_uri}。不支持的模型会自己报错（比静默丢图要好）。
// message_id 是必填（实测缺了上游回 error_code 400 invalid params），用与 request_id 同源的随机串加前缀。
"use strict";

const crypto = require("node:crypto");
const endpoints = require("./endpoints.cjs");

// 上游 finish_reason → OpenAI finish_reason
function finishReason(raw) {
  switch (String(raw || "").toLowerCase()) {
    case "":
    case "stop":
    case "end_turn":
    case "complete":
      return "stop";
    case "max_tokens":
    case "length":
      return "length";
    case "tool_calls":
    case "tool_use":
    case "function_call":
      return "tool_calls";
    case "content_filter":
    case "safety":
    case "blocked":
      return "content_filter";
    default:
      return "stop";
  }
}

const QUOTA_HINTS = ["积分", "余额", "额度", "quota", "insufficient", "credit", "exceeded", "limit reached", "rate limit", "too many requests"];
const AUTH_HINTS = ["unauthorized", "not logged in", "invalid token", "token expired", "invalid_token"];

// 按 HTTP 状态码 + 文案分类（上游把额度不足放在 HTTP 400/200 的 body 里，只看状态码会漏）
function classifyUpstreamError(status, message) {
  const lower = String(message || "").toLowerCase();
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "quota";
  if (AUTH_HINTS.some((h) => lower.includes(h))) return "auth";
  if (QUOTA_HINTS.some((h) => lower.includes(h))) return "quota";
  return "other";
}

// 思考档位 → 上游取值：按模型声明的档位就近收敛；集合为空（模型不支持思考）返回 null（调用方不发 include_thoughts）
const RANKS = { minimal: 0, low: 1, medium: 2, standard: 2, high: 3, max: 4 };
function resolveEffort(level, efforts) {
  const list = (efforts || []).filter(Boolean);
  if (!list.length) return null;
  const wanted = RANKS[String(level || "").toLowerCase()];
  if (wanted == null) return list[0];
  let best = null;
  for (const effort of list) {
    const rank = RANKS[String(effort).toLowerCase()];
    if (rank == null) continue;
    const distance = Math.abs(rank - wanted);
    if (!best || distance < best.distance) best = { distance, effort };
  }
  return best ? best.effort : list[0];
}

// 一个 OpenAI content（字符串或分块数组）→ ADK parts
function contentToParts(content, parts) {
  if (typeof content === "string") {
    if (content) parts.push({ text: content });
    return;
  }
  if (!Array.isArray(content)) return;
  for (const item of content) {
    const type = item && item.type;
    if (type === "text" || type === "input_text" || type === "output_text") {
      const text = item.text;
      if (text) parts.push({ text });
    } else if (type === "image_url" || type === "input_image") {
      const urlRaw = item.image_url;
      const url = typeof urlRaw === "string" ? urlRaw : urlRaw && typeof urlRaw === "object" ? urlRaw.url : item.url;
      const part = imagePart(url);
      if (part) parts.push(part);
    }
  }
}

// 图片 URL → ADK part（data URI 走 inline_data，其余走 file_data）
function imagePart(url) {
  const u = String(url || "").trim();
  if (!u) return null;
  if (u.startsWith("data:")) {
    const comma = u.indexOf(",");
    if (comma < 0) return null;
    const meta = u.slice(5, comma);
    const data = u.slice(comma + 1);
    if (!meta.includes("base64")) return null;
    const mime = meta.split(";")[0] || "image/png";
    return { inline_data: { mime_type: mime, data } };
  }
  return { file_data: { mime_type: "image/png", file_uri: u } };
}

// OpenAI tool_calls → ADK function_call parts（args 是字符串，可能分片到达）
function assistantToolCallsParts(toolCalls) {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls.map((call) => {
    const fn = (call && call.function) || {};
    return {
      function_call: {
        id: String((call && call.id) || ""),
        name: String(fn.name || ""),
        args_json: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments || {}),
      },
    };
  });
}

// 工具结果（role=tool）→ ADK function_response part（response 是字符串包着的 JSON）
function toolResultPart(message) {
  const id = String((message && message.tool_call_id) || "");
  const name = String((message && message.name) || "");
  const contentRaw = message && message.content;
  const content = typeof contentRaw === "string" ? contentRaw : contentRaw == null ? "" : JSON.stringify(contentRaw);
  const isError = !!(message && message.is_error);
  return {
    function_response: {
      id,
      name,
      response_json: JSON.stringify({ content, is_error: isError }),
    },
  };
}

// generateContent 的 URL：{llmBase}/generateContent?sg_k=<md5(requestId)>（sg_k 是防重放标记，照算）
function generateContentUrl(llmBase, requestId) {
  const sgk = crypto.createHash("md5").update(String(requestId)).digest("hex");
  return `${llmBase}/generateContent?sg_k=${sgk}`;
}

/**
 * OpenAI Chat 请求体 → ADK generateContent 请求体。
 * modelCode 是已按家解析过的发送名（models.resolve 的 upstreamKey）；token 是 accessToken（上游靠 body 里这个字段鉴权）。
 * placement 是思考档位落点（properties / top），由目录条目的 protocol 决定，不按模型名猜。
 * 返回 { body, thinking }
 */
function buildUpstreamBody(body, modelCode, token, effort, placement) {
  const contents = [];
  let systemParts = [];
  let pendingParts = [];
  const messages = Array.isArray(body && body.messages) ? body.messages : [];

  // 相邻同角色合并：上游对 contents 角色交替没有硬要求，合并能少一次无意义往返
  const pushContent = (role, parts) => {
    if (!parts.length) return;
    const last = contents[contents.length - 1];
    if (last && last.role === role && Array.isArray(last.parts)) {
      last.parts.push(...parts);
      return;
    }
    contents.push({ role, parts });
  };

  for (const message of messages) {
    const role = (message && message.role) || "user";
    if (role === "system" || role === "developer") {
      const parts = [];
      contentToParts(message.content, parts);
      for (const p of parts) if (p.text) systemParts.push(p.text);
    } else if (role === "tool" || role === "function") {
      pendingParts.push(toolResultPart(message));
      pushContent("tool", pendingParts.splice(0));
    } else if (role === "assistant") {
      const parts = [];
      contentToParts(message.content, parts);
      parts.push(...assistantToolCallsParts(message.tool_calls));
      pushContent("model", parts);
    } else {
      const parts = [];
      contentToParts(message.content, parts);
      pushContent("user", parts);
    }
  }

  const systemInstruction = systemParts.join("\n\n");

  // 工具声明（parameters_json 是字符串包着的 JSON）
  const tools = (Array.isArray(body.tools) ? body.tools : []).map((tool) => {
    const fn = (tool && tool.function) || tool || {};
    return {
      name: String(fn.name || "").trim(),
      description: String(fn.description || ""),
      parameters_json: JSON.stringify(fn.parameters || { type: "object", properties: {} }),
    };
  }).filter((t) => t.name);

  const properties = { normalized_response: "true" }; // 客户端自己的归一化开关（桌面端每个请求都带）
  const requestId = crypto.randomUUID();
  const payload = {
    model: modelCode,
    tenant: endpoints.DEFAULT_TENANT,
    iai_tag: endpoints.DEFAULT_IAI_TAG,
    empid: "",
    request_id: requestId,
    message_id: `msg-${requestId}`,
    token: String(token || ""),
    contents,
    system_instruction: systemInstruction,
  };
  if (tools.length) {
    payload.tools = tools;
    payload.tool_config = JSON.stringify({ functionCallingConfig: { streamFunctionCallArguments: true } });
  }
  if (typeof body.temperature === "number") payload.temperature = body.temperature;
  const maxTokens = Number(body.max_tokens || body.max_completion_tokens);
  if (Number.isFinite(maxTokens) && maxTokens > 0) payload.max_output_tokens = maxTokens;
  if (typeof body.top_p === "number") payload.top_p = body.top_p;
  if (body.stop != null) {
    const list = typeof body.stop === "string" ? [body.stop] : Array.isArray(body.stop) ? body.stop : [];
    if (list.length) payload.stop_sequences = list;
  }

  let thinking = false;
  if (effort && String(effort).trim() && String(effort).toLowerCase() !== "off" && String(effort).toLowerCase() !== "none") {
    thinking = true;
    payload.include_thoughts = true;
    if (placement === "properties") {
      properties.reasoning_effort = String(effort);
    } else {
      payload.reasoning_effort = String(effort);
    }
  }
  // properties 总是发（normalized_response 在里面），排在最后（上面的 reasoning_effort 可能又往里加了一条）
  payload.properties = properties;

  return { body: payload, thinking };
}

module.exports = { finishReason, classifyUpstreamError, resolveEffort, buildUpstreamBody, generateContentUrl, imagePart, contentToParts };
