"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { descriptor } = require("../../model-descriptor.cjs");
const { sse, errorDetail } = require("../../network/sse.cjs");
const { forwardError, hasContent } = require("../../../sdk/provider-protocol.cjs");
const signer = require("./signer.cjs");
const cosy = require("./cosy.cjs");

// 四个站点（依据 Agent2Providers qoder/endpoints.rs）：
//   Qoder 两站与千问办公两站**共用同一套协议栈**（同聊天路径、同 COSY 信封、
//   同一把服务端 RSA 公钥、国内版 client_id 与 Qoder CN 逐字相同），
//   差异只有一批客户端身份常量（COSY 头矩阵 / session_type / business）与主机。
// `cosy` 段 = 千问办公必须覆盖的头与请求体字段（Qoder 两站沿用 wasm 产出的头）。
const ENDPOINTS = Object.freeze({
  qoder: { gateway: "https://gateway.qoder.com.cn", agent: "qoder/0.4.8" },
  qoder_intl: { gateway: "https://api2.qoder.sh", agent: "qoder/0.4.8" },
  qwen_office: {
    gateway: "https://gateway.qwenwork.cn", agent: "qoderwork/1.1.0",
    cosy: { version: "1.1.52", clientType: "6", dataPolicy: "agree", scene: "qwork", businessProduct: "qoder_work", businessType: "agent" },
    sessionType: "qoder_work", businessProduct: "qoder_work", businessVersion: "1.1.52",
  },
  qwen_office_intl: {
    gateway: "https://gateway.qwenwork.ai", agent: "qoderwork/1.1.0",
    // 依据 Agent2Providers qoder/endpoints.rs：国际版与国内版**只差主机 / client_id /
    // redirect_uri 三条**，其余客户端常量沿用国内版（参考实现同口径，非本仓猜测）。
    cosy: { version: "1.1.52", clientType: "6", dataPolicy: "agree", scene: "qwork", businessProduct: "qoder_work", businessType: "agent" },
    sessionType: "qoder_work", businessProduct: "qoder_work", businessVersion: "1.1.52",
  },
});
// 千问办公的静态兜底（Agent2Providers qwenwork_fallback_models，2026-10-31 复核）。
// id = 上游 key（model_config.key 用它），name = 展示名。
const STATIC_QWENWORK_MODELS = [
  { id: "pro", name: "高级" },
  { id: "flash", name: "标准" },
  { id: "qwen3.8-max-preview", name: "Qwen3.8-Max" },
];
const STATIC_CN_MODELS = ["auto", "qfmodel", "qmodel_38max", "qmodel", "q37fmodel", "qmodel_latest", "dfmodel", "dmodel", "gfmodel", "gmodel", "gm51model", "kmodel", "kmodel_latest", "mmodel"];

function cachedCatalog(product, uid) {
  if (!/^[0-9a-zA-Z-]{1,128}$/.test(uid)) throw new Error("Qoder account ID is invalid");
  // 千问办公没有本机 catalog-v6（没有已取证的本机客户端目录）→ 直接抛，
  // 由 listModels 回落静态清单，而不是去读一个不存在的文件。
  if (product === "qwen_office" || product === "qwen_office_intl") throw new Error("QwenWork has no local catalog cache");
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
    // `enable` 是「当前账号当前套餐能不能用」，不是「客户端展不展示」。
    // 早先按 enable 过滤会把 17 条目录砍到 1 条（实测普通账号只有 Qwen3.8-Flash
    // 是 enable:true），与官方客户端的模型列表不符。目录保留全部**有展示名**的条目，
    // 可用性交给上游在请求时判定；缺 display_name 的是无效/退役条目，照旧丢弃。
    if (!model || !model.key || !model.display_name || models.has(model.key)) continue;
    const tiers = model.context_config && typeof model.context_config === "object" ? Object.values(model.context_config) : [];
    const contextLength = tiers.reduce((max, tier) => Math.max(max, Number(tier?.token_count) || 0), 0);
    models.set(model.key, { id: String(model.key), name: String(model.display_name || model.key),
      rate: model.price_factor == null ? null : Number(model.price_factor),
      capabilities: { reasoning: !!model.is_reasoning, tools: true, images: !!model.is_vl },
      contextLength: contextLength || Number(model.max_input_tokens) || 0, maxOutputTokens: 0 });
  }
  return [...models.values()];
}

