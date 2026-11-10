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
// OrcaTerm（腾讯云遨驰终端）：**两步有状态**（建会话 → SSE 对话）。
// 依据 Agent2Providers `orcaterm/chat.rs` 模块头。
//
// ── 上游两步（2026-10-16 实测，curl 直连可复现）──────────────────────
//   1. POST {LIGHTAI}/assistant/conversation → `cid-<uuid>-orcaterm`
//   2. POST {LIGHTAI}/assistant/chat?name=orcaterm&mode=0&csrfCode=&sseresume=true
//      → SSE：`data: {content|reasoningContent}` … `data: [DONE]`
// SSE 帧字段：content / reasoningContent / reasoning（true = 思考增量）/ type:"ai" / code:0；
// **错误帧不是 JSON**：`data: [ERROR]: [LLM_ERROR]: …`。
//
// ── 多轮：历史拍平为单条输入 ────────────────────────────────────
// 上游按 conversationId 在服务端留存历史，但输入通道只有一条 `start` 消息，
// 而 OpenAI 客户端每轮自带全量 messages → 每个请求新建会话，历史拍平进输入文本。
// 没有会话注册表、无指纹链、重启即忘。
//
// ── 信封解包 ─────────────────────────────────────────────────
// 上游是 agent 协议：模型正文倾向输出 ACP 动作信封（```json 围栏或裸 JSON，形如
// {"action":"completion","taskCompletion":"…"}）。OpenAI 客户端要的是纯文本，
// 故第一个正文增量到达时判定形态（``` / `{` 开头 → 缓冲模式），结束时解包；
// 解不出就原样透传。
"use strict";
const crypto = require("node:crypto");
const { descriptor } = require("../../model-descriptor.cjs");
const { sse, errorDetail } = require("../../network/sse.cjs");
const { forwardError, hasContent } = require("../../../sdk/provider-protocol.cjs");

