"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { descriptor } = require("../../model-descriptor.cjs");
const { sse, errorDetail } = require("../../network/sse.cjs");
const { forwardError, hasContent } = require("../../../sdk/provider-protocol.cjs");
const signer = require("./signer.cjs");

const ENDPOINTS = Object.freeze({
  qoder: { gateway: "https://gateway.qoder.com.cn", agent: "qoder/0.4.8" },
  qoder_intl: { gateway: "https://api2.qoder.sh", agent: "qoder/0.4.8" },
});
const STATIC_CN_MODELS = ["auto", "qfmodel", "qmodel_38max", "qmodel", "q37fmodel", "qmodel_latest", "dfmodel", "dmodel", "gfmodel", "gmodel", "gm51model", "kmodel", "kmodel_latest", "mmodel"];

function cachedCatalog(product, uid) {
  if (!/^[0-9a-zA-Z-]{1,128}$/.test(uid)) throw new Error("Qoder account ID is invalid");
  const home = process.env.USERPROFILE || os.homedir();
  const directory = product === "qoder" ? ".qoder-cn" : ".qoder";
  const filename = path.join(home, directory, ".models", uid, "catalog-v6");
  const stat = fs.statSync(filename);
  if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error("Qoder model catalog cache is invalid");
  return fs.readFileSync(filename, "utf8");
}

function modelsFromCatalog(json) {
  const preferred = "assistant";
  const scenes = [preferred, "chat", "quest", "developer", ...Object.keys(json || {})];
  const models = new Map();
  for (const scene of scenes) for (const model of Array.isArray(json?.[scene]) ? json[scene] : []) {
    if (!model || !model.key || model.enable === false || models.has(model.key)) continue;
    const tiers = model.context_config && typeof model.context_config === "object" ? Object.values(model.context_config) : [];
    const contextLength = tiers.reduce((max, tier) => Math.max(max, Number(tier?.token_count) || 0), 0);
    models.set(model.key, { id: String(model.key), name: String(model.display_name || model.key),
      rate: model.price_factor == null ? null : Number(model.price_factor),
      capabilities: { reasoning: !!model.is_reasoning, tools: true, images: !!model.is_vl },
      contextLength: contextLength || Number(model.max_input_tokens) || 0, maxOutputTokens: 0 });
  }
  return [...models.values()];
}

function fail(status, message, seen = false, retryAfterMs) {
  const quota = status === 402 || status === 116;
  const rate = status === 429 || status === 10605;
  const auth = status === 401 || status === 403;
  return forwardError({
    code: quota ? "QUOTA_EXHAUSTED" : rate ? "RATE_LIMITED" : auth ? "AUTH_REQUIRED" : "UPSTREAM_FAILED",
    message: String(message || "Qoder 模型执行失败").slice(0, 1024),
    category: quota ? "quota" : rate ? "rate" : auth ? "auth" : "upstream",
    scope: quota || rate || auth ? "account" : "invocation",
    replay: seen ? "unsafe" : "unknown", retryable: !seen && (rate || status >= 500), status: status >= 400 && status <= 599 ? status : 502,
    ...(retryAfterMs ? { retryAfterMs: Math.min(86400000, retryAfterMs) } : {}),
  });
}

function messagesOf(messages) {
  const system = [], rest = [];
  for (const source of Array.isArray(messages) ? messages : []) {
    if (!source || typeof source !== "object") continue;
    let role = String(source.role || "user");
    if (role === "developer") role = "system";
    if (!["system", "user", "assistant", "tool"].includes(role)) continue;
    let content = source.content;
    if (typeof content === "string") content = [{ type: "text", text: content }];
    else if (Array.isArray(content)) content = content.map(part => {
      if (part?.type === "text" && typeof part.text === "string") return { type: "text", text: part.text };
      if (part?.type === "image_url") return { type: "image_url", image_url: part.image_url };
      return null;
    }).filter(Boolean);
    else content = [];
    const item = { role, content };
    if (Array.isArray(source.tool_calls) && source.tool_calls.length) item.tool_calls = source.tool_calls;
    if (source.tool_call_id) item.tool_call_id = source.tool_call_id;
    if (source.name) item.name = source.name;
    if (content.length || item.tool_calls?.length) (role === "system" ? system : rest).push(item);
  }
  return [...system, ...rest];
}

function toolsOf(tools) {
  return Array.isArray(tools) ? tools.filter(tool => tool?.type === "function" && tool.function?.name)
    .map(tool => ({ type: "function", function: tool.function })) : [];
}

function parseQueueAdvice(value) {
  let node = value;
  for (let i = 0; i < 5 && node && typeof node === "object"; i++) {
    const seconds = Number(node.retryAfterSeconds ?? node.retry_after_seconds ?? node.waitTime ?? node.wait_time);
    if (Number.isFinite(seconds) && seconds > 0) return Math.floor(seconds * 1000);
    const next = node.message ?? node.body ?? node.data;
    if (typeof next === "string") { try { node = JSON.parse(next); continue; } catch { break; } }
    node = next;
  }
  return 0;
}

