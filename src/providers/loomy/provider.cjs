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
"use strict";
const { descriptor } = require("../../model-descriptor.cjs");
// Loomy model execution only. Login, parsing, balance, check-in and refresh stay
// in the original host management chain. No host source/store imports here.
const images = require("./images.cjs");
const { forwardError } = require("../../../sdk/runtime/provider.cjs");
const { hasContent } = require("../../../sdk/provider-protocol.cjs");
const { withContentRemediation } = require("../../execution/content-remediation.cjs");
const { isContentBlock } = require("../../execution/degrade.cjs");

const authCode = code => new Set(["020002", "100002"]).has(String(code || ""));
function errorFor(status, code, detail = "") {
  const content = [400, 403, 451].includes(status) && isContentBlock(detail);
  const auth = !content && (status === 401 || status === 403 || authCode(code));
  const rate = status === 429;
  const error = forwardError({
    code: content ? "CONTENT_REJECTED" : auth ? "AUTH_REQUIRED" : rate ? "RATE_LIMITED" : "UPSTREAM_FAILED",
    message: auth ? "Loomy 登录态已失效，请在号池重新登录" : rate ? "Loomy 上游请求受限" : "Loomy 模型上游返回错误",
    category: auth ? "auth" : rate ? "rate" : "upstream",
    scope: auth ? "account" : rate ? "account-model" : "invocation",
    replay: content || auth || rate ? "safe" : "unknown", status: content ? status : auth ? 401 : rate ? 429 : 502,
  });
  // Classification detail stays inside the plugin; SDK serializes only the
  // validated, redacted forwardError fields, never this private response body.
  Object.defineProperty(error, "privateDetail", { value: detail });
  return error;
}

function parseModels(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
  const seen = new Set();
  return rows.flatMap(row => {
    const id = String(row?.id || "").trim();
    if (!id || id.length > 160 || seen.has(id.toLowerCase())) return [];
    const protocol = String(row?.protocol || "openai").trim().toLowerCase();
    if (["anthropic", "anthropic_messages"].includes(protocol) || row?.type === "image"
      || (Array.isArray(row?.output_modalities) && row.output_modalities.includes("image"))) return [];
    seen.add(id.toLowerCase());
    const rawName = String(row?.name || id).trim();
    const suffix = /\s*[（(]\s*x([0-9]+(?:\.[0-9]+)?)\s*[）)]\s*$/i.exec(rawName);
    const caps = row?.capabilities && typeof row.capabilities === "object" ? row.capabilities : {};
    const modalities = Array.isArray(caps.input_modalities) ? caps.input_modalities.map(value => String(value).toLowerCase()) : [];
    const capabilities = {
      tools: caps.function_calling === true || row?.capabilities === undefined,
      reasoning: caps.reasoning === true || /spark-x/i.test(id),
      images: caps.vision === true || modalities.includes("image"),
      video: modalities.includes("video"),
    };
    const positive = (...values) => values.map(Number).find(value => Number.isSafeInteger(value) && value > 0);
    return [descriptor({
      id,
      name: suffix ? rawName.slice(0, suffix.index).trim() || id : rawName,
      ...(suffix ? { rate: Number(suffix[1]) } : {}),
      capabilities,
      contextLength: positive(row.context_length, row.context_window, row.input_token_limit, row.max_input_tokens, row.maxInputTokens),
      maxOutputTokens: positive(row.max_output_tokens, row.max_completion_tokens, row.max_tokens, row.maxOutputTokens),
    })];
  });
}

async function refreshModels(ctx, settings) {
  const credentials = await ctx.pool.credentials();
  const token = String(credentials?.token || "").trim();
  if (!token) throw errorFor(401);
  const base = String(settings.modelBase || "https://loomyad.xunfei.cn/api/v1").replace(/\/+$/, "");
  let response;
  try {
    response = await ctx.pool.network().fetch(`${base}/models`, { method: "GET", redirect: "error", signal: ctx.signal,
      headers: { token, Authorization: `Bearer ${token}`, Accept: "application/json" } });
  } catch { throw forwardError({ code: "CATALOG_REFRESH_FAILED", message: "Loomy 上游模型目录请求失败", category: "network", scope: "service", replay: "safe", status: 502 }); }
  if (!response.ok) throw errorFor(response.status);
  let payload;
  try { payload = await response.json(); }
  catch { throw forwardError({ code: "INVALID_CATALOG_RESPONSE", message: "Loomy 模型目录格式无法解析", category: "protocol", scope: "service", replay: "safe", status: 502 }); }
  const code = String(payload?.code ?? "");
  if (code && code !== "000000") throw errorFor(["020002", "100002", "20002"].includes(code) ? 401 : 502, code);
  const models = parseModels(payload);
  if (!models.length) throw forwardError({ code: "EMPTY_CATALOG", message: "Loomy 上游模型目录为空或没有可用的对话模型", category: "protocol", scope: "service", replay: "safe", status: 502 });
  return models;
}

async function errorDetail(response) {
  if (!response.body) return "";
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 64 * 1024) throw new Error("Upstream error response exceeds limit");
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { try { await reader.cancel(); } finally { reader.releaseLock(); } }
}

