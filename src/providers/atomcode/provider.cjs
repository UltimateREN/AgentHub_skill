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
// AtomCode（AtomGit / GitCode）：**同方言透传**，本仓库最薄的一层。
// 依据 Agent2Providers `atomcode/chat.rs` 与 `endpoints.rs` 模块头。
//
// ── 只改三处（每处都有非改不可的理由）────────────────────────────
//   1. `model`：客户端点的是**展示名**，网关只认自己的 id（`glm5.3-flash`）。
//      不做这一步网关**不会报错**，它会回 `HTTP 200 + 正文「参数错误」`。
//      同时剥掉账号前缀（`<accountId>/<model>`，多账号消歧用）。
//   2. `stream_options`：官方客户端无条件发 `{"include_usage": true}`，
//      网关据此才吐尾部 usage 帧（客户端显式指定就让它赢）。
//   3. 其余（messages / tools / tool_choice / temperature / max_tokens /
//      reasoning_effort / 图片分片）**一律不动**。
//
// ── UA 是功能性的（最容易被「清理」掉的一条）──────────────────────
// 网关按 UA 决定是否索要闭源签名：自称 `atomcode/<ver>` 会立刻
// `403 ATOMCODE_SIG_MISSING`。故这里如实标识本仓库自己。
//
// ── 网关「假成功」──────────────────────────────────────────────
// `HTTP 200 + 正文「参数错误」`（或一页 HTML 报错）—— 必须按文案判定。
// 拒绝标志：`在当前 CodingPlan 用量窗口内已达上限` → 按配额处置（罚账号 + 换家）。
"use strict";
const { descriptor } = require("../../model-descriptor.cjs");
const { sse, errorDetail } = require("../../network/sse.cjs");
const { forwardError, hasContent } = require("../../../sdk/provider-protocol.cjs");

const DEFAULT_GATEWAY = "https://api-ai.gitcode.com/v1";
/** 功能性常量：绝不能自称 atomcode/<ver> */
const ADAPTER_USER_AGENT = "agenthub-atomcode/0.1.0";
/** 网关把失败包成 HTTP 200 + 正文（文案判定） */
const FAKE_PARAM_ERROR = /参数错误/;
const FAKE_HTML = /^\s*<(!doctype|html)/i;
/** 配额用尽的拒绝标志 */
const QUOTA_MARKER = /在当前\s*CodingPlan\s*用量窗口内已达上限|用量窗口内已达上限/;
/** 账号前缀分隔符（目录里同名模型的消歧形态：`<accountId>/<model>`） */
const ACCOUNT_PREFIX_SEPARATOR = "/";

function fail(status, code, message, scope = "invocation", retryable = false) {
  return forwardError({
    code, message: String(message || "AtomCode 模型执行失败").slice(0, 1024),
    category: code === "AUTH_REQUIRED" ? "auth" : code === "QUOTA_EXHAUSTED" ? "quota"
      : code === "RATE_LIMITED" ? "rate" : "upstream",
    scope, replay: "unknown", retryable,
    status: status >= 400 && status <= 599 ? status : 502,
  });
}

/** 剥掉账号前缀：`<account>/glm5.3-flash` → `glm5.3-flash`。
 *  目录里的模型名本身不含 `/`，所以出现 `/` 就说明是我们自己的前缀。 */
function stripAccountPrefix(model) {
  const trimmed = String(model || "").trim();
  const at = trimmed.indexOf(ACCOUNT_PREFIX_SEPARATOR);
  if (at <= 0) return trimmed;
  const rest = trimmed.slice(at + 1).trim();
  return rest || trimmed;
}

function classify(status, detail) {
  const text = String(detail || "").slice(0, 2048);
  if (QUOTA_MARKER.test(text)) return fail(429, "QUOTA_EXHAUSTED", "AtomCode 当前用量窗口已用尽（换账号或等窗口重置）", "account", true);
  if (/ATOMCODE_SIG_MISSING/i.test(text)) return fail(403, "SIGNATURE_REQUIRED", "AtomCode 网关要求闭源签名（UA 被识别成官方客户端）。请检查 User-Agent 配置", "service", false);
  if (FAKE_PARAM_ERROR.test(text)) return fail(400, "MODEL_NOT_ACCEPTED", "AtomCode 网关返回「参数错误」（常见原因：模型名不是网关认的 id，或参数不被接受）");
  if (FAKE_HTML.test(text)) return fail(502, "UPSTREAM_HTML_ERROR", "AtomCode 网关返回了一页 HTML 报错（上游异常）", "invocation", true);
  if (status === 401 || status === 403) return fail(401, "AUTH_REQUIRED", "AtomCode 访问令牌失效，请重新登录", "account");
  if (status === 402) return fail(429, "QUOTA_EXHAUSTED", "AtomCode 额度不足（按限流处置）", "account", true);
  if (status === 429) return fail(429, "RATE_LIMITED", "AtomCode 上游限流", "account", true);
  if (status === 400 || status === 422) return fail(400, "INVALID_REQUEST", "AtomCode 拒绝了该请求（参数不合法）");
  return fail(status >= 400 && status <= 599 ? status : 502, "UPSTREAM_FAILED", "AtomCode 模型执行失败", "invocation", status >= 500);
}