function createQoder(product, settings = {}, signerApi = signer) {
  if (!Object.hasOwn(ENDPOINTS, product)) throw new TypeError("Unknown Qoder product");
  const defaults = ENDPOINTS[product];
  const gateway = String(settings[product]?.gateway || settings.gateway || defaults.gateway).replace(/\/+$/, "");
  const agent = String(settings[product]?.userAgent || settings.userAgent || defaults.agent);
  return {
    id: product, channels: [product], requiredFeatures: ["explicit-retry-policy@1"],
    async listModels(request, ctx) {
      const context = request.grantId ? await ctx.pool.context() : {};
      if (request.force === true) {
        const credentials = await ctx.pool.credentials();
        const uid = String(context.uid || "");
        const token = String(credentials?.token || "");
        if (!uid || !token) throw fail(401, "Qoder 模型目录缺少账号凭据");
        const session = await signerApi.createSession({ product, token, uid, machineId: String(context.identity?.machineId || "") });
        try {
          const decrypted = session.modelCacheDecrypt(cachedCatalog(product, uid), uid);
          const catalog = modelsFromCatalog(JSON.parse(decrypted));
          if (!catalog.length) throw new Error("Qoder model catalog is empty");
          return catalog;
        } catch { throw fail(502, "Qoder 本机模型目录读取或解密失败"); }
        finally { try { session.free?.(); } catch {} }
      }
      const models = (context.models || []).map(descriptor);
      if (!models.length && product === "qoder") return STATIC_CN_MODELS.map(id => ({ id }));
      return models;
    },
    async *invoke(request, ctx) {
      const credentials = await ctx.pool.credentials();
      const context = await ctx.pool.context();
      const token = String(credentials?.token || "");
      const uid = String(context.uid || "");
      const machineId = String(context.identity?.machineId || "");
      if (!token || !uid || !machineId) throw fail(401, "Qoder 执行凭据或机器标识不可用");

      let session;
      try { session = await signerApi.createSession({ product, token, uid, machineId }); }
      catch { throw fail(503, "Qoder 本机签名器不可用，请检查对应客户端是否已安装或更新"); }
      let seen = false;
      try {
        const input = request.input || {};
        const modelId = String(request.model || "").trim().toLowerCase();
        const model = (context.models || []).find(entry => String(entry.id || "").toLowerCase() === modelId) || {};
        const reqId = crypto.randomUUID();
        const payload = {
          session_id: crypto.randomUUID(), source_session_id: "", request_id: reqId, request_set_id: reqId,
          model_config: { key: modelId, display_name: model.name || modelId, model: "", format: "openai",
            is_vl: model.capabilities?.images === true, is_reasoning: model.capabilities?.reasoning === true,
            api_key: "", url: "", source: "system", max_input_tokens: Number(model.contextLength) || 180000 },
          messages: messagesOf(input.messages), tools: toolsOf(input.tools), business: {},
          ...(input.temperature != null ? { temperature: input.temperature } : {}),
          ...(input.max_tokens != null ? { max_tokens: input.max_tokens } : {}),
          ...(input.stop != null ? { stop: input.stop } : {}),
          ...(input.reasoning_effort ? { reasoning_effort: input.reasoning_effort } : {}),
        };
        const signed = session.prepareInferRequest(gateway, JSON.stringify(payload), modelId, "system");
        const response = await ctx.pool.network().fetch(signed.url, {
          method: "POST", headers: signed.headers, body: signed.body, redirect: "error", signal: ctx.signal,
        });
        if (!response.ok) {
          const raw = await errorDetail(response);
          let parsed; try { parsed = JSON.parse(raw); } catch { parsed = {}; }
          const inner = parsed?.message && typeof parsed.message === "string" ? (() => { try { return JSON.parse(parsed.message); } catch { return {}; } })() : parsed;
          const code = Number(inner?.code || parsed?.code);
          throw fail(response.status === 403 && code === 10605 ? 10605 : response.status === 403 && code === 116 ? 116 : response.status,
            inner?.message || parsed?.message || "Qoder 上游请求失败", false, code === 10605 ? parseQueueAdvice(inner) : 0);
        }
        let finish = "stop";
        for await (const raw of sse(response, ctx.signal)) {
          if (!raw) continue;
          let envelope; try { envelope = JSON.parse(raw); } catch { continue; }
          const statusCode = String(envelope.statusCode || "");
          if (statusCode && statusCode !== "OK") {
            let body; try { body = JSON.parse(envelope.body); } catch { body = {}; }
            const code = Number(body.code || body.errorCode);
            const message = String(body.message || body.error || statusCode);
            if (code === 101 || /Signature invalid/i.test(message)) throw forwardError({
              code: "SIGNATURE_REJECTED", message: "Qoder 签名被上游拒绝，请更新 Qoder 客户端后重试",
              category: "upstream", scope: "service", replay: seen ? "unsafe" : "unknown", retryable: false, status: 502,
            });
            if (code === 116 || /quota exceeded/i.test(message)) throw fail(116, message, seen);
            if (code === 10605 || /排队/.test(message)) throw fail(10605, "Qoder 模型排队中", seen, parseQueueAdvice(body));
            throw fail(/token|unauthor/i.test(message) ? 401 : 502, message, seen);
          }
          if (typeof envelope.body !== "string") continue;
          if (envelope.body === "[DONE]") continue;
          let chunk; try { chunk = JSON.parse(envelope.body); } catch { continue; }
          if (!chunk || typeof chunk !== "object") continue;
          const choice = chunk.choices?.[0];
          if (choice?.delta && Object.keys(choice.delta).length) {
            if (hasContent(choice.delta)) seen = true;
            yield { type: "delta", delta: choice.delta };
          }
          if (choice?.finish_reason) finish = String(choice.finish_reason);
          if (chunk.usage) yield { type: "usage", mode: "snapshot", usage: {
            prompt_tokens: Number(chunk.usage.prompt_tokens) || 0,
            completion_tokens: Number(chunk.usage.completion_tokens) || 0,
            total_tokens: Number(chunk.usage.total_tokens) || 0,
          } };
        }
        if (!seen) throw fail(502, "Qoder 上游返回空响应", false);
        yield { type: "finish", reason: finish };
      } finally { try { session.free?.(); } catch {} }
    },
  };
}

module.exports = { createQoder, messagesOf, toolsOf, parseQueueAdvice, cachedCatalog, modelsFromCatalog };
