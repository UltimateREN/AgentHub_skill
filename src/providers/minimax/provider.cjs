"use strict";
// MiniMax Code（国内版 / 国际版）转发适配器。
//
// 上游是 Anthropic Messages 协议的另一个部署（agent.minimax.cn 的 /mavis 网关）：
// 请求体、SSE 事件序列与 ZCode 完全同族（实测 message_start → ping → content_block_delta…），
// 所以翻译层与流式桥接**直接复用** ../zcode/anthropic.cjs，不在本目录复制一份
// —— 复制会让「Anthropic 协议的一个修复」要改两处，跨目录 require 是零改动的选择。
//
// 与 ZCode 的差异只有鉴权：上游除了 Bearer 还要求 `x-timestamp` + `x-signature`，
// 且签名材料里含 **body 原文**。这就是签名必须算在插件（真正发请求的那一层）的原因：
// 宿主把 body 传下来的话，任何一次重新序列化都会让签名失配。
const crypto = require("node:crypto");
const { descriptor } = require("../../model-descriptor.cjs");
const { sse, errorDetail } = require("../../network/sse.cjs");
const { forwardError, hasContent } = require("../../../sdk/provider-protocol.cjs");
const anthropic = require("../zcode/anthropic.cjs");

/** 客户端签名盐（源码实证，见方案 §1.5）；改动即全部 401，故单列常量并加测试固定向量 */
const SALT = "I*7Cf%WZ#S&%1RlZJ&C2";

const DEFAULTS = Object.freeze({
  base: "https://agent.minimax.cn",
  userAgent:
    "MiniMaxAgent Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MiniMax/3.1.14 Chrome/148.0.7778.280 Safari/537.36",
});
// 国际版是另一套账号体系（凭据不通用），但协议、字段、query 全部同形，只有域名分家。
const INTL_DEFAULTS = Object.freeze({ ...DEFAULTS, base: "https://agent.minimax.io" });

/**
 * MiniMax Code 的模型清单（静态表，两地共用）。
 *
 * 为什么是静态表：上游**没有** models 接口（/mavis/api/v1/llm/v1/models 实测 503
 * direct_route_not_configured），目录只存在于客户端内置常量里。所以和 zcode 同款口径：
 * 账号快照里有就用快照，没有就回落这张表，**不因 force 与否假装刷新**。
 *
 * contextLength / maxOutputTokens 有客户端目录依据（512K / 128K），照实写：
 * 下游会拿它决定历史裁剪与 max_tokens 缺省值，写小会截断长回答。
 * 两个模型都实测支持图片输入、思考与工具调用（M3.1-Flash 的思考是强制开启）。
 */
const STATIC_MODELS = Object.freeze([
  {
    id: "MiniMax-M3",
    name: "MiniMax-M3",
    capabilities: { images: true, reasoning: true, tools: true },
    contextLength: 512000,
    maxOutputTokens: 128000,
  },
  {
    id: "MiniMax-M3.1-Flash",
    name: "M3.1-Flash",
    capabilities: { images: true, reasoning: true, tools: true },
    contextLength: 512000,
    maxOutputTokens: 128000,
  },
]);

const QUERY_KEYS = Object.freeze([
  "device_platform", "biz_id", "app_id", "version_code", "unix", "timezone_offset",
  "is_desktop", "desktop_version", "sys_language", "lang", "uuid", "device_id",
  "os_name", "browser_name", "device_memory", "cpu_core_num", "browser_language",
  "browser_platform", "user_id", "screen_width", "screen_height", "client",
]);

/**
 * 公共 query（键名与值逐字照抄实测请求）。
 *
 * 上游网关按这套参数判「是不是官方桌面端」，缺项或改值可能被拒；其中 `unix` 是毫秒，
 * `uuid` 每次请求随机，`device_id` 由调用方按账号派生（见 deviceIdOf）。
 */
