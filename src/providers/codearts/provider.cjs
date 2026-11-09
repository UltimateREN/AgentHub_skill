"use strict";
const { descriptor } = require("../../model-descriptor.cjs");
// CodeArts model execution only. OAuth, credential parsing/renewal, balance,
// welfare and model catalog persistence remain in the AgentHub management adapter.
const signer = require("./signer.cjs");
const session = require("./session.cjs");
const streamFault = require("./stream_fault.cjs");
const redact = require("./redact.cjs");
const { sse, errorDetail } = require("../../network/sse.cjs");
const { forwardError } = require("../../../sdk/runtime/provider.cjs");
const { hasContent } = require("../../../sdk/provider-protocol.cjs");

function failure(error, seen = false) {
  if (error?.forwardError) return error;
  const status = Number(error?.status) || 502;
  const quota = status === 403 || status === 429 || /quota|insufficient|rate limit/i.test(String(error?.message || ""));
  return forwardError({ code: quota ? "QUOTA_EXHAUSTED" : status === 401 ? "AUTH_REQUIRED" : "UPSTREAM_FAILED",
    message: quota ? "CodeArts 上游额度或请求受限" : status === 401 ? "CodeArts 登录态无效，请在号池检查凭据" : "CodeArts 模型执行失败",
    category: quota ? "quota" : status === 401 ? "auth" : "upstream", scope: quota || status === 401 ? "account" : "invocation",
    replay: seen ? "unsafe" : "unknown", retryable: !seen && status >= 500, status: status >= 400 && status <= 599 ? status : 502 });
}
function createCodeArts(settings = {}) {
  const base = String(settings.base || "https://snap-access.cn-north-4.myhuaweicloud.com").replace(/\/+$/, "");
  const chatPath = settings.chatPath || "/api/v2/chat/completions";
  async function catalogRequest(credential, urlBase, path, fetcher, { agentType, benefit, signal } = {}) {
    const headers = [["Content-Type", "application/json"], ["Accept", "application/json"], ["X-Language", settings.language || "zh-cn"],
      ["plugin-name", settings.pluginName || "snap_vscode"], ["plugin-version", settings.pluginVersion || "26.9.101"],
      ["client_version", `Vscode_${settings.pluginVersion || "26.9.101"}`], ["is_confidential", "false"]];
    if (agentType) headers.push(["Agent-Type", agentType]);
    const url = `${urlBase}${path}`;
    const signed = signer.sign("GET", url, headers, undefined, benefit ? { ...credential, domain_id: "" } : credential, benefit === true);
    const response = await fetcher(url, { method: "GET", headers: Object.fromEntries(signed), redirect: "error", signal });
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > 2 * 1024 * 1024) throw new Error("CodeArts catalog response exceeds limit");
    let data; try { data = JSON.parse(text); } catch { throw new Error("CodeArts catalog returned invalid JSON"); }
    return { ok: response.ok, data };
  }
  function catalogEntry(raw, source, id, name) {
    const max = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : 0;
    return { id: String(id || "").trim(), name: String(name || id || "").trim(), rate: null,
      capabilities: { images: !!(raw?.images || raw?.supports_images || raw?.multimodal), reasoning: !!raw?.reasoning, tools: true },
      contextLength: max(raw?.contextLength ?? raw?.context_window ?? raw?.context_limit),
      maxOutputTokens: max(raw?.maxOutputTokens ?? raw?.max_tokens), routing: { source } };
  }
  async function fetchCatalog(request, ctx) {
    const credential = (await ctx.pool.credentials())?.signing;
    if (!credential?.access_key_id || !credential.secret_access_key || !credential.security_token) throw new Error("CodeArts catalog requires valid temporary signing credentials");
    const fetcher = ctx.pool.network().fetch, warnings = [], agentModels = [], builtins = [], benefits = [];
    const requestCatalog = async (path, agentType, target = base, benefit = false) => {
      const result = await catalogRequest(credential, target, path, fetcher, { agentType, benefit, signal: ctx.signal });
      if (!result.ok) throw new Error("catalog HTTP error");
      return result.data;
    };
    const seenAgents = new Set();
    try {
      for (let page = 0; page < 100; page++) {
        const data = await requestCatalog(`/v1/agent-center/agents/useragents?offset=${page * 100}&limit=100&is_primary_agent=true&supported_client=VSCODE&min_compatible_plugin_version=${encodeURIComponent(settings.pluginVersion || "26.9.101")}`, "AgentCenter");
        if (!Array.isArray(data?.agents)) throw new Error("agent response invalid");
        let added = 0;
        for (const agent of data.agents) {
          const agentId = agent?.agent_id || agent?.original_id;
          if (!agentId || seenAgents.has(agentId)) continue;
          seenAgents.add(agentId); added++;
          try {
            const detail = await requestCatalog(`/v1/agent-center/agents/detail?agent_id=${encodeURIComponent(agentId)}`, "AgentCenter");
            for (const model of detail?.gpts?.models || []) {
              const p = model.model_parameters || {};
              if (p.enabled === false) continue;
              const id = p.model_id || model.model_alias || model.model_id || model.modelId || model.id;
              if (id) agentModels.push(catalogEntry(p, "agent", id, model.model_name || model.name));
            }
          } catch { warnings.push("agent-detail"); }
        }
        if (data.agents.length < 100 || !added) break;
        if (page === 99) warnings.push("agent-pagination-limit");
      }
    } catch { warnings.push("agent"); }
    try {
      const data = await requestCatalog("/v1/model/builtin", "PromptCenter");
      const rows = data?.builtinModels || data?.models || (Array.isArray(data) ? data : null);
      if (!Array.isArray(rows)) throw new Error("builtin response invalid");
      for (const item of rows) if (item?.enable !== false) {
        const id = item?.model_id || item?.id || item?.model_name;
        if (id) builtins.push(catalogEntry(item, "builtin", id, item?.model_name || item?.name));
      }
    } catch { warnings.push("builtin"); }
    try {
      const enabled = await requestCatalog("/v1/benefit-gateway-config", "AgentCenter");
      if (enabled?.enabled === true) {
        const target = String(settings.benefitGatewayUrl || "https://opengw.developer.huaweicloud.com").replace(/\/+$/, "");
        const data = await requestCatalog("/api/v1/gateway/config", undefined, target, true);
        if (data?.error_code !== "0000" || !Array.isArray(data?.result?.models)) throw new Error("benefit response invalid");
        for (const item of data.result.models.slice().sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0))) {
          const id = item?.model_id || item?.id;
          if (id) benefits.push(catalogEntry(item, "benefit", id, item?.model_name || item?.name));
        }
      } else if (enabled?.enabled !== false) throw new Error("benefit gate invalid");
    } catch { warnings.push("benefit"); }
    const merged = new Map();
    for (const model of [...agentModels, ...builtins, ...benefits]) if (!merged.has(model.id.toLowerCase())) merged.set(model.id.toLowerCase(), model);
    if (!merged.size) throw new Error(`CodeArts catalog unavailable (${[...new Set(warnings)].join(",") || "all sources empty"})`);
    return [...merged.values()].map(model => ({ ...model, routing: { ...model.routing, partial: warnings.length > 0 } })).map(descriptor);
  }
  return {
    id: "codearts", channels: ["codearts"], requiredFeatures: ["explicit-retry-policy@1", "attempt-reservation@1", "execution-facts@1"],
    async listModels(request, ctx) {
      const c = request.grantId ? await ctx.pool.context() : {};
      return request.force ? fetchCatalog(request, ctx) : (c.models || []).map(descriptor);
    },
    async *invoke(request, ctx) {
      const projected = await ctx.pool.credentials();
      const credential = projected?.signing;
      if (!credential?.access_key_id || !credential.secret_access_key || !credential.security_token) throw failure({ status: 401 });
      const context = await ctx.pool.context();
      const catalog = Array.isArray(context.models) ? context.models : [];
      const wanted = String(request.model || "").toLowerCase();
      const model = catalog.find(item => String(item?.id || "").toLowerCase() === wanted);
      if (!model) throw failure({ status: 404 });
      const upstream = String(model.id);
      const permit = session.acquire(context.accountId || request.grantId, context.maxConcurrent);
      if (!permit.acquired) throw forwardError({ code: "ACCOUNT_CONCURRENCY", message: permit.message, category: "rate", scope: "account", replay: "safe", retryable: true, status: 409 });
      let response; let seen = false;
      try {
        const headers = [["Content-Type", "application/json"], ["Accept", "text/event-stream"], ["X-Plugin-Version", `Vscode_${settings.pluginVersion || "26.9.101"}`],
          ["X-Language", settings.language || "en-us"], ["plugin-name", settings.pluginName || "snap_vscode"], ["plugin-version", settings.pluginVersion || "26.9.101"],
          ["model-id", upstream], ["model-name", upstream], ["x-model-id", upstream]];
        if ((model.routing?.source || model.source) === "benefit") headers.push(["maas_type", "benefit"]);
        const payload = Buffer.from(JSON.stringify({ ...request.input, model: upstream, stream: true }), "utf8");
        const url = `${base}${chatPath}`;
        const signed = signer.sign("POST", url, headers, payload, credential, false);
        await ctx.attempts?.report({ state: "planned", actualModel: upstream });
        response = await ctx.pool.network().fetch(url, { method: "POST", headers: Object.fromEntries(signed), body: payload, signal: ctx.signal, redirect: "error" });
        await ctx.attempts?.report({ state: "responded", actualModel: upstream });
        if (!response.ok) throw Object.assign(new Error(`CodeArts upstream HTTP ${response.status}: ${(await errorDetail(response)).slice(0, 256)}`), { status: response.status });
        for await (const raw of sse(response, ctx.signal)) {
          if (!raw || raw === streamFault.DONE_SENTINEL) continue;
          const fault = streamFault.streamFrameFault(raw);
          if (fault) throw streamFault.faultToError(fault);
          let chunk; try { chunk = JSON.parse(raw); } catch { continue; }
          const delta = chunk?.choices?.[0]?.delta;
          if (delta && hasContent(delta)) { seen = true; yield { type: "delta", delta }; }
          if (chunk?.usage) yield { type: "usage", mode: "snapshot", usage: chunk.usage };
          const reason = chunk?.choices?.[0]?.finish_reason;
          if (reason) yield { type: "finish", reason };
        }
        if (!seen) throw Object.assign(new Error("CodeArts returned an empty response"), { status: 502 });
      } catch (error) { throw failure(error, seen); }
      finally { permit.release(); }
    },
  };
}
module.exports = { createCodeArts };
