"use strict";
// OfficeAce：OpenAI 兼容薄转发 + max_tokens 追加规则 + 恒流式 + 81113/content_filter 判定
const assert = require("node:assert/strict");
const { ReadableStream } = require("node:stream/web");
const { createOfficeAce, normalizeBase, chatEndpoint, rewriteBody, budgetOf, classify, REASONING_ALLOWANCE } = require("../src/providers/officeace/provider.cjs");

function sseResponse(frames, status = 200) {
  const text = frames.map((frame) => (typeof frame === "string" ? frame : `data: ${JSON.stringify(frame)}\n\n`)).join("");
  return {
    ok: status >= 200 && status < 300, status,
    headers: new Headers({ "content-type": "text/event-stream" }),
    body: new ReadableStream({ start(controller) { controller.enqueue(Buffer.from(text)); controller.close(); } }),
    async text() { return text; },
  };
}
function ctx({ upstream, token = "dGVzdA==", baseUrl = "https://gw.test/v2", models = [] } = {}) {
  const calls = [];
  return { calls, signal: new AbortController().signal,
    pool: {
      credentials: async () => ({ token, baseUrl }),
      context: async () => ({ accountId: "a", uid: "u", models }),
      network: () => ({ fetch: async (url, init) => { calls.push({ url, init }); return upstream; } }),
    },
    attempts: { report: async () => {} } };
}
async function collect(provider, request, context) {
  const events = [];
  for await (const event of provider.invoke(request, context)) events.push(event);
  return events;
}

async function main() {
  // ===== 基址规范化 =====
  assert.equal(normalizeBase("https://gw.test"), "https://gw.test/v2");
  assert.equal(normalizeBase("https://gw.test/v2/"), "https://gw.test/v2");
  assert.equal(chatEndpoint("https://gw.test"), "https://gw.test/v2/chat/completions");

  // ===== max_tokens 追加（不是取 max）=====
  assert.equal(budgetOf({ max_tokens: 100 }), 100 + REASONING_ALLOWANCE);
  assert.equal(budgetOf({ max_tokens: 8 }), 8, "tiny budgets pass through unchanged");
  assert.equal(budgetOf({}), null);
  const body = rewriteBody({ max_completion_tokens: 50, stream: false });
  assert.equal(body.max_tokens, 50 + REASONING_ALLOWANCE);
  assert.equal("max_completion_tokens" in body, false);
  assert.equal(body.stream, true, "upstream is stream-only");
  assert.deepEqual(body.stream_options, { include_usage: true });

  // ===== 错误分类 =====
  assert.equal(classify(429, JSON.stringify({ code: 81113 })).status, 413, "81113 is request-too-large, not rate limit");
  assert.equal(classify(400, "content_filter").code, "CONTENT_BLOCKED");
  assert.equal(classify(402, "").status, 429);

  // ===== 转发 =====
  const provider = createOfficeAce({});
  const context = ctx({ upstream: sseResponse([
    { choices: [{ delta: { content: "hi" } }] },
    { choices: [{ delta: { content: " there" }, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
    "[DONE]",
  ]) });
  const events = await collect(provider, { model: "officeace-chat", input: { messages: [{ role: "user", content: "hi" }], max_tokens: 32 } }, context);
  assert.equal(context.calls[0].url, "https://gw.test/v2/chat/completions");
  assert.equal(context.calls[0].init.headers.Authorization, "Basic dGVzdA==", "Basic header carries the pre-encoded key:secret");
  assert.equal(context.calls[0].init.headers.lang, "en");
  assert.ok(context.calls[0].init.headers["Chat-Id"], "desktop correlation headers are sent");
  assert.ok(context.calls[0].init.headers["Session-Id"]);
  const posted = JSON.parse(context.calls[0].init.body);
  assert.equal(posted.max_tokens, 32 + REASONING_ALLOWANCE);
  assert.equal(posted.stream, true);
  assert.deepEqual(events.filter((event) => event.type === "delta").map((event) => event.delta.content), ["hi", " there"]);
  assert.deepEqual(events.find((event) => event.type === "usage").usage, { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
  assert.deepEqual(events.at(-1), { type: "finish", reason: "stop" });

  // 假答复：HTTP 200 + finish_reason=content_filter → 内容拦截（不罚账号）
  const blocked = ctx({ upstream: sseResponse([{ choices: [{ delta: { content: "" }, finish_reason: "content_filter" }] }]) });
  await assert.rejects(collect(provider, { model: "m", input: { messages: [] } }, blocked), (error) => error.code === "CONTENT_BLOCKED");

  // 空正文（预算被推理吃光）→ 明确报错，不谎报成功
  const empty = ctx({ upstream: sseResponse([{ choices: [{ delta: {}, finish_reason: "length" }] }, "[DONE]"]) });
  await assert.rejects(collect(provider, { model: "m", input: { messages: [] } }, empty), (error) => error.code === "EMPTY_UPSTREAM_RESPONSE");

  // 缺 baseUrl → 明确拒绝（不是打到一个空 URL）
  const noBase = ctx({ upstream: sseResponse([]), baseUrl: "" });
  await assert.rejects(collect(provider, { model: "m", input: { messages: [] } }, noBase), (error) => error.code === "MISSING_BASE_URL");

  // 目录：普通读取用上下文；强制刷新走 `/v2/models`（与 chat 共用规范化基址，Basic）
  assert.deepEqual((await provider.listModels({ grantId: "g" }, { pool: { context: async () => ({ models: [{ id: "m1" }] }) } })).map((m) => m.id), ["m1"]);
  const catalogCtx = ctx({ upstream: { ok: true, status: 200, headers: new Headers(), async text() {
    return JSON.stringify({ data: [{ id: "officeace-chat" }, { id: "glm-5.3" }, { id: "glm-5.3" }] });
  } } });
  const live = await provider.listModels({ grantId: "g", force: true }, catalogCtx);
  assert.equal(catalogCtx.calls[0].url, "https://gw.test/v2/models", "catalog lives under /v2, same base as chat/completions");
  assert.deepEqual(live.map((m) => m.id), ["officeace-chat", "glm-5.3"]);

  console.log("PASS OfficeAce: base normalization, reasoning budget allowance, always-stream rewrite, 81113/content_filter folding and catalog");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
