"use strict";
// Command Code：8 键信封 / NDJSON → chat 帧 / 会话派生 / 错误分类
const assert = require("node:assert/strict");
const { ReadableStream } = require("node:stream/web");
const { createCommandCode, buildEnvelope, sessionIdOf, classify, mapFinishReason, FALLBACK_MODELS } = require("../src/providers/commandcode/provider.cjs");

/** 一行一个 JSON（无 data: 前缀），HTTP 恒 200 */
function ndjsonResponse(events, status = 200) {
  const text = events.map((event) => (typeof event === "string" ? event : JSON.stringify(event))).join("\n") + "\n";
  return {
    ok: status >= 200 && status < 300, status,
    headers: new Headers({ "content-type": "application/x-ndjson" }),
    body: new ReadableStream({ start(controller) { controller.enqueue(Buffer.from(text)); controller.close(); } }),
    async text() { return text; },
  };
}
function ctx({ upstream, models = [], headers = {} } = {}) {
  const calls = [];
  return { calls, signal: new AbortController().signal, request: { headers },
    pool: {
      credentials: async () => ({ token: "user_test-key" }),
      context: async () => ({ accountId: "a", uid: "u", models }),
      network: () => ({ fetch: async (url, init) => {
        calls.push({ url, init });
        // 两条预请求返回空体，正式生成返回上游事件
        if (/fingerprint|lifecycle/.test(url)) return ndjsonResponse([{ type: "ignored" }]);
        return upstream;
      } }),
    },
    attempts: { report: async () => {} } };
}
async function collect(provider, request, context) {
  const events = [];
  for await (const event of provider.invoke(request, context)) events.push(event);
  return events;
}

