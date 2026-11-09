"use strict";
const assert = require("node:assert/strict");
const { ReadableStream } = require("node:stream/web");
const { createModelScope, resolveModel, rewriteBody } = require("../src/providers/modelscope/provider.cjs");

function response(status, type, chunks) {
  const bytes = chunks.map(value => Buffer.from(value));
  return { ok: status >= 200 && status < 300, status, headers: new Headers({ "content-type": type }),
    body: new ReadableStream({ start(controller) { for (const chunk of bytes) controller.enqueue(chunk); controller.close(); } }),
    async text() { return Buffer.concat(bytes).toString("utf8"); } };
}
function context(models = [{ id: "deepseek-ai/DeepSeek-V4.1-Flash", name: "DeepSeek" }, { id: "Qwen/Qwen3-Coder", name: "Qwen" }]) {
  return { accountId: "acct-test", models };
}
function ctx({ upstream, models } = {}) {
  const accountContext = context(models);
  const calls = [];
  return { calls, signal: new AbortController().signal, deadlineAt: Date.now() + 5000,
    pool: { credentials: async () => ({ token: "synthetic-secret" }), context: async () => accountContext,
      network: () => ({ fetch: async (url, options) => { calls.push({ url, options }); return upstream; } }) },
    attempts: { report: async () => {} } };
}
async function collect(provider, request, context) {
  const events = [];
  for await (const event of provider.invoke(request, context)) events.push(event);
  return events;
}