async function* sse(response, signal) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "", data = [];
  try {
    while (true) {
      signal.throwIfAborted();
      const read = await reader.read();
      buffer += read.done ? decoder.decode() : decoder.decode(read.value, { stream: true });
      if (Buffer.byteLength(buffer, "utf8") > 1024 * 1024) throw new Error("SSE buffer exceeds limit");
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (!line) {
          if (data.length) { yield data.join("\n"); data = []; }
        } else if (line.startsWith("data:")) {
          data.push(line.slice(5).replace(/^ /, ""));
          if (Buffer.byteLength(data.join("\n"), "utf8") > 1024 * 1024) throw new Error("SSE event exceeds limit");
        }
      }
      if (read.done) break;
    }
    if (buffer.startsWith("data:")) data.push(buffer.slice(5).replace(/^ /, ""));
    if (data.length) yield data.join("\n");
  } finally {
    try { await reader.cancel(); } catch { /* Already closed/aborted. */ }
    reader.releaseLock();
  }
}

function createLoomy(settings = {}) {
  return {
    id: "loomy", channels: ["loomy"],
    async listModels(request, ctx) {
      const context = request.grantId ? await ctx.pool.context() : {};
      if (request.force === true) return refreshModels(ctx, settings);
      return (context.models || settings.models || []).map(descriptor);
    },
    async *invoke(request, ctx) {
      const secrets = await ctx.pool.credentials();
      const token = String(secrets.token || "").trim();
      if (!token) throw errorFor(401);
      const requestedModel = String(request.input.model || request.model);
      const execute = async function* (input) {
        let body = { ...input, model: request.model, stream: true };
        if (images.prefersTagFormat(requestedModel)) body = images.rewriteToTag(body).body;
        const base = String(settings.modelBase || "https://loomyad.xunfei.cn/api/v1").replace(/\/+$/, "");
        const payload = JSON.stringify(body);
        // Same prompt-sensitive first-event budget shape as the original channel.
        const estimate = Math.ceil(payload.length / 3);
        const timeoutSetting = (key, fallback) => Number.isFinite(Number(settings[key])) && Number(settings[key]) > 0 ? Math.round(Number(settings[key])) : fallback;
        const firstMs = Math.min(timeoutSetting("firstByteMaxMs", 180000), timeoutSetting("firstByteBaseMs", 30000) + Math.floor(estimate / 10000) * 1000);
        const firstController = new AbortController();
        const signal = AbortSignal.any([ctx.signal, firstController.signal]);
        const timer = setTimeout(() => firstController.abort(new Error("First model event timed out")), Math.min(firstMs, Math.max(1, ctx.deadlineAt - Date.now())));
        let response;
        try {
          // SDK egress integration will supply proxy/TLS configuration; the plain
          // fetch path is kept inside this external plugin, never in the host.
        response = await ctx.pool.network().fetch(`${base}/chat/completions`, {
            method: "POST", redirect: "error", signal,
            headers: { "Content-Type": "application/json", token, Authorization: `Bearer ${token}`, Accept: "text/event-stream" },
            body: payload,
          });
          if (!response.ok) {
            const detail = await errorDetail(response);
            let parsed;
            try { parsed = JSON.parse(detail); } catch { /* Plain text errors are also classified privately. */ }
            const data = parsed?.error || parsed;
            throw errorFor(response.status, data?.code || data?.error_code, detail);
          }
          let finishReason = "", contentSeen = false;
          let error = null;
          for await (const raw of sse(response, signal)) {
            clearTimeout(timer);
            if (!raw || raw === "[DONE]") continue;
            let chunk;
            try { chunk = JSON.parse(raw); } catch { continue; }
            if (!chunk || typeof chunk !== "object") continue;
            const errBody = chunk.error || chunk;
            const code = errBody.code || errBody.error_code;
            const message = errBody.message || errBody.error_msg || errBody.msg;
            if ((code && message) || authCode(chunk.code)) {
              error = errorFor(authCode(chunk.code) ? 401 : 502, code || chunk.code, String(message || ""));
              continue;
            }
            if (error) continue;
            const choice = Array.isArray(chunk.choices) && chunk.choices[0];
            if (choice?.delta && Object.keys(choice.delta).length) {
              contentSeen ||= hasContent(choice.delta);
              yield { type: "delta", delta: choice.delta };
            }
            if (choice?.finish_reason) finishReason = choice.finish_reason;
            if (chunk.usage) yield { type: "usage", mode: "snapshot", usage: {
              ...chunk.usage,
              prompt_tokens: Number(chunk.usage.prompt_tokens) || 0,
              completion_tokens: Number(chunk.usage.completion_tokens) || 0,
              total_tokens: Number(chunk.usage.total_tokens) || 0,
            } };
          }
          if (error) throw error;
          if (!contentSeen) throw errorFor(502);
          yield { type: "finish", reason: finishReason };
        } finally {
          clearTimeout(timer);
          try { await response?.body?.cancel(); } catch { /* Reader may own lock. */ }
        }
      };
      yield* withContentRemediation({ input: request.input, execute, signal: ctx.signal,
        async reserveAttempt() {
          // No legacy local counter fallback: a second send is permitted only
          // by the host's shared gateway-request budget.
          if (!ctx.attempts) return false;
          await ctx.attempts.next("content-remediation");
          return true;
        } });
    },
  };
}
module.exports = { createLoomy, parseModels };