/** 千问办公目录：`{qwork:[{key, display_name, max_input_tokens, is_vl, is_reasoning, …}]}`。
 *  对外 id 用 `display_name` 去空白（参考实现 toModelId），请求时再映射回 `key`；
 *  `key` 放 `routing.upstreamKey`——目录只保留公共字段 + routing 是宿主契约。 */
function qwenModelsFromCatalog(json) {
  const rows = Array.isArray(json?.qwork) ? json.qwork : [];
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const key = String(row.key || "").trim();
    const display = String(row.display_name || "").trim();
    if (!key || !display) continue;
    const id = display.replace(/\s+/g, "");
    if (!id || seen.has(id.toLowerCase())) continue;
    seen.add(id.toLowerCase());
    const tiers = row.context_config && typeof row.context_config === "object" ? Object.values(row.context_config) : [];
    const contextLength = tiers.reduce((max, tier) => Math.max(max, Number(tier?.token_count) || 0), 0);
    out.push({
      id, name: display,
      rate: row.price_factor == null ? null : Number(row.price_factor),
      capabilities: { reasoning: !!row.is_reasoning, tools: true, images: !!row.is_vl },
      contextLength: contextLength || Number(row.max_input_tokens) || 0,
      // 参考实现固定 32768（超过后上游会退化/空正文），不读目录里的输出上限
      maxOutputTokens: 32768,
      routing: { upstreamKey: key },
    });
  }
  return out;
}

/** 上游目录信封：`{statusCodeValue, body:"{...}"}` / `{data:{...}}` / 裸对象 */
function catalogPayload(value) {
  let node = value;
  for (let depth = 0; depth < 4; depth++) {
    if (!node || typeof node !== "object") return null;
    const code = Number(node.statusCodeValue ?? node.code);
    if (Number.isFinite(code) && code !== 0 && code !== 200) {
      throw new Error(`上游返回业务错误 ${code}: ${String(node.message || node.msg || "").slice(0, 200)}`);
    }
    if (typeof node.body === "string" && node.body.trim().startsWith("{")) {
      try { node = JSON.parse(node.body); continue; } catch { return null; }
    }
    if (node.body && typeof node.body === "object") { node = node.body; continue; }
    if (node.qwork || node.chat) return node;
    if (node.data && typeof node.data === "object") { node = node.data; continue; }
    return node;
  }
  return node;
}

/** 千问办公远端目录：`GET {gateway}/algo/api/v2/model/list?Encode=1`（COSY 纯 crypto 签名） */
async function fetchQwenCatalog(ctx, gateway, defaults) {
  const credentials = await ctx.pool.credentials();
  const context = await ctx.pool.context();
  const uid = String(context.uid || "");
  const token = String(credentials?.token || "");
  const machineId = String(context.identity?.machineId || "");
  if (!uid || !token) throw new Error("QwenWork 目录缺少账号凭据");
  const url = `${gateway.replace(/\/+$/, "")}/algo/api/v2/model/list?Encode=1`;
  const headers = cosy.buildAuthHeaders({
    url, body: null,
    identity: { uid, token, machineId },
    site: { ...(defaults.cosy || {}), isQwenwork: true, userAgent: defaults.agent },
  });
  const response = await ctx.pool.network().fetch(url, { method: "GET", headers, redirect: "error", signal: ctx.signal });
  if (!response.ok) throw new Error(`QwenWork 目录请求失败 HTTP ${response.status}`);
  const text = await response.text();
  let value;
  try { value = JSON.parse(text); } catch { throw new Error("QwenWork 目录返回不是有效 JSON"); }
  const payload = catalogPayload(value);
  const models = qwenModelsFromCatalog(payload);
  if (!models.length) throw new Error("QwenWork 目录为空或格式已变化");
  return models;
}

/** Qoder 远端目录：`GET {gateway}algo/api/v2/model/list?Encode=1`（COSY 签名，GET 空体）。
 *  站点常量依据 Agent2Providers qoder/endpoints.rs：Qoder 两站 clientType=5、
 *  dataPolicy=disagree、cosyVersion=1.1.38，且**不发** Cosy-Scene / Business-* 头。 */