function commonQuery(deviceId, now = Date.now(), uuid = crypto.randomUUID()) {
  const params = new URLSearchParams();
  params.set("device_platform", "web");
  params.set("biz_id", "3");
  params.set("app_id", "3001");
  params.set("version_code", "22201");
  params.set("unix", String(now));
  params.set("timezone_offset", "28800");
  params.set("is_desktop", "1");
  params.set("desktop_version", "3.1.14");
  params.set("sys_language", "zh");
  params.set("lang", "zh");
  params.set("uuid", uuid);
  params.set("device_id", String(deviceId));
  params.set("os_name", "Windows");
  params.set("browser_name", "Chrome");
  params.set("device_memory", "32");
  params.set("cpu_core_num", "20");
  params.set("browser_language", "zh-CN");
  params.set("browser_platform", "Win32");
  params.set("user_id", "0");
  params.set("screen_width", "1920");
  params.set("screen_height", "1080");
  params.set("client", "desktop");
  return params.toString();
}

/**
 * 账号级稳定 device_id（8 位十进制数字）。
 *
 * 为什么按账号派生而不是全池共用一枚：上游实测「换任何值都 200」，但多账号池共用一个
 * 指纹本身是典型风控特征；派生值确定 → 同一账号每次请求一致，不同账号互不相同。
 * 无 uid 时退回 token 做种子（同一账号的 token 在有效期内不变，仍满足确定性）。
 */
function deviceIdOf(uid, token) {
  const seed = String(uid || "") || String(token || "");
  const head = crypto.createHash("sha256").update(`agenthub:minimax:${seed}`).digest("hex").slice(0, 8);
  return String((parseInt(head, 16) % 90000000) + 10000000);
}

/** 签名：md5(秒级时间戳 + 盐 + body 原文) 小写 hex。body 必须是**实际发出去的那一份**。 */
function sign(ts, body) {
  return crypto.createHash("md5").update(`${ts}${SALT}${body}`).digest("hex");
}

/**
 * 上游错误 → 插件统一错误。
 *
 * 两个 MINIMAX 特有形态：
 * 1. 业务错误可能藏在 HTTP 200 的 JSON 里（`base_resp.status_code !== 0`）——
 *    HTTP 层看起来是成功，只能按上游失败处理，不能当内容透传。
 * 2. 免费积分账号额度耗尽时文案是中文「积分/余额」，光看状态码会误判成普通失败。
 */
function mappedError(status, data = {}, raw = "") {
  const base = data && data.base_resp && typeof data.base_resp === "object" ? data.base_resp : {};
  const baseCode = Number(base.status_code) || 0;
  const text = String(base.status_msg || data?.message || data?.msg || data?.error?.message || raw || "MiniMax 上游请求失败").slice(0, 1024);
  // 200 + base_resp 非 0：业务层已声明失败，与 HTTP 状态无关，固定按上游失败报
  const bizFailure = Number(status) === 200 && baseCode !== 0;
  const auth = !bizFailure && (status === 401 || status === 403);
  const quota = !bizFailure && !auth && (status === 402 || /insufficient|quota|积分|余额|recharge/i.test(text));
  const rate = !bizFailure && !auth && !quota && status === 429;
  return forwardError({
    code: bizFailure ? "UPSTREAM_FAILED" : auth ? "AUTH_REQUIRED" : quota ? "QUOTA_EXHAUSTED" : rate ? "RATE_LIMITED" : "UPSTREAM_FAILED",
    message: bizFailure
      ? `MiniMax 上游返回错误（${baseCode}）：${text}`
      : auth ? "MiniMax 凭据已失效" : quota ? "MiniMax 当前积分余额不足" : rate ? "MiniMax 上游请求受限" : "MiniMax 模型上游返回错误",
    category: auth ? "auth" : quota ? "quota" : rate ? "rate" : "upstream",
    scope: auth || quota || rate ? "account" : "invocation",
    replay: "unknown",
    // 5xx 才是可重试的上游故障；额度/鉴权重试只会再失败一次，业务错误同请求重放也没意义
    retryable: rate || (!bizFailure && !auth && !quota && Number(status) >= 500),
    status: bizFailure ? 502 : auth ? 401 : quota ? 402 : rate ? 429 : status >= 400 && status <= 599 ? status : 502,
  });
}

function validBase(value, fallback) {
  const raw = String(value || fallback).replace(/\/+$/, "");
  const url = new URL(raw);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new TypeError("Invalid MiniMax upstream URL");
  return raw;
}

