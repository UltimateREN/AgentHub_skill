"use strict";
// MiniMax Code 适配器的离线单测（不联网）：签名向量、公共 query、错误映射、SSE 透传。
const assert = require("node:assert/strict");
const { ReadableStream } = require("node:stream/web");
const { createMinimax, mappedError, deviceIdOf, sign, commonQuery, QUERY_KEYS, STATIC_MODELS } = require("../src/providers/minimax/provider.cjs");

function event(type, data) { return `data: ${JSON.stringify({ type, ...data })}\n\n`; }

function sseResponse(frames, status = 200, type = "text/event-stream") {
  const text = Array.isArray(frames) ? frames.join("") : String(frames || "");
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => {
        const k = String(name || "").toLowerCase();
        if (k === "content-type") return type;
        return null;
      },
    },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.from(text));
        controller.close();
      },
    }),
    async text() {
      return text;
    },
  };
}

async function main() {
  // ① 静态目录形状：两条、id 与官方客户端目录一致，窗口/输出上限是数字（下游会照着它裁历史）
  assert.equal(STATIC_MODELS.length, 2);
  assert.deepEqual(STATIC_MODELS.map(item => item.id), ["MiniMax-M3", "MiniMax-M3.1-Flash"]);
  assert.equal(STATIC_MODELS[1].name, "M3.1-Flash");
  for (const item of STATIC_MODELS) {
    assert.equal(typeof item.contextLength, "number");
    assert.equal(typeof item.maxOutputTokens, "number");
    assert.equal(item.contextLength, 512000);
    assert.equal(item.maxOutputTokens, 128000);
    assert.deepEqual(item.capabilities, { images: true, reasoning: true, tools: true });
  }

  // ② 签名固定向量：ts=1700000000 + 空 body → 固定 md5（盐或拼接顺序一变，这里立刻红）
  assert.equal(sign(1700000000, ""), "05064c6d0266350eeac121b673536c14");
  // 同一 (ts, body) 必须可复现；body 不同则签名不同
  assert.equal(sign(1700000000, ""), sign(1700000000, ""));
  assert.notEqual(sign(1700000000, "{}"), sign(1700000000, ""));

  // ③ 公共 query：键集合与约定逐字一致，且 device_id 是 8 位数字
  const deviceId = deviceIdOf("uid-1", "token-1");
  assert.match(deviceId, /^\d{8}$/);
  assert.equal(deviceId, deviceIdOf("uid-1", "other-token"), "有 uid 时只由 uid 派生（稳定）");
  assert.notEqual(deviceId, deviceIdOf("uid-2", "token-1"), "不同账号不共用指纹");
  const query = new URLSearchParams(commonQuery(deviceId, 1700000000000, "0b3a4e1c-0000-4000-8000-000000000000"));
  assert.deepEqual([...query.keys()], [...QUERY_KEYS]);
  assert.equal(query.get("device_id"), deviceId);
  assert.equal(query.get("unix"), "1700000000000");
  assert.equal(query.get("timezone_offset"), "28800");
  assert.equal(query.get("client"), "desktop");
  assert.equal(query.get("app_id"), "3001");

  // ④ 错误映射：状态码优先，其次才是文案（免费账号额度耗尽是中文文案，不能漏判）
  const auth = mappedError(401, {}, "");
  assert.equal(auth.code, "AUTH_REQUIRED"); assert.equal(auth.category, "auth"); assert.equal(auth.scope, "account");
  assert.equal(mappedError(403, {}, "").code, "AUTH_REQUIRED");
  const quota = mappedError(402, {}, "");
  assert.equal(quota.code, "QUOTA_EXHAUSTED"); assert.equal(quota.category, "quota"); assert.equal(quota.retryable, false);
  assert.equal(mappedError(400, { base_resp: { status_code: 0, status_msg: "积分不足" } }, "").code, "QUOTA_EXHAUSTED");
  const rate = mappedError(429, {}, "");
  assert.equal(rate.code, "RATE_LIMITED"); assert.equal(rate.retryable, true);
  // HTTP 200 但业务层声明失败：不能当内容透传，固定按上游失败且不可重试
  const biz = mappedError(200, { base_resp: { status_code: 1004, status_msg: "internal error" } }, "");
  assert.equal(biz.code, "UPSTREAM_FAILED"); assert.equal(biz.status, 502); assert.equal(biz.retryable, false);
  assert.equal(mappedError(503, {}, "").retryable, true, "5xx 可重试");

  // ⑤ 离线跑一次 invoke：签名必须与真正发出去的 body 同一份、query 带齐、usage 透传缓存命中
  const seen = [];
  const upstream = async (url, init) => {
    seen.push({ url, init });
    return sseResponse([
      event("message_start", { message: { usage: { input_tokens: 0 } } }),
      event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
      event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "hi" } }),
      event("message_delta", { delta: { stop_reason: "end_turn" }, usage: { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 2 } }),
      event("message_stop", {}),
    ]);
  };
  const provider = createMinimax();
  assert.equal(provider.id, "minimax");
  const ctx = { signal: new AbortController().signal, pool: {
    credentials: async () => ({ token: "mmoat_test" }),
    context: async () => ({ uid: "uid-1", models: [] }),
    network: () => ({ fetch: upstream }),
  } };
  const events = [];
  for await (const item of provider.invoke({ model: "minimax-m3.1-flash", input: { messages: [{ role: "user", content: "hello" }] } }, ctx)) events.push(item);
  assert.equal(seen.length, 1);
  const { url, init } = seen[0];
  assert.ok(url.startsWith("https://agent.minimax.cn/mavis/api/v1/llm/v1/messages?"), url);
  assert.ok(url.includes(`device_id=${deviceIdOf("uid-1", "mmoat_test")}`), "query 带账号派生指纹");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.authorization, "Bearer mmoat_test");
  assert.equal(init.headers.token, "mmoat_test");
  assert.equal(init.headers["anthropic-version"], "2023-06-01");
  assert.equal(init.headers.origin, "https://agent.minimax.cn");
  assert.equal(init.headers.referer, "https://agent.minimax.cn/");
  assert.match(init.headers["user-agent"], /^MiniMaxAgent /);
  // 签名与发送用同一份字符串：用实际 body 复核一遍（第二次 stringify 就会在这里失配）
  assert.equal(init.headers["x-signature"], sign(Number(init.headers["x-timestamp"]), init.body));
  const body = JSON.parse(init.body);
  assert.equal(body.model, "MiniMax-M3.1-Flash", "大小写归一到上游目录 id");
  assert.equal(body.max_tokens, 128000, "缺省 max_tokens 取模型上限");
  assert.equal(body.stream, true);
  assert.equal(events.find(item => item.type === "usage").usage.prompt_tokens, 7, "input 5 + cache_read 2");
  assert.equal(events.find(item => item.type === "usage").usage.cache_read_input_tokens, 2);
  assert.equal(events.find(item => item.type === "finish").reason, "stop");

  // 空响应（200 但一个内容块都没有）必须报错，不能给客户端一个空回答
  const empty = createMinimax();
  const emptyCtx = { signal: new AbortController().signal, pool: {
    credentials: async () => ({ token: "t" }),
    context: async () => ({}),
    network: () => ({ fetch: async () => sseResponse([event("message_start", { message: { usage: { input_tokens: 1 } } }), event("message_stop", {})]) }),
  } };
  await assert.rejects(async () => { for await (const item of empty.invoke({ model: "MiniMax-M3", input: {} }, emptyCtx)) void item; }, error => error.code === "UPSTREAM_FAILED");

  // ⑥ 国际版：整域切到 agent.minimax.io（账号体系独立，凭据不通用）
  const intl = createMinimax({}, "minimax_intl");
  assert.equal(intl.id, "minimax_intl");
  const intlSeen = [];
  const intlCtx = { signal: new AbortController().signal, pool: {
    credentials: async () => ({ token: "intl" }),
    context: async () => ({}),
    network: () => ({ fetch: async (url, init) => { intlSeen.push({ url, init }); return sseResponse([event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "ok" } }), event("message_delta", { delta: { stop_reason: "end_turn" }, usage: {} }), event("message_stop", {})]); } }),
  } };
  for await (const item of intl.invoke({ model: "MiniMax-M3", input: { messages: [{ role: "user", content: "hi" }] } }, intlCtx)) void item;
  assert.ok(intlSeen[0].url.startsWith("https://agent.minimax.io/mavis/api/v1/llm/v1/messages?"), intlSeen[0].url);
  assert.equal(intlSeen[0].init.headers.origin, "https://agent.minimax.io");
  assert.equal(intlSeen[0].init.headers.referer, "https://agent.minimax.io/");

  console.log("PASS MiniMax plugin static catalog, request signing (single stringify), common query, error mapping, SSE usage passthrough, and INTL region");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