async function fetchQoderCatalog(ctx, gateway) {
  const credentials = await ctx.pool.credentials();
  const context = await ctx.pool.context();
  const uid = String(context.uid || "");
  const token = String(credentials?.token || "");
  const machineId = String(context.identity?.machineId || "");
  if (!uid || !token) throw new Error("Qoder 目录缺少账号凭据");
  const url = `${gateway.replace(/\/+$/, "")}/algo/api/v2/model/list?Encode=1`;
  const headers = cosy.buildAuthHeaders({
    url, body: null,
    identity: { uid, token, machineId },
    site: { version: "1.1.38", clientType: "5", dataPolicy: "disagree" },
  });
  const response = await ctx.pool.network().fetch(url, { method: "GET", headers, redirect: "error", signal: ctx.signal });
  if (!response.ok) throw new Error(`Qoder 目录请求失败 HTTP ${response.status}`);
  const text = await response.text();
  let value;
  try { value = JSON.parse(text); } catch { throw new Error("Qoder 目录返回不是有效 JSON"); }
  const models = modelsFromCatalog(catalogPayload(value));
  if (!models.length) throw new Error("Qoder 目录为空或格式已变化");
  return models;
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

/** 千问办公推理请求（纯 COSY，不依赖本机 wasm）：只有 wasm 签名器不可用时才走这条。
 *  参考 Agent2Providers `qoder/chat.rs`：请求体**先编码再签名**，
 *  URL 固定带 `FetchKeys/AgentId/Encode=1`，并补 `X-Model-Key` / `X-Model-Source`。 */
function qwenInferRequest(gateway, payload, upstreamKey, identity, defaults) {
  const json = JSON.stringify(payload);
  const body = cosy.encodeBody(Buffer.from(json, "utf8"));
  const url = `${String(gateway).replace(/\/+$/, "")}/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`;
  const headers = cosy.buildAuthHeaders({
    url, body,
    identity,
    site: { ...(defaults.cosy || {}), isQwenwork: true, userAgent: defaults.agent },
  });
  headers["Content-Type"] = "application/json";
  headers.Accept = "text/event-stream";
  headers["Cache-Control"] = "no-cache";
  headers["Accept-Encoding"] = "identity";
  headers["X-Model-Key"] = upstreamKey;
  headers["X-Model-Source"] = "system";
  return { url, headers, body };
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
        // 千问办公：远端目录用纯 Node crypto 的 COSY 签名拉取，不依赖本机 wasm
        // （wasm 的 prepareInferRequest 把 URL 硬编码成推理路径，签不了目录）。
        if (defaults.cosy) {
          try {
            return await fetchQwenCatalog(ctx, gateway, defaults);
          } catch (error) {
            throw fail(502, `千问办公目录拉取失败：${String(error?.message || error).slice(0, 200)}`);
          }
        }
        const credentials = await ctx.pool.credentials();
        const uid = String(context.uid || "");
        const token = String(credentials?.token || "");
        if (!uid || !token) throw fail(401, "Qoder 模型目录缺少账号凭据");
        // Qoder 两站：先试远端目录（COSY 签 GET，无需本机客户端）；失败再回落到
        // 本机 catalog-v6。远端失败不改变「目录为空就是空」的语义，只是少一条来源。
        if (!defaults.cosy) {
          try { return await fetchQoderCatalog(ctx, gateway); }
          catch { /* 回落到本机目录 */ }
        }
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
      // 千问办公：尚未刷新目录时 context.models 为空 → 用静态三条兜底，保证开箱可用。
      if (!models.length && defaults.cosy) return STATIC_QWENWORK_MODELS.map(row => ({ ...row, capabilities: { tools: true } }));
      return models;
    },
    async *invoke(request, ctx) {
      const credentials = await ctx.pool.credentials();
      const context = await ctx.pool.context();
      const token = String(credentials?.token || "");
      const uid = String(context.uid || "");
      const machineId = String(context.identity?.machineId || "");
      if (!token || !uid || !machineId) throw fail(401, "Qoder 执行凭据或机器标识不可用");

      let session = null;
      try { session = await signerApi.createSession({ product, token, uid, machineId }); }
      catch (error) {
        // 千问办公有纯 Node crypto 的 COSY 实现：本机没装 Qoder 客户端也能签名。
        // Qoder 两站仍必须用 wasm（它的风险身份 / 请求形态只有客户端里有）。
        if (!defaults.cosy) throw fail(503, "Qoder 本机签名器不可用，请检查对应客户端是否已安装或更新");
      }
      let seen = false;
      try {
        const input = request.input || {};
        const modelId = String(request.model || "").trim().toLowerCase();
        const model = (context.models || []).find(entry => String(entry.id || "").toLowerCase() === modelId) || {};
        // 千问办公的目录 id 是展示名（去空白），上游要的是 key；目录条目把它放在
        // routing.upstreamKey。旧目录/静态清单没有 routing 时按静态三条的 id/name 反查。
        const staticRow = STATIC_QWENWORK_MODELS.find(row => row.id === modelId || row.name === request.model);
        const upstreamKey = String(model.routing?.upstreamKey || staticRow?.id || modelId);
        const reqId = crypto.randomUUID();
        // 千问办公的请求体多三项（依据 Agent2Providers qoder/endpoints.rs）：
        //   session_type 必须与 Cosy-ClientType 一致（body 说 qodercli、头说 6 会被直接拒），
        //   business.product / business.version 也是客户端身份的一部分。
        const qwen = defaults.sessionType ? {
          session_type: defaults.sessionType,
          business: { product: defaults.businessProduct, version: defaults.businessVersion },
        } : { business: {} };
        const payload = {
          session_id: crypto.randomUUID(), source_session_id: "", request_id: reqId, request_set_id: reqId,
          model_config: { key: upstreamKey, display_name: model.name || request.model || upstreamKey, model: "", format: "openai",
            is_vl: model.capabilities?.images === true, is_reasoning: model.capabilities?.reasoning === true,
            api_key: "", url: "", source: "system",
            // 上下文声明：目录给了就照抄，没给按站点上限（千问办公客户端声明 1.024M；
            // 上游按声明值硬拒超长，两处不一致会变成「界面写 128K、请求按 1M 发」）
            max_input_tokens: Number(model.contextLength) || (defaults.cosy ? 1024000 : 180000) },
          messages: messagesOf(input.messages), tools: toolsOf(input.tools), ...qwen,
          ...(input.temperature != null ? { temperature: input.temperature } : {}),
          ...(input.max_tokens != null ? { max_tokens: input.max_tokens } : {}),
          ...(input.stop != null ? { stop: input.stop } : {}),
          ...(input.reasoning_effort ? { reasoning_effort: input.reasoning_effort } : {}),
        };
        let signed;
        if (session) {
          signed = session.prepareInferRequest(gateway, JSON.stringify(payload), upstreamKey, model.source || "system");
          // 千问办公：wasm 是 Qoder 客户端的，产出的 Cosy-* 头是 Qoder 身份（clientType 5 /
          // dataPolicy disagree）。千问办公要 6 / agree / scene=qwork / business 双头，
          // 故签名后**覆盖**这几个常量头（签名覆盖的是 body 与 url，不含这些身份常量）。
          if (defaults.cosy) {
            const c = defaults.cosy;
            for (const key of Object.keys(signed.headers)) if (/^cosy-/i.test(key)) delete signed.headers[key];
            Object.assign(signed.headers, {
              "Cosy-Version": c.version,
              "Cosy-ClientType": c.clientType,
              "Cosy-Data-Policy": c.dataPolicy,
              "Cosy-Scene": c.scene,
              "Cosy-Business-Product": c.businessProduct,
              "Cosy-Business-Type": c.businessType,
              "User-Agent": defaults.agent,
            });
          }
        } else {
          signed = qwenInferRequest(gateway, payload, upstreamKey, { uid, token, machineId }, defaults);
        }
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
      } finally { try { session?.free?.(); } catch {} }
    },
  };
}

module.exports = { createQoder, messagesOf, toolsOf, parseQueueAdvice, cachedCatalog, modelsFromCatalog, qwenModelsFromCatalog, catalogPayload, fetchQwenCatalog, qwenInferRequest };