function createMinimax(settings = {}, channel = "minimax") {
  const isIntl = channel === "minimax_intl";
  const cfg = { ...(isIntl ? INTL_DEFAULTS : DEFAULTS), ...settings };
  // origin 与推理网关同域（国际版整域切到 agent.minimax.io），origin/referer 都从它派生
  const base = validBase(cfg.base, (isIntl ? INTL_DEFAULTS : DEFAULTS).base);
  const llmBase = `${base}/mavis/api/v1/llm`;
  return {
    id: channel, channels: [channel],
    async listModels(request, ctx) {
      const context = request.grantId ? await ctx.pool.context() : {};
      // 与 zcode 同款：快照优先、静态表兜底；本家没有可远程刷新的目录，不做假刷新
      const rows = Array.isArray(context.models) && context.models.length ? context.models : STATIC_MODELS;
      return rows.map(descriptor);
    },
    async *invoke(request, ctx) {
      const credentials = await ctx.pool.credentials();
      const context = await ctx.pool.context();
      const token = String(credentials?.token || "");
      if (!token) throw mappedError(401, {}, "credentials unavailable");
      const wanted = String(request.model || "").toLowerCase();
      // 快照命中优先取它的 maxOutputTokens；否则回静态表（顺带把大小写归一成上游目录里的 id）
      const entry = (context.models || []).find(item => String(item.id).toLowerCase() === wanted)
        || STATIC_MODELS.find(item => item.id.toLowerCase() === wanted)
        || {};
      const model = String(entry.id || request.model || "");
      const deviceId = deviceIdOf(context.uid || credentials.uid, token);
      const payload = anthropic.toAnthropic(model, request.input || {}, { defaultMaxTokens: entry.maxOutputTokens });
      // ⚠️ 只 stringify 一次：签名与发送必须是同一份字节，第二次序列化会让 x-signature 失配
      const bodyString = JSON.stringify(payload);
      const ts = Math.floor(Date.now() / 1000);
      const headers = {
        "content-type": "application/json",
        accept: "text/event-stream",
        authorization: `Bearer ${token}`,
        token, // 官方客户端两处都带，照抄比只带一个稳
        "x-timestamp": String(ts),
        "x-signature": sign(ts, bodyString),
        "anthropic-version": "2023-06-01",
        "user-agent": cfg.userAgent,
        origin: base,
        referer: `${base}/`,
      };
      let response, contentSeen = false;
      try {
        response = await ctx.pool.network().fetch(`${llmBase}/v1/messages?${commonQuery(deviceId)}`, {
          method: "POST", headers, body: bodyString, redirect: "error", signal: ctx.signal,
        });
        if (!response.ok) {
          const raw = await errorDetail(response);
          let data = {}; try { data = JSON.parse(raw); } catch {}
          throw mappedError(response.status, data, raw);
        }
        // 200 但不是 SSE：上游把业务错误塞进了 JSON（base_resp 非 0）。没有 content-type 时按流处理。
        const contentType = String(response.headers?.get?.("content-type") || "");
        if (contentType && !/event-stream/i.test(contentType)) {
          const raw = await errorDetail(response);
          let data = {}; try { data = JSON.parse(raw); } catch {}
          throw mappedError(200, data?.base_resp ? data : { ...data, base_resp: { status_code: -1, status_msg: "上游返回了非流式响应" } }, raw);
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
            // usage 原样透传（桥接已把 cache_read_input_tokens / cache_creation_input_tokens 带上）
            else if (event.type === "usage") yield { type: "usage", mode: "snapshot", usage: event.usage };
            else if (event.type === "finish") finishReason = event.reason;
            else if (event.type === "error") throw mappedError(event.status, { code: event.code, message: event.message }, event.message);
          }
        }
        // 上游 200 但一个内容块都没有：多数是账号无可用模型/被限流后静默返回，报错比给空回答诚实
        if (!contentSeen) throw mappedError(502, {}, "empty response");
        yield { type: "finish", reason: finishReason };
        return;
      } finally { try { await response?.body?.cancel(); } catch {} }
    },
  };
}

module.exports = { createMinimax, mappedError, deviceIdOf, sign, commonQuery, QUERY_KEYS, SALT, STATIC_MODELS };
