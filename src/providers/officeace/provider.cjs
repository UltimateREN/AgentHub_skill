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
// OfficeAce 果办（华为云）：**OpenAI 兼容 + 无状态**，薄 provider。
// 依据 Agent2Providers `officeace/chat.rs`。
//
// ── 上游形状 ────────────────────────────────────────────────
//   URL：`{base}/chat/completions`，base 规范化成 `https://<host>/v2`
//   头：`Authorization: Basic base64(model_app_key:model_app_secret)` + 三个关联头
//       （`Chat-Id` / `Session-Id` / `lang: en`）
//
// ── 三条实测特性（改之前先读 chat.rs 的模块头）──────────────────────
//   1. 上游**恒流式**：请求体强制 `stream:true` + `stream_options.include_usage`；
//   2. `max_tokens` 是「推理 + 正文」的总预算：给小了会 HTTP 200 但正文空串。
//      这里**追加** 1024（不是取 max —— max 会改掉「只想要 1 个 token」的意图），
//      `max_tokens < 16` 原样透传；
//   3. 体积超限给 **HTTP 429 + 81113** → 先于限流判掉（折成 413，不冷却账号）。
//   另：`glm-5.3` 系列不收 `thinking:{"type":"disabled"}`（回 400）—— 本家**自己从不注入**
//   `thinking`，客户端自带时按 400 透传（不做剥参重试，本仓编排层没有那条链）。
"use strict";
const crypto = require("node:crypto");
const { descriptor } = require("../../model-descriptor.cjs");
const { sse, errorDetail } = require("../../network/sse.cjs");
const { forwardError, hasContent } = require("../../../sdk/provider-protocol.cjs");

/** 推理预算的追加量 */
const REASONING_ALLOWANCE = 1024;
/** 小于这个值的 max_tokens 原样透传 */
const TINY_MAX_TOKENS = 16;
/** 体积超限的假成功码 */
const TOO_LARGE_CODE = 81113;

/** 模型网关基址规范化：`https://<host>` / `…/v2` / `…/v2/` → `https://<host>/v2` */
function normalizeBase(baseUrl) {
  const trimmed = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return trimmed.endsWith("/v2") ? trimmed : `${trimmed}/v2`;
}
function chatEndpoint(baseUrl) {
  const base = normalizeBase(baseUrl);
  return base ? `${base}/chat/completions` : "";
}

function fail(status, code, message, scope = "invocation", retryable = false) {
  return forwardError({
    code, message: String(message || "OfficeAce 模型执行失败").slice(0, 1024),
    category: code === "AUTH_REQUIRED" ? "auth" : code === "QUOTA_EXHAUSTED" ? "quota"
      : code === "RATE_LIMITED" ? "rate" : "upstream",
    scope, replay: "unknown", retryable,
    status: status >= 400 && status <= 599 ? status : 502,
  });
}

/** 错误分类（chat.rs / 参考实现 officeace2api 的码表） */
function classify(status, detail) {
  const text = String(detail || "").slice(0, 2048);
  // 体积超限的假成功：HTTP 429 + 81113 → 折成 413（请求级，不冷却账号）
  if (new RegExp(`\\b${TOO_LARGE_CODE}\\b`).test(text)) return fail(413, "REQUEST_TOO_LARGE", "请求体积超过上游上限（OfficeAce 81113），请缩短上下文后重试");
  // 上游把内容审核包成 HTTP 200 + finish_reason=content_filter 的假答复 → 按可轮换失败处理
  if (/content_filter|blocked by security policy/i.test(text)) return fail(400, "CONTENT_BLOCKED", "内容被上游安全策略拦截（不扣账号配额）");
  if (status === 401 || status === 403) return fail(401, "AUTH_REQUIRED", "OfficeAce 网关凭据无效（Basic 被拒）", "account");
  if (status === 402) return fail(429, "QUOTA_EXHAUSTED", "OfficeAce 积分不足（按限流处置）", "account", true);
  if (status === 429) return fail(429, "RATE_LIMITED", "OfficeAce 上游限流", "account", true);
  if (status === 400 || status === 422) return fail(400, "INVALID_REQUEST", "OfficeAce 拒绝了该请求（参数不合法，如 glm-5.3 系列不收 thinking.disabled）");
  return fail(status >= 400 && status <= 599 ? status : 502, "UPSTREAM_FAILED", "OfficeAce 模型执行失败", "invocation", status >= 500);
}

/** 推理预算：**追加** allowance（不是取 max）；<16 原样透传 */
function budgetOf(input) {
  const asked = Number(input?.max_tokens ?? input?.max_completion_tokens);
  if (!Number.isFinite(asked) || asked <= 0) return null;
  const value = Math.trunc(asked);
  if (value < TINY_MAX_TOKENS) return value;
  return value + REASONING_ALLOWANCE;
}

/** 请求体：恒流式 + 预算追加（其余字段原样透传，含 tools / tool_choice） */
function rewriteBody(input) {
  const body = { ...(input || {}) };
  delete body.max_completion_tokens;
  const budget = budgetOf(input);
  if (budget != null) body.max_tokens = budget;
  body.stream = true;
  body.stream_options = { ...(body.stream_options || {}), include_usage: true };
  return body;
}

function usageEvent(usage) {
  if (!usage || typeof usage !== "object") return null;
  const prompt = Number(usage.prompt_tokens) || 0;
  const completion = Number(usage.completion_tokens) || 0;
  const total = Number(usage.total_tokens) || prompt + completion;
  return prompt || completion || total
    ? { type: "usage", mode: "snapshot", usage: { ...usage, prompt_tokens: prompt, completion_tokens: completion, total_tokens: total } }
    : null;
}

