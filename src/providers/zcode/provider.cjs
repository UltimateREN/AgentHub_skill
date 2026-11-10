"use strict";
const crypto = require("node:crypto");
const { descriptor } = require("../../model-descriptor.cjs");
const { sse, errorDetail } = require("../../network/sse.cjs");
const { forwardError, hasContent } = require("../../../sdk/provider-protocol.cjs");
const anthropic = require("./anthropic.cjs");
const officialSystem = require("./official-system.cjs");

const DEFAULTS = Object.freeze({
  zaiAnthropicBase: "https://api.z.ai/api/anthropic",
  bigmodelAnthropicBase: "https://open.bigmodel.cn/api/anthropic",
  startPlanAnthropicBase: "https://zcode.z.ai/api/v1/zcode-plan/anthropic",
  appVersion: "4.1.10", platform: "win32-x64", sourceTitle: "cli", billingBase: "https://zcode.z.ai/api/v1/zcode-plan",
});
// 国际版与 CN 同一份 zcode 控制面（zcode.z.ai），仅推理平面与账号体系分地区。
// 依据 Agent2Providers zcode/region.rs：INTL 推理平面只有 api.z.ai 一路（无 bigmodel 并存域）。
const INTL_DEFAULTS = Object.freeze({
  zaiAnthropicBase: "https://api.z.ai/api/anthropic",
  bigmodelAnthropicBase: "", // 国际版无 bigmodel 并存推理平面
  startPlanAnthropicBase: "https://zcode.z.ai/api/v1/zcode-plan/anthropic",
  appVersion: "4.1.10", platform: "win32-x64", sourceTitle: "cli", billingBase: "https://zcode.z.ai/api/v1/zcode-plan",
});

/**
 * ZCode 的模型清单（静态表，两地共用）。
 *
 * 为什么是静态表：上游没有「列模型」的公开接口 —— 编码套餐的可用模型由客户端内置
 * 目录决定（参考实现同样硬编码成常量并在注释里写「新模型发布时更新这张表」）。
 * 所以这里不假装 refresh：`listModels` 无论 force 与否都返回这张表。
 *
 * 与旧实现的差别（旧表只有 GLM-5.3 / GLM-5.3-Flash / GLM-5.2 三条）：
 * 少列一条的代价是客户端在 /v1/models 里根本看不到它，用户会以为渠道不支持 ——
 * 这比「列了但套餐用不到」更糟（后者上游会如实回 502 exceed quota limit）。
 *
 * id 用大写（与 glmModel() 的归一结果、以及号池 zcode 适配器的目录口径一致）：
 * 客户端无论写 glm-5.1 还是 GLM-5.1，glmModel() 都会归到同一个串再发上游。
 *
 * ⚠️ 只声明**有依据**的能力位：视觉两档（GLM-4.6V / GLM-5V-Turbo）明确不支持思考，
 * 声明成 true 会让客户端按「支持思考」发请求而被上游 400；其余模型不声明
 * reasoning（不知道就不猜）。contextLength / maxOutputTokens 一律不写 —— 没有
 * 实测依据的窗口数字会被下游照着构造请求（按虚高的窗口堆历史），比空着更糟。
 */