const LIGHTAI_BASE = "https://lightai.cloud.tencent.com";
const ASSISTANT_QUERY = "name=orcaterm&mode=0&csrfCode=&sseresume=true";
const DEFAULT_MODEL = "TokenHub/glm-5.3-flash";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";
const STATIC_MODELS = [
  ["hy4-preview", "Hy4-preview"], ["hy3", "Hy3"], ["kimi-k3", "Kimi-K3"],
  ["glm-5.3-flash", "GLM-5.3-Flash"], ["glm-5.3", "GLM-5.3"], ["glm-5.2", "GLM-5.2"],
  ["deepseek-v4.1-flash", "DeepSeek-V4.1-Flash"], ["deepseek-v4-flash", "DeepSeek-V4-Flash"],
  ["deepseek-v4-pro", "DeepSeek-V4-Pro"],
];
function fail(status, code, message, scope = "invocation", retryable = false) {
  return forwardError({
    code, message: String(message || "OrcaTerm 模型执行失败").slice(0, 1024),
    category: code === "AUTH_REQUIRED" ? "auth" : code === "RATE_LIMITED" ? "rate" : "upstream",
    scope, replay: "unknown", retryable,
    status: status >= 400 && status <= 599 ? status : 502,
  });
}
function classify(status, detail) {
  const text = String(detail || "").slice(0, 2048);
  if (status === 401 || status === 403) return fail(401, "AUTH_REQUIRED", "OrcaTerm 登录态失效，请重新导入", "account");
  if (/is not loaded|LLM_ERROR/i.test(text)) return fail(502, "MODEL_NOT_LOADED", `OrcaTerm 上游未挂载该模型：${text.slice(0, 160)}`, "invocation", false);
  if (/人机验证|captcha/i.test(text)) return fail(429, "CAPTCHA_REQUIRED", "OrcaTerm 触发人机验证（UA / 设备指纹不匹配）", "account", true);
  if (status === 429) return fail(429, "RATE_LIMITED", "OrcaTerm 上游限流", "account", true);
  return fail(status >= 400 && status <= 599 ? status : 502, "UPSTREAM_FAILED", "OrcaTerm 模型执行失败", "invocation", status >= 500);
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part && (part.type === "text" || part.type === "input_text"))
    .map((part) => String(part.text || "")).join("");
}
/** 历史拍平为单条输入（多轮上下文） */
function buildPrompt(messages) {
  const items = Array.isArray(messages) ? messages.filter((m) => m && textOf(m.content).trim()) : [];
  if (!items.length) return "你好";
  if (items.length === 1) return textOf(items[0].content) || "你好";
  const lines = ["[以下是本轮之前的对话记录，供你了解上下文]"];
  for (const message of items) {
    const role = String(message.role || "user");
    const text = textOf(message.content);
    if (!text) continue;
    if (role === "system" || role === "developer") lines.push(`[系统指令] ${text}`);
    else if (role === "assistant") lines.push(`[助手] ${text}`);
    else lines.push(`[用户] ${text}`);
  }
  return lines.join("\n");
}
function resolveModel(name) {
  const bare = String(name || "").trim().replace(/^TokenHub\//, "").trim();
  if (!bare) return DEFAULT_MODEL;
  return STATIC_MODELS.some(([id]) => id === bare) ? `TokenHub/${bare}` : DEFAULT_MODEL;
}

/** 信封解包：```json 围栏或裸 JSON 的 ACP 动作信封 → 正文 */
function unwrapEnvelope(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return text;
  let candidate = trimmed;
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  if (fence) candidate = fence[1].trim();
  if (!candidate.startsWith("{")) return text;
  try {
    const value = JSON.parse(candidate);
    if (value && typeof value === "object") {
      for (const key of ["taskCompletion", "completion", "content", "text", "answer"]) {
        if (typeof value[key] === "string" && value[key].trim()) return value[key];
      }
    }
  } catch { /* 解不出就原样透传 */ }
  return text;
}

function createOrcaTerm(settings = {}) {
  const base = String(settings.base || LIGHTAI_BASE).replace(/\/+$/, "");
  return {
    id: "orcaterm", channels: ["orcaterm"], requiredFeatures: ["execution-facts@1"],
    async listModels(request, ctx) {
      if (!request.grantId) return [];
      const context = await ctx.pool.context();
      const models = (context.models || []).map(descriptor);
      return models.length ? models : STATIC_MODELS.map(([id, name]) => ({ id, name }));
    },
    async *invoke(request, ctx) {
      const credentials = await ctx.pool.credentials();
      const token = String(credentials?.token || "").trim();
      const uid = String(credentials?.uin || "").trim();
      if (!token) throw fail(401, "AUTH_REQUIRED", "OrcaTerm 登录态缺失", "account");
      if (!uid) throw fail(401, "AUTH_REQUIRED", "OrcaTerm 账号缺少 uin，请重新导入登录态", "account");
      const input = request.input || {};
      const model = resolveModel(request.model || input.model);
      const prompt = buildPrompt(input.messages);
      const headers = (seqId) => ({
        Authorization: `Bearer ${token}`,
        "X-Product": "orcaterm",
        "x-seqid": seqId,
        "Origin": "https://orcaterm.cloud.tencent.com",
        "Referer": "https://orcaterm.cloud.tencent.com/",
        "content-type": "application/json",
        "user-agent": USER_AGENT,
      });
      // ① 建会话（401 自愈：强制续期后重试一次由宿主 refresh 兜底，这里只重发一次）
      const createConversation = async () => {
        const response = await ctx.pool.network().fetch(`${base}/assistant/conversation`, {
          method: "POST", redirect: "error", signal: ctx.signal, headers: headers(crypto.randomUUID()),
          body: JSON.stringify({ id: crypto.randomUUID(), title: "新对话", ts: Date.now(), customTitle: "", aiTitle: "", tags: ["orcaterm"] }),
        });
        const text = await response.text();
        let value = null;
        try { value = JSON.parse(text); } catch { /* 非 JSON */ }
        if (!response.ok || !value) throw classify(response.status, text);
        const code = Number(value.code ?? -1);
        if (code !== 0) throw fail(502, "CONVERSATION_FAILED", `建会话失败：${String(value.message || "未知错误").slice(0, 160)}`);
        const data = value.data || value;
        const id = String(data.id || data.conversationId || "").trim();
        if (!id) throw fail(502, "CONVERSATION_FAILED", "建会话未返回会话 id");
        return id;
      };
      let conversationId;
      try { conversationId = await createConversation(); }
      catch (error) {
        if (!error?.forwardError) throw classify(Number(error?.status) || 502, error?.message);
        throw error;
      }
      // ② 开流
      const body = {
        conversationId,
        user: {
          id: uid,
          setting: {
            model,
            mcpServers: [], uiServers: [], tools: [], approvedTools: [], approvedMCPTools: [],
            enableAutoSubtaskExecution: false, env: [],
            // 上游是 agent 协议；网关不做工具注入（纯文本直通）
            hideToolMessage: true, language: "zh",
          },
        },
        input: { type: "start", input: prompt, id: crypto.randomUUID(), emphasisPrompt: "", files: [] },
        stream: true,
      };
      let response;
      try {
        await ctx.attempts?.report({ state: "planned", actualModel: model });
        response = await ctx.pool.network().fetch(`${base}/assistant/chat?${ASSISTANT_QUERY}`, {
          method: "POST", redirect: "error", signal: ctx.signal, headers: headers(crypto.randomUUID()), body: JSON.stringify(body),
        });
        await ctx.attempts?.report({ state: "responded", actualModel: model });
      } catch (error) {
        if (ctx.signal?.aborted) throw fail(504, "UPSTREAM_TIMEOUT", "OrcaTerm 请求已取消或超时");
        throw classify(502, error?.message);
      }
      if (!response.ok) throw classify(response.status, await errorDetail(response));
      let buffer = "";
      let buffering = false;
      let contentSeen = false;
      const finishReason = "stop";
      try {
        for await (const raw of sse(response, ctx.signal)) {
          if (!raw) continue;
          if (raw === "[DONE]") break;
          // 错误帧不是 JSON：`[ERROR]: [LLM_ERROR]: …`
          if (/^\s*\[ERROR\]/i.test(raw)) throw classify(502, raw);
          let frame;
          try { frame = JSON.parse(raw); } catch { continue; }
          if (!frame || typeof frame !== "object") continue;
          if (frame.code != null && Number(frame.code) !== 0) throw classify(502, JSON.stringify(frame).slice(0, 512));
          const reasoning = String(frame.reasoningContent ?? frame.reasoning_content ?? "");
          if (reasoning) yield { type: "delta", delta: { reasoning_content: reasoning } };
          const content = String(frame.content ?? "");
          if (!content) continue;
          if (!buffer && !contentSeen) {
            // 第一段：判定是否信封形态（``` 或 { 开头 → 缓冲到流末再解包）
            const head = content.trimStart();
            buffering = head.startsWith("```") || head.startsWith("{");
            if (!buffering) { contentSeen = true; yield { type: "delta", delta: { content } }; continue; }
          }
          if (buffering) { buffer += content; continue; }
          contentSeen = true;
          yield { type: "delta", delta: { content } };
        }
        if (buffer) {
          const text = unwrapEnvelope(buffer);
          if (text) { contentSeen = true; yield { type: "delta", delta: { content: text } }; }
          buffer = "";
        }
        if (!contentSeen) throw fail(502, "EMPTY_UPSTREAM_RESPONSE", "OrcaTerm 返回空响应");
        yield { type: "finish", reason: finishReason };
      } finally {
        try { await response.body?.cancel(); } catch { /* 已关闭 */ }
      }
    },
  };
}

module.exports = { createOrcaTerm, buildPrompt, resolveModel, unwrapEnvelope, classify, STATIC_MODELS, LIGHTAI_BASE, ASSISTANT_QUERY };