/** 请求体：模型名映射 + stream_options 补全；其余原样 */
function rewriteBody(input, model) {
  const body = { ...(input || {}) };
  body.model = stripAccountPrefix(model || body.model);
  // 客户端显式指定 include_usage 就让它赢（官方客户端无条件发 true，但这里不覆盖用户意图）
  if (body.stream === true) body.stream_options = { include_usage: true, ...(body.stream_options || {}) };
  else if (body.stream_options) delete body.stream_options;
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

function createAtomCode(settings = {}) {
  const base = String(settings.gateway || settings.base || DEFAULT_GATEWAY).replace(/\/+$/, "");
  const agent = String(settings.userAgent || ADAPTER_USER_AGENT);
  return {
    id: "atomcode", channels: ["atomcode"], requiredFeatures: ["execution-facts@1"],
    async listModels(request, ctx) {
      if (!request.grantId) return [];
      const context = await ctx.pool.context();
      const models = (context.models || []).map(descriptor);
      // 不内置兜底清单：名义目录 ≠ 可达目录（实测同账号上不在名单的模型能调，
      // 名单里有的反而回「参数错误」/一页 HTML）
      return models;
    },
    async *invoke(request, ctx) {
      const credentials = await ctx.pool.credentials();
      const token = String(credentials?.token || "").trim();
      if (!token) throw fail(401, "AUTH_REQUIRED", "AtomCode 访问令牌缺失", "account");
      const context = await ctx.pool.context();
      const requested = String(request.model || "").trim();
      // 目录里存的是网关认的 id（display_model_name）；短名消歧交给宿主侧目录
      const hit = (context.models || []).find((entry) => String(entry.id || "").toLowerCase() === requested.toLowerCase());
      const model = String((hit && hit.id) || requested);
      const body = rewriteBody(request.input, model);
      const controller = new AbortController();
      const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;
      const timeoutMs = Math.max(1, Math.min(Number(settings.firstByteTimeoutMs) || 30000, Number.isFinite(ctx.deadlineAt) ? ctx.deadlineAt - Date.now() : 30000));
      const timer = setTimeout(() => controller.abort(new Error("AtomCode response timed out")), timeoutMs);
      timer.unref?.();
      let response;
      try {
        await ctx.attempts?.report({ state: "planned", actualModel: model });
        signal.throwIfAborted();
        response = await ctx.pool.network().fetch(`${base}/chat/completions`, {
          method: "POST", redirect: "error", signal,
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            accept: body.stream === true ? "text/event-stream" : "application/json",
            "user-agent": agent,
          },
          body: JSON.stringify(body),
        });
        await ctx.attempts?.report({ state: "responded", actualModel: model });
        const contentType = String(response.headers?.get?.("content-type") || "");
        if (!response.ok) throw classify(response.status, await errorDetail(response));
        // 假成功：HTTP 200 但正文是纯文本「参数错误」/ 一页 HTML
        if (!/text\/event-stream|application\/json/i.test(contentType)) {
          clearTimeout(timer);
          const text = await response.text().catch(() => "");
          throw classify(200, text);
        }
        let contentSeen = false;
        let finishReason = "stop";
        for await (const raw of sse(response, signal)) {
          clearTimeout(timer);
          if (!raw) continue;
          if (raw === "[DONE]") continue;
          let frame;
          try { frame = JSON.parse(raw); } catch { continue; }
          if (!frame || typeof frame !== "object") continue;
          if (frame.error) throw classify(Number(frame.error.status) || 502, JSON.stringify(frame.error));
          const choice = frame.choices?.[0];
          if (choice) {
            const delta = choice.delta && hasContent(choice.delta) ? choice.delta : null;
            if (delta) { contentSeen = true; yield { type: "delta", delta }; }
            if (choice.finish_reason) finishReason = String(choice.finish_reason);
          }
          const usage = usageEvent(frame.usage);
          if (usage) yield usage;
        }
        if (!contentSeen) throw fail(502, "EMPTY_UPSTREAM_RESPONSE", "AtomCode 返回空响应");
        yield { type: "finish", reason: finishReason };
      } catch (error) {
        if (error?.forwardError) throw error;
        if (signal.aborted) throw fail(504, "UPSTREAM_TIMEOUT", "AtomCode 请求已取消或超时");
        throw classify(Number(error?.status) || 502, error?.message);
      } finally {
        clearTimeout(timer);
        try { await response?.body?.cancel(); } catch { /* 已关闭 */ }
      }
    },
  };
}

module.exports = { createAtomCode, stripAccountPrefix, rewriteBody, classify, ADAPTER_USER_AGENT };