async function main() {
  // ===== 8 键信封 =====
  const envelope = buildEnvelope({ model: "gpt-5.5", messages: [
    { role: "system", content: "be brief" },
    { role: "user", content: "hello" },
  ], max_tokens: 999999, prompt_cache_key: "cache-key-1234" }, "11111111-2222-4333-8444-555555555555", "user_k");
  assert.deepEqual(Object.keys(envelope).sort(), ["config", "memory", "mode", "params", "permissionMode", "skills", "taste", "threadId"].sort());
  assert.equal(envelope.memory, null);
  assert.equal(envelope.taste, null);
  assert.equal(envelope.skills, null);
  assert.equal(envelope.permissionMode, "standard");
  assert.equal(envelope.mode, "agent");
  assert.equal(envelope.params.max_tokens, 200000, "max_tokens is capped at 200000");
  assert.equal(envelope.params.stream, true);
  assert.equal(envelope.params.system[0].text, "be brief", "system is hoisted to params.system");
  assert.deepEqual(envelope.params.system[0].cache_control, { type: "ephemeral" }, "prompt_cache_key moves the cache breakpoint to the last system block");
  assert.deepEqual(envelope.params.messages, [{ role: "user", content: [{ type: "text", text: "hello" }] }], "content is always a block array");
  assert.deepEqual(envelope.params.tools, [], "tools is always sent (empty array, not missing)");
  assert.equal(envelope.config.isGitRepo, false);
  assert.equal(envelope.config.structure.length, 0);

  // 无 system → 空格占位块（缺省会让上游注入 ~7.5K 默认提示词）
  const noSystem = buildEnvelope({ model: "m", messages: [{ role: "user", content: "x" }] }, "not-a-uuid", "k");
  assert.deepEqual(noSystem.params.system, [{ type: "text", text: " " }]);
  assert.equal("threadId" in noSystem, false, "threadId only when the session id is a UUID");
  assert.equal(noSystem.params.max_tokens, 64000, "default max_tokens");

  // tool_choice: none → 清空 tools 且不下发 tool_choice
  const none = buildEnvelope({ messages: [], tool_choice: "none", tools: [{ name: "t", parameters: { type: "object" } }] }, "s", "k");
  assert.deepEqual(none.params.tools, []);
  assert.equal("tool_choice" in none.params, false, "sending tool_choice=none would be rejected with 400");
  const toolChoice = buildEnvelope({ messages: [], tool_choice: { type: "function", function: { name: "lookup" } }, tools: [{ name: "lookup" }] }, "s", "k");
  assert.deepEqual(toolChoice.params.tool_choice, { type: "tool", name: "lookup" });
  assert.equal(toolChoice.params.tools.length, 1);
  assert.equal("type" in toolChoice.params.tools[0], false, "tools have no type field");

  // ===== 会话派生 =====
  assert.equal(sessionIdOf("m", [], [], {}, { "x-session-id": "hdr-1" }), "hdr-1");
  assert.equal(sessionIdOf("m", [], [], {}, { "x-claude-code-session-id": "hdr-2" }), "hdr-2");
  assert.equal(sessionIdOf("m", [], [], { session_id: "body-3" }, {}), "body-3");
  assert.equal(sessionIdOf("m", [], [], { prompt_cache_key: "short" }, {}).startsWith("short"), false, "short cache keys are not session ids");
  const derived = sessionIdOf("m", [{ text: "sys" }], [{ role: "user", content: "hi" }], {}, {});
  assert.match(derived, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, "derived id is a v5-shaped UUID");
  assert.equal(derived, sessionIdOf("m", [{ text: "sys" }], [{ role: "user", content: "hi" }], {}, {}), "derivation is stable");

  // ===== finish_reason 归一 =====
  assert.equal(mapFinishReason("max_output_tokens"), "length");
  assert.equal(mapFinishReason("model_context_window_exceeded"), "length");
  assert.equal(mapFinishReason("tool-call"), "tool_calls");
  assert.equal(mapFinishReason("network"), "stop");

  // ===== 错误分类 =====
  assert.equal(classify(429, JSON.stringify({ code: 81113 })).status, 413, "81113 is request-too-large, not rate limit");
  assert.equal(classify(400, "blocked by security policy").code, "CONTENT_BLOCKED");
  assert.equal(classify(402, "").status, 429, "402 is folded into rate limit so the pool backs off");
  assert.equal(classify(403, "").status, 401, "403 is folded into auth so the pool rotates accounts");

  // ===== NDJSON → chat 帧 =====
  const provider = createCommandCode({ base: "https://cc.test" });
  const upstream = ndjsonResponse([
    { type: "start" },
    { type: "text-start" },
    { type: "text-delta", text: "hello" },
    { type: "reasoning-delta", text: "think" },
    { type: "text-delta", text: " world" },
    { type: "tool-call", toolCallId: "call-1", toolName: "lookup", arguments: { q: 1 } },
    { type: "finish-step", finishReason: "tool-calls", usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 } },
    { type: "finish", finishReason: "tool-calls" },
  ]);
  const context = ctx({ upstream, models: [{ id: "gpt-5.5", name: "GPT-5.5" }] });
  const events = await collect(provider, { model: "gpt-5.5", input: { messages: [{ role: "user", content: "hi" }] } }, context);
  const generate = context.calls.find((call) => call.url.endsWith("/alpha/generate"));
  assert.ok(generate, "generate request sent");
  assert.equal(generate.init.headers["User-Agent"], "cli", "UA must literally be cli");
  assert.equal(generate.init.headers["x-command-code-version"], "1.53.1");
  assert.equal(generate.init.headers["x-cli-environment"], "production");
  assert.equal(generate.init.headers["x-taste-learning"], "false");
  assert.equal(generate.init.headers["x-co-flag"], undefined, "x-co-flag must never be sent");
  assert.equal(generate.init.headers.Authorization, "Bearer user_test-key");
  assert.match(generate.init.headers.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  assert.equal(context.calls.filter((call) => /fingerprint|lifecycle/.test(call.url)).length, 2, "both pre-requests are sent");
  assert.deepEqual(events.filter((event) => event.type === "delta" && event.delta.content).map((event) => event.delta.content), ["hello", " world"]);
  assert.equal(events.filter((event) => event.type === "delta" && event.delta.reasoning_content).length, 1);
  const toolFrame = events.find((event) => event.type === "delta" && event.delta.tool_calls);
  assert.equal(toolFrame.delta.tool_calls[0].function.name, "lookup");
  assert.equal(toolFrame.delta.tool_calls[0].function.arguments, JSON.stringify({ q: 1 }));
  assert.deepEqual(events.find((event) => event.type === "usage").usage, { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 });
  assert.deepEqual(events.at(-1), { type: "finish", reason: "tool_calls" });

  // 流内 error 事件（HTTP 恒 200）
  const errored = ctx({ upstream: ndjsonResponse([{ type: "error", statusCode: 401, message: "invalid key" }]) });
  await assert.rejects(collect(provider, { model: "m", input: { messages: [] } }, errored), (error) => error.code === "AUTH_REQUIRED");

  // 一个完成信号都没有 → 截断（不补 finish）
  const truncated = ctx({ upstream: ndjsonResponse([{ type: "text-delta", text: "half" }]) });
  await assert.rejects(collect(provider, { model: "m", input: { messages: [] } }, truncated), (error) => error.code === "TRUNCATED_UPSTREAM_RESPONSE");

  // 目录：普通读取用上下文，强制刷新走上游，空目录明确报错
  assert.deepEqual((await provider.listModels({ grantId: "g" }, { pool: { context: async () => ({ models: [{ id: "gpt-5.5" }] }) } })).map((m) => m.id), ["gpt-5.5"]);
  assert.equal((await provider.listModels({ grantId: "g" }, { pool: { context: async () => ({ models: [] }) } })).length, FALLBACK_MODELS.length, "no catalog → built-in 26");
  const catalogCtx = ctx({ upstream: { ok: true, status: 200, headers: new Headers(), async text() {
    return JSON.stringify({ data: [{ id: "gpt-5.5" }, { id: "deepseek/deepseek-v4-flash" }, { id: "gpt-5.5" }] });
  } } });
  const live = await provider.listModels({ grantId: "g", force: true }, catalogCtx);
  assert.deepEqual(live.map((m) => m.id), ["gpt-5.5", "deepseek/deepseek-v4-flash"], "duplicates removed, upstream ids kept verbatim");
  assert.equal(live[0].capabilities.images, false, "image support is never claimed without evidence");
  const emptyCatalog = ctx({ upstream: { ok: true, status: 200, headers: new Headers(), async text() { return JSON.stringify({ data: [] }); } } });
  await assert.rejects(provider.listModels({ grantId: "g", force: true }, emptyCatalog), (error) => error.code === "EMPTY_CATALOG");

  console.log("PASS Command Code: 8-key envelope, NDJSON→chat frames, session derivation, finish/usage ordering and error folding");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