async function main() {
  const models = context().models;
  assert.equal(resolveModel("deepseek-v4.1-flash", models), "deepseek-ai/DeepSeek-V4.1-Flash");
  assert.equal(resolveModel("qwen3-coder", models), "Qwen/Qwen3-Coder");
  assert.equal(resolveModel("unknown", models), "unknown");
  const rewritten = rewriteBody("deepseek-v4.1-flash", { max_completion_tokens: 23, stream: true, stream_options: { include_usage: false } }, models);
  assert.equal(rewritten.model, "deepseek-ai/DeepSeek-V4.1-Flash");
  assert.equal(rewritten.max_tokens, 23);
  assert.equal("max_completion_tokens" in rewritten, false);
  assert.equal(rewritten.stream_options.include_usage, true);

  const provider = createModelScope({ base: "https://model.test/v1" });
  const streamCtx = ctx({ upstream: response(200, "text/event-stream", [
    `data: ${JSON.stringify({ choices: [{ delta: { role: null, content: "hello" } }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: " world" }, finish_reason: "stop" }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 } })}\n\n`,
    "data: [DONE]\n\n",
  ]) });
  const events = await collect(provider, { model: "deepseek-v4.1-flash", input: { messages: [{ role: "user", content: "hi" }], max_completion_tokens: 9, stream: true } }, streamCtx);
  assert.equal(streamCtx.calls.length, 1);
  assert.equal(streamCtx.calls[0].url, "https://model.test/v1/chat/completions");
  assert.equal(streamCtx.calls[0].options.headers.authorization, "Bearer synthetic-secret");
  const posted = JSON.parse(streamCtx.calls[0].options.body);
  assert.equal(posted.model, "deepseek-ai/DeepSeek-V4.1-Flash");
  assert.equal(posted.max_tokens, 9);
  assert.equal(posted.stream_options.include_usage, true);
  assert.equal(events.filter(event => event.type === "usage").length, 1, "zero placeholder usage is ignored");
  assert.deepEqual(events.filter(event => event.type === "delta").map(event => event.delta.content), ["hello", " world"]);
  assert.equal(events.at(-1).type, "finish");

  const jsonCtx = ctx({ upstream: response(200, "application/json", [JSON.stringify({ choices: [{ delta: { content: "", role: null }, message: { role: "assistant", content: "json answer" }, finish_reason: "stop" }], usage: { input_tokens: 4, output_tokens: 3 } })]) });
  const jsonEvents = await collect(provider, { model: "Qwen/Qwen3-Coder", input: { stream: false } }, jsonCtx);
  assert.equal(jsonEvents.find(event => event.type === "delta").delta.content, "json answer");
  assert.equal(jsonEvents.find(event => event.type === "usage").usage.total_tokens, 7);
  assert.equal(jsonEvents.at(-1).type, "finish");

  for (const [detail, expectedCode, expectedText] of [
    ["please bind your Alibaba Cloud account", "ACCOUNT_BIND_REQUIRED", "绑定阿里云"],
    ["real-name verified", "ACCOUNT_REAL_NAME_REQUIRED", "实名认证"],
  ]) {
    const bad = ctx({ upstream: response(403, "application/json", [detail]) });
    await assert.rejects(collect(provider, { model: "m", input: {} }, bad), error => error.code === expectedCode && error.message.includes(expectedText));
  }
  const inStreamGate = ctx({ upstream: response(200, "text/event-stream", [`data: ${JSON.stringify({ error: { message: "real-name verification required" } })}\n\n`]) });
  await assert.rejects(collect(provider, { model: "m", input: {} }, inStreamGate), error => error.code === "ACCOUNT_REAL_NAME_REQUIRED" && error.status === 403);
  const missing = ctx({ upstream: response(200, "application/json", ["{}"] ) });
  await assert.rejects(collect(provider, { model: "m", input: {} }, missing), error => error.code === "EMPTY_UPSTREAM_RESPONSE");
  const catalogCtx = ctx({ upstream: response(200, "application/json", [JSON.stringify({ object: "list", data: [
    { id: "Qwen/Qwen3.8-Flash-Next", object: "", owned_by: "system" },
    { id: "Qwen/Qwen-Image-Edit-2511", object: "", owned_by: "system" },
    { id: "Qwen/Qwen-Image", object: "", owned_by: "system" },
    { id: "Qwen/Qwen3.8-Flash-Next", owned_by: "duplicate" },
  ] })]) });
  const cachedModels = await provider.listModels({ grantId: "grant" }, { ...catalogCtx, pool: { ...catalogCtx.pool,
    context: async () => ({ models: [{ id: "cached-model" }] }), network: () => { throw new Error("ordinary catalog reads must not fetch"); } } });
  assert.deepEqual(cachedModels.map(model => model.id), ["cached-model"]);
  const liveModels = await provider.listModels({ grantId: "grant", force: true }, catalogCtx);
  assert.equal(catalogCtx.calls[0].url, "https://model.test/v1/models");
  assert.deepEqual(liveModels, [
    { id: "Qwen/Qwen3.8-Flash-Next", name: "Qwen/Qwen3.8-Flash-Next", capabilities: { tools: true }, contextLength: 0, maxOutputTokens: 0 },
    { id: "Qwen/Qwen-Image-Edit-2511", name: "Qwen/Qwen-Image-Edit-2511", capabilities: { images: true, tools: false }, contextLength: 0, maxOutputTokens: 0 },
    { id: "Qwen/Qwen-Image", name: "Qwen/Qwen-Image", capabilities: { images: false, tools: false }, contextLength: 0, maxOutputTokens: 0 },
  ], "live account catalog keeps exact upstream ids and only marks documented image/chat capabilities");
  const emptyCatalog = ctx({ upstream: response(200, "application/json", [JSON.stringify({ data: [] })]) });
  await assert.rejects(provider.listModels({ grantId: "grant", force: true }, emptyCatalog), error => error.code === "EMPTY_CATALOG");
  const unauthorizedCatalog = ctx({ upstream: response(401, "application/json", ["unauthorized"]) });
  await assert.rejects(provider.listModels({ grantId: "grant", force: true }, unauthorizedCatalog), error => error.code === "AUTH_REQUIRED");
  console.log("PASS ModelScope plugin provider: model IDs, token limits, usage, SSE/JSON, actionable account gates and empty-response guard");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