const STATIC_MODELS = Object.freeze([
  { id: "GLM-5.3", name: "GLM-5.3" },
  { id: "GLM-5.3-Flash", name: "GLM-5.3 Flash" },
  { id: "GLM-5.2", name: "GLM-5.2" },
  { id: "GLM-5.1", name: "GLM-5.1" },
  { id: "GLM-5", name: "GLM-5" },
  { id: "GLM-5-Turbo", name: "GLM-5 Turbo" },
  { id: "GLM-4.7", name: "GLM-4.7" },
  { id: "GLM-4.6", name: "GLM-4.6" },
  { id: "GLM-4.5-Air", name: "GLM-4.5 Air" },
  { id: "GLM-4.6V", name: "GLM-4.6V", capabilities: { reasoning: false } },
  { id: "GLM-5V-Turbo", name: "GLM-5V Turbo", capabilities: { reasoning: false } },
]);
function mappedError(status, data, raw) {
  const text = String(data?.message || data?.msg || data?.error?.message || raw || "ZCode 上游请求失败").slice(0, 1024);
  const match = /^\[(\d{3,5})\]/.exec(text);
  const code = Number(data?.code ?? data?.error?.code ?? match?.[1]) || 0;
  const quota = status === 402 || [1005, 1113].includes(code) || /insufficient|quota exhausted|balance|余额不足|额度|recharge/i.test(text);
  const rate = status === 429 || [3002, 3008, 3009, 3010].includes(code);
  const captcha = code === 3007 || /captcha|verify/i.test(text);
  const auth = !captcha && (status === 401 || status === 403 || [401, 1006, 3012].includes(code));
  return forwardError({
    code: quota ? "QUOTA_EXHAUSTED" : rate ? "RATE_LIMITED" : auth ? "AUTH_REQUIRED" : captcha ? "UPSTREAM_CHALLENGE" : "UPSTREAM_FAILED",
    message: captcha ? "ZCode 上游要求人机验证，请使用号池管家的过码操作" : quota ? "ZCode 当前套餐额度已用完" : auth ? "ZCode 凭据已失效" : rate ? "ZCode 上游请求受限" : "ZCode 模型上游返回错误",
    category: quota ? "quota" : rate ? "rate" : auth ? "auth" : "upstream",
    scope: quota || rate || auth ? "account" : "invocation", replay: "unknown",
    retryable: !quota && !auth && !captcha && (rate || status >= 500), status: captcha ? 502 : quota ? 402 : rate ? 429 : auth ? 401 : status >= 400 && status <= 599 ? status : 502,
  });
}
function glmModel(value) {
  const model = String(value || "").trim();
  if (!/^glm-/i.test(model) || /^GLM-/.test(model)) return model;
  return model.split("-").map((part, index) => index === 0 ? part.toUpperCase() : /^[a-z]+$/.test(part) ? part[0].toUpperCase() + part.slice(1) : part).join("-");
}
function validBase(value, fallback) {
  const raw = String(value || fallback).replace(/\/+$/, "");
  const url = new URL(raw);
  if (!(["https:", "http:"].includes(url.protocol)) || url.username || url.password || url.search || url.hash) throw new TypeError("Invalid ZCode upstream URL");
  return raw;
}
function createZcode(settings = {}, channel = "zcode") {
  const isIntl = channel === "zcode_intl";
  const cfg = { ...(isIntl ? INTL_DEFAULTS : DEFAULTS), ...settings };
  const bases = {
    zai: validBase(cfg.zaiAnthropicBase, (isIntl ? INTL_DEFAULTS : DEFAULTS).zaiAnthropicBase),
    bigmodel: cfg.bigmodelAnthropicBase ? validBase(cfg.bigmodelAnthropicBase, (isIntl ? INTL_DEFAULTS : DEFAULTS).bigmodelAnthropicBase) : null,
    start: validBase(cfg.startPlanAnthropicBase, (isIntl ? INTL_DEFAULTS : DEFAULTS).startPlanAnthropicBase),
  };
  return {
    id: channel, channels: [channel],
    async listModels(request, ctx) {
      const context = request.grantId ? await ctx.pool.context() : {};
      // 上游没有「列模型」接口：账号快照里有就用快照（它来自登录时的客户端目录），
      // 否则回落这张静态表。两条路径都**不因 force 与否改变语义** —— 本家没有
      // 可远程刷新的目录，假装刷一次只会让用户以为模型变新了。
      const rows = Array.isArray(context.models) && context.models.length ? context.models : STATIC_MODELS;
      return rows.map(descriptor);
    },
    async *invoke(request, ctx) {
      const credentials = await ctx.pool.credentials();
      const context = await ctx.pool.context();
      const jwt = String(credentials?.token || "");
      const apiKey = String(credentials?.modelApiKey || "");
      if (!jwt && !apiKey) throw mappedError(401, {}, "credentials unavailable");
      const model = glmModel(request.model);
      const entry = (context.models || []).find(item => String(item.id).toLowerCase() === String(request.model).toLowerCase()) || {};
      const conversation = crypto.createHash("sha256").update(JSON.stringify(request.input?.messages || [])).digest("hex").slice(0, 32);
      const deviceMid = String(context.identity?.deviceMid || "");
      const sessionId = String(request.input?.metadata?.session_id || conversation).replace(/^(sess_|subagent_agent_)/, "");
      const plans = apiKey ? ["coding-plan", ...(jwt ? ["start-plan"] : [])] : ["start-plan"];
      let finalError;
      for (let planIndex = 0; planIndex < plans.length; planIndex++) {
        const plan = plans[planIndex];
        // provider 由账号上下文（identity.provider）决定，缺省 zai（与既有 CN 行为一致）；
        // INTL 无 bigmodel 并存推理平面，provider=bigmodel 且无 bigmodel base 时回落 zai。
        const provider = String(context.identity?.provider || "zai");
        let base = plan === "start-plan" ? bases.start : provider === "bigmodel" && bases.bigmodel ? bases.bigmodel : bases.zai;
        if (!base) base = bases.zai;
        const payload = anthropic.toAnthropic(model, request.input || {}, { defaultMaxTokens: entry.maxOutputTokens });
        if (plan === "start-plan") payload.system = officialSystem.injectOfficialZcodeSystem(payload.system);
        payload.metadata = { user_id: JSON.stringify({ device_id: deviceMid || undefined, account_uuid: "", session_id: sessionId }) };
        const headers = {
          "content-type": "application/json", accept: "text/event-stream", "User-Agent": `ZCode/${cfg.appVersion}`,
          "X-ZCode-App-Version": cfg.appVersion, "X-Platform": cfg.platform, "X-Release-Channel": "stable",
          "X-Client-Language": "zh-CN", "X-Client-Timezone": cfg.timezone || "Asia/Singapore", "X-Os-Category": "windows",
          "HTTP-Referer": cfg.refererOrigin || "https://zcode.z.ai", "X-Title": `Z Code@${cfg.sourceTitle}`,
          "X-ZCode-Agent": "glm", "anthropic-version": "2023-06-01", "x-request-id": crypto.randomUUID(),
          "x-zcode-trace-id": crypto.randomUUID(), "x-zcode-session-type": "main",
        };
        if (plan === "coding-plan") {
          headers["x-api-key"] = apiKey; headers.authorization = `Bearer ${apiKey}`;
          headers["x-query-id"] = crypto.randomUUID(); headers["x-session-id"] = sessionId;
        } else headers.authorization = `Bearer ${jwt}`;
        let response, contentSeen = false;
        try {
          response = await ctx.pool.network().fetch(`${base}/v1/messages`, { method: "POST", headers, body: JSON.stringify(payload), redirect: "error", signal: ctx.signal });
          if (!response.ok) {
            const raw = await errorDetail(response);
            let data = {}; try { data = JSON.parse(raw); } catch {}
            const error = mappedError(response.status, data, raw);
            // Only a confirmed paid-plan quota response can fall back to the JWT plan.
            if (plan === "coding-plan" && jwt && planIndex + 1 < plans.length && error.category === "quota") { finalError = error; continue; }
            throw error;
          }
          const events = [];
          const bridge = anthropic.createSseBridge(event => events.push(event));
          let finishReason = "stop";
          for await (const raw of sse(response, ctx.signal)) {
            if (!raw || raw === "[DONE]") continue;
            let data; try { data = JSON.parse(raw); } catch { continue; }
            bridge.onEvent(data.type || "", raw);
            for (const event of events.splice(0)) {
              if (event.type === "delta") { contentSeen ||= hasContent(event.delta); yield event; }
              else if (event.type === "usage") yield { type: "usage", mode: "snapshot", usage: event.usage };
              else if (event.type === "finish") finishReason = event.reason;
              else if (event.type === "error") throw mappedError(event.status, { code: event.code, message: event.message }, event.message);
            }
          }
          if (!contentSeen) throw mappedError(502, {}, "empty response");
          yield { type: "finish", reason: finishReason };
          return;
        } catch (error) {
          if (error?.forwardError && plan === "coding-plan" && jwt && planIndex + 1 < plans.length && error.category === "quota" && !contentSeen) { finalError = error; continue; }
          throw error;
        } finally { try { await response?.body?.cancel(); } catch {} }
      }
      throw finalError || mappedError(502, {}, "ZCode invocation failed");
    },
  };
}
module.exports = { createZcode, glmModel, mappedError, STATIC_MODELS };