function createOfficeAce(settings = {}) {
  return {
    id: "officeace", channels: ["officeace"], requiredFeatures: ["execution-facts@1"],
    async listModels(request, ctx) {
      if (!request.grantId) return [];
      const context = await ctx.pool.context();
      if (request.force !== true) return (context.models || []).map(descriptor);
      const credentials = await ctx.pool.credentials();
      const token = String(credentials?.token || "").trim();
      if (!token) throw fail(401, "AUTH_REQUIRED", "OfficeAce 网关凭据缺失", "account");
      const baseUrl = String(credentials?.baseUrl || settings.baseUrl || "").trim();
      if (!baseUrl) throw fail(400, "MISSING_BASE_URL", "OfficeAce 账号缺少 baseUrl（模型网关基址）", "account");
      // 目录与 chat 共用同一个规范化基址（`https://<host>/v2`）：
      // 参考实现是 `format!("{}/models", normalize_base(base_url))`，即 `/v2/models`。
      // 写成 `/v1/models` 会 404，且会被本函数当成「目录格式无法解析」，排查时很容易误判。
      const response = await ctx.pool.network().fetch(`${normalizeBase(baseUrl)}/models`, {
        method: "GET", redirect: "error", signal: ctx.signal,
        headers: { Authorization: `Basic ${token}`, Accept: "application/json" },
      });
      if (!response.ok) throw classify(response.status, await errorDetail(response));
      let data;
      try { data = JSON.parse(await response.text()); } catch { throw fail(502, "INVALID_CATALOG_RESPONSE", "OfficeAce 模型目录格式无法解析", "service"); }
      const rows = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
      const out = [];
      const seen = new Set();
      for (const row of rows) {
        const id = row && typeof row.id === "string" ? row.id.trim() : "";
        if (!id || seen.has(id.toLowerCase())) continue;
        seen.add(id.toLowerCase());
        out.push({ id, name: String(row.name || id), rate: null, capabilities: { tools: true, reasoning: true, images: false }, contextLength: 0, maxOutputTokens: 0 });
      }
      if (!out.length) throw fail(502, "EMPTY_CATALOG", "OfficeAce 未返回可用模型目录", "service");
      return out;
    },
    async *invoke(request, ctx) {
      const credentials = await ctx.pool.credentials();
      const token = String(credentials?.token || "").trim();
      if (!token) throw fail(401, "AUTH_REQUIRED", "OfficeAce 网关凭据缺失", "account");
      const baseUrl = String(credentials?.baseUrl || settings.baseUrl || "").trim();
      if (!baseUrl) throw fail(400, "MISSING_BASE_URL", "OfficeAce 账号缺少 baseUrl（模型网关基址）", "account");
      const url = chatEndpoint(baseUrl);
      const body = rewriteBody(request.input);
      const model = String(request.model || body.model || "");
      const controller = new AbortController();
      const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;
      const timeoutMs = Math.max(1, Math.min(Number(settings.firstByteTimeoutMs) || 30000, Number.isFinite(ctx.deadlineAt) ? ctx.deadlineAt - Date.now() : 30000));
      const timer = setTimeout(() => controller.abort(new Error("OfficeAce response timed out")), timeoutMs);
      timer.unref?.();
      let response;
      try {
        await ctx.attempts?.report({ state: "planned", actualModel: model });
        signal.throwIfAborted();
        response = await ctx.pool.network().fetch(url, {
          method: "POST", redirect: "error", signal,
          headers: {
            Authorization: `Basic ${token}`,
            "Content-Type": "application/json",
            Accept: "text/event-stream, application/json",
            // 桌面端那三个关联头（chat.rs 模块头）
            "Chat-Id": crypto.randomUUID(),
            "Session-Id": String(request.input?.user || request.input?.session_id || crypto.randomUUID()),
            lang: "en",
          },
          body: JSON.stringify(body),
        });
        await ctx.attempts?.report({ state: "responded", actualModel: model });
        if (!response.ok) throw classify(response.status, await errorDetail(response));
        let contentSeen = false;
        let finishReason = "stop";
        for await (const raw of sse(response, signal)) {
          clearTimeout(timer);
          if (!raw || raw === "[DONE]") continue;
          let frame;
          try { frame = JSON.parse(raw); } catch { continue; }
          if (!frame || typeof frame !== "object") continue;
          if (frame.error) throw classify(Number(frame.error.status) || 502, JSON.stringify(frame.error));
          const choice = frame.choices?.[0];
          if (choice) {
            const delta = choice.delta && hasContent(choice.delta) ? choice.delta : null;
            if (delta) { contentSeen = true; yield { type: "delta", delta }; }
            if (choice.finish_reason) {
              finishReason = String(choice.finish_reason);
              // 假答复：HTTP 200 + finish_reason=content_filter
              if (finishReason === "content_filter") throw classify(400, "content_filter");
            }
          }
          const usage = usageEvent(frame.usage);
          if (usage) yield usage;
        }
        if (!contentSeen) throw fail(502, "EMPTY_UPSTREAM_RESPONSE", "OfficeAce 返回空正文（常见于 max_tokens 预算过小，推理吃光了全部额度）");
        yield { type: "finish", reason: finishReason };
      } catch (error) {
        if (error?.forwardError) throw error;
        if (signal.aborted) throw fail(504, "UPSTREAM_TIMEOUT", "OfficeAce 请求已取消或超时");
        throw classify(Number(error?.status) || 502, error?.message);
      } finally {
        clearTimeout(timer);
        try { await response?.body?.cancel(); } catch { /* 已关闭 */ }
      }
    },
  };
}

module.exports = { createOfficeAce, normalizeBase, chatEndpoint, rewriteBody, budgetOf, classify, REASONING_ALLOWANCE, TINY_MAX_TOKENS };
