"use strict";
const crypto = require("node:crypto");
const { descriptor, privateValue } = require("../../model-descriptor.cjs");
// User model execution only. Original management remains entirely in the host.
const { configuration } = require("./upstreamHttp.cjs");
const runtime = require("./runtime-context.cjs");
const { runConversation } = require("./conversation.cjs");
const { createScopePool } = require("./scopes.cjs");
const { createEventBridge } = require("../../execution/event-bridge.cjs");
const { splitDelta } = require("../../execution/split-delta.cjs");
const { classifyUpstream } = require("../../execution/upstream-errors.cjs");
const { forwardError } = require("../../../sdk/runtime/provider.cjs");
const { validateStateScope, validateAccountExecutionEpoch, eventBytes } = require("../../../sdk/provider-protocol.cjs");
const { unwrapApiData } = require("./api-envelope.cjs");
function errorFor(error, taskMayExist) {
  if (error.forwardError) return error;
  const cls = classifyUpstream(error, false);
  const mapped = { relogin: ["auth", "account"], credit: ["quota", "account"], rate: ["rate", "account"],
    model_rate: ["rate", "account-model"], model_blocked: ["model", "account-model"], not_found: ["model", "account-model"],
    bad_params: ["model", "invocation"], prompt_too_long: ["model", "invocation"], model_config: ["model", "invocation"] };
  const [category, scope] = mapped[cls.kind] || ["upstream", "invocation"];
  return forwardError({ code: "CATPAW_EXECUTION_FAILED", message: "CatPaw 模型调用失败",
    status: error.fatal ? error.status : cls.status || 502, category, scope,
    retryable: !error.fatal && !taskMayExist && cls.switchable === true,
    replay: taskMayExist ? "unsafe" : error.fatal ? "safe" : "unknown" });
}
function createCatPaw(rawSettings = {}) {
  const settings = configuration(rawSettings), scopes = createScopePool();
  return {
    id: "catpaw", channels: ["catpaw"],
    requiredFeatures: ["attempt-reservation@1", "execution-facts@1", "explicit-retry-policy@1", "state-scope@1", "request-headers@1", "account-execution-epoch@1"],
    async listModels(request, ctx) {
      const facts = await ctx.pool.context();
      if (request.force === true) {
        const credentials = await ctx.pool.credentials();
        const token = String(credentials?.token || "").trim();
        if (!token) throw forwardError({ code: "AUTH_REQUIRED", message: "CatPaw 登录态无效，请在号池检查凭据", category: "auth", scope: "account", replay: "safe", status: 401 });
        const base = String(settings.baseUrl).replace(/\/+$/, "");
        const response = await ctx.pool.network().fetch(`${base}/api/agent/maas/model-types`, {
          method: "POST", redirect: "error", signal: ctx.signal,
          headers: { Accept: "application/json", "Content-Type": "application/json",
            "M-TRACEID": crypto.randomUUID().replace(/-/g, ""), "M-APPKEY": settings.appKey,
            "gray-set": "new-agent-sdk", enableHeartBeat: "true", "X-Agent-Version": settings.agentVersion,
            Cookie: `X-Passport-Token=${token}`, ...(credentials.uid ? { "user-uid": String(credentials.uid) } : {}) },
          body: JSON.stringify({ tenant: "CatDesk", scene: "CATX_APP", env: "EXTERNAL" }),
        });
        if (!response.ok) throw forwardError({ code: response.status === 401 ? "AUTH_REQUIRED" : "CATALOG_UPSTREAM_FAILED",
          message: response.status === 401 ? "CatPaw 登录态无效，请在号池检查凭据" : "CatPaw 上游模型目录获取失败",
          category: response.status === 401 ? "auth" : "upstream", scope: response.status === 401 ? "account" : "service",
          replay: "safe", status: response.status >= 400 && response.status <= 599 ? response.status : 502 });
        let payload;
        try { payload = unwrapApiData(await response.json()); }
        catch (error) {
          if (error?.forwardError) throw error;
          throw forwardError({ code: "CATALOG_INVALID", message: "CatPaw 上游模型目录格式无法解析", category: "protocol", scope: "service", replay: "safe", status: 502 });
        }
        if (!Array.isArray(payload) || payload.length > 4096) throw forwardError({ code: "CATALOG_INVALID", message: "CatPaw 上游模型目录结构无效", category: "protocol", scope: "service", replay: "safe", status: 502 });
        const known = new Map((facts.models || []).map(model => [String(model.id || "").toLowerCase(), model]));
        const seen = new Set(), models = [];
        for (const item of payload) {
          if (!item || typeof item !== "object" || String(item.provider || "").toLowerCase() === "user_custom"
            || item.extendedInfo?.isAuto === true || item.extendedInfo?.isAuto === "true") continue;
          const id = String(item.modelTypeName || "").trim(), key = id.toLowerCase();
          if (!id || id.length > 160 || /[\x00-\x1f\x7f]/.test(id) || seen.has(key)) continue;
          const prior = known.get(key);
          const modelType = Number(item.modelTypeId ?? prior?.modelType);
          if (!Number.isSafeInteger(modelType) || modelType <= 0) continue;
          seen.add(key);
          const extended = item.extendedInfo && typeof item.extendedInfo === "object" ? item.extendedInfo : {};
          const rate = Number(extended.rateMultiplier);
          const definitions = Array.isArray(item.parameterDefinitions) ? item.parameterDefinitions : [];
          const contextDefinition = definitions.find(definition => definition?.id === "context");
          const windows = Array.isArray(contextDefinition?.values) ? contextDefinition.values.map(value => Number(value?.value)).filter(Number.isSafeInteger) : [];
          const capabilities = { ...prior?.capabilities, tools: true };
          if (typeof item.supportImage === "boolean") capabilities.images = item.supportImage;
          if (typeof item.supportThinking === "boolean") capabilities.reasoning = item.supportThinking;
          else if (definitions.some(definition => definition?.id === "effort")) capabilities.reasoning = true;
          models.push({ ...prior, id, name: String(extended.modelCaptionZhCN || item.description || prior?.name || id), modelType,
            rate: Number.isFinite(rate) ? rate : prior?.rate ?? null, capabilities,
            contextLength: windows.length ? Math.max(...windows) : prior?.contextLength || 0,
            maxOutputTokens: prior?.maxOutputTokens || 0,
            // 数字 modelType 是上游内部 ID，宿主目录归一化只保留 routing。
            routing: { ...(prior?.routing || {}), modelType } });
        }
        if (!models.length) throw forwardError({ code: "EMPTY_CATALOG", message: "CatPaw 上游未返回可执行模型", category: "protocol", scope: "service", replay: "safe", status: 502 });
        return models;
      }
      return (facts.models || []).map(descriptor);
    },
    async *invoke(request, sdk) {
      validateStateScope(sdk.request?.stateScope);
      const credentials = await sdk.pool.credentials(), context = await sdk.pool.context();
      validateAccountExecutionEpoch(context.accountExecutionEpoch);
      // 实时目录只带 routing，旧管理快照把 modelType 放在顶层；执行前统一形状。
      const catalog = (Array.isArray(context.models) ? context.models : []).map(entry => {
        const source = entry && typeof entry === "object" ? entry : { id: String(entry || "") };
        return { ...source, modelType: Number(privateValue(source, "modelType")) };
      });
      if (typeof credentials.token !== "string" || !credentials.token || typeof context.accountId !== "string" || !context.accountId
        || !Array.isArray(context.models) || catalog.some(entry => !Number.isSafeInteger(entry.modelType) || entry.modelType <= 0)) {
        throw errorFor({ status: 503, fatal: true }, false);
      }
      const lease = scopes.acquire(sdk.request.stateScope, context.accountId, String(credentials.uid || ""), settings.baseUrl, context.accountExecutionEpoch);
      const controller = new AbortController(), signal = AbortSignal.any([sdk.signal, controller.signal]);
      const bridge = createEventBridge();
      const ctx = { settings, sdk, signal, network: sdk.pool.network(), registry: lease.registry, models: catalog };
      let producer, taskMayExist = false;
      const fits = delta => eventBytes({ type: "delta", delta, invocationId: request.invocationId,
        generation: request.generation, seq: Number.MAX_SAFE_INTEGER }) <= sdk.limits.eventBytes;
      try {
        // A round can create a stateful task without producing text. Establish
        // the host replay barrier BEFORE starting that private network sequence.
        taskMayExist = true;
        yield { type: "checkpoint", replay: "unsafe" };
        signal.throwIfAborted();
        producer = runtime.run(ctx, () => runConversation({ credentials, body: { ...structuredClone(request.input), model: request.model },
          account: { id: context.accountId }, meta: { conversationId: sdk.request.headers?.["x-session-id"] || "" },
          emit: event => bridge.send(event) }));
        producer.then(() => bridge.finish(), error => bridge.finish(error));
        for await (const event of bridge.events()) {
          if (event.type === "delta") {
            for (const delta of splitDelta(event.delta, fits)) yield { type: "delta", delta };
          } else yield event;
        }
        await producer;
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        throw errorFor(error, taskMayExist);
      } finally {
        controller.abort(new Error("CatPaw invocation ended"));
        bridge.finish(signal.reason);
        try { await producer; } catch { /* Main error is reported once by SDK. */ }
        lease.release();
      }
    },
  };
}
module.exports = { createCatPaw, errorFor };
