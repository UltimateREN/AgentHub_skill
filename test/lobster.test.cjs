"use strict";
const assert = require("node:assert/strict");
const { ReadableStream } = require("node:stream/web");
const { createLobster, rewriteBody } = require("../src/providers/lobster/provider.cjs");

function response(status, frames) {
  const bytes = frames.map(frame => Buffer.from(frame));
  return { ok: status >= 200 && status < 300, status, headers: new Headers({ "content-type": "text/event-stream" }),
    body: new ReadableStream({ start(controller) { for (const value of bytes) controller.enqueue(value); controller.close(); } }) };
}
function context(upstream) {
  const calls = [];
  return { calls, signal: new AbortController().signal, deadlineAt: Date.now() + 5000,
    pool: { credentials: async () => ({ token: "test-token" }), context: async () => ({ models: [{ id: "MiniMax-M3" }] }),
      network: () => ({ fetch: async (url, options) => { calls.push({ url, options }); return upstream; } }) },
    attempts: { report: async () => {} } };
}
async function collect(provider, ctx) {
  const events = [];
  for await (const event of provider.invoke({ model: "MiniMax-M3", input: { model: "old", stream: false, tool_choice: "none",
    conversation_id: "private", prompt_cache_key: "private", messages: [{ role: "user", content: "hi" }] } }, ctx)) events.push(event);
  return events;
}
async function main() {
  const body = rewriteBody("model-a", { stream: false, stream_options: { include_usage: false }, tool_choice: "none", conversation_id: "x", prompt_cache_key: "y" });
  assert.equal(body.stream, true);
  assert.equal(body.stream_options.include_usage, true);
  assert.equal("tool_choice" in body, false);
  assert.equal("conversation_id" in body, false);
  assert.equal("prompt_cache_key" in body, false);

  const provider = createLobster({ base: "https://lobster.test/api/proxy/v1", clientVersion: "2026.9.23" });
  const catalogCalls = [];
  const refreshedModels = await provider.listModels({ grantId: "g", force: true }, { signal: new AbortController().signal, pool: {
    context: async () => ({ models: [{ id: "cached" }] }), credentials: async () => ({ token: "token" }),
    network: () => ({ fetch: async (url, options) => {
      catalogCalls.push({ url, options });
      if (url.endsWith("/available")) return new Response("{}", { status: 503 });
      return new Response(JSON.stringify({ data: { textModels: [{ modelId: "MiniMax-M4", modelName: "MiniMax M4", supportsImage: true, supportsThinking: false, contextWindow: 200000, costMultiplier: 1.25, keyfrom: "route-a" }] } }), { status: 200 });
    } }),
  } });
  assert.equal(catalogCalls.length, 2, "public pricing catalog is the fallback after the authenticated catalog fails");
  assert.equal(refreshedModels[0].id, "MiniMax-M4");
  assert.equal(refreshedModels[0].routing.keyfrom, "route-a");
  assert.equal(refreshedModels[0].capabilities.images, true);
  const stream = context(response(200, [
    `data: ${JSON.stringify({ choices: [{ delta: { content: "before <thi" } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: "nk>private thought</think> after" } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "lookup", arguments: "{\"q\":" } }] } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "lookup", arguments: "\"x\"}" } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } })}\n\n`,
    "data: [DONE]\n\n",
  ]));
  const events = await collect(provider, stream);
  assert.equal(stream.calls.length, 1);
  assert.equal(stream.calls[0].url, "https://lobster.test/api/proxy/v1/chat/completions");
  assert.equal(stream.calls[0].options.headers.authorization, "Bearer test-token");
  assert.equal(stream.calls[0].options.headers["X-LobsterAI-Client-Version"], "2026.9.23");
  const sent = JSON.parse(stream.calls[0].options.body);
  assert.equal(sent.model, "MiniMax-M3");
  assert.equal(sent.stream, true);
  assert.equal(sent.stream_options.include_usage, true);
  assert.deepEqual(events.filter(event => event.type === "delta").slice(0, 3).map(event => event.delta), [
    { content: "before " }, { reasoning_content: "private thought" }, { content: " after" },
  ]);
  const tools = events.filter(event => event.type === "delta").flatMap(event => event.delta.tool_calls || []);
  assert.equal(tools[0].function.name, "lookup");
  assert.equal("name" in tools[1].function, false, "tool name is only sent on first fragment");
  assert.equal(events.find(event => event.type === "usage").usage.total_tokens, 7);
  assert.equal(events.at(-1).type, "finish");

  const quota = context(response(200, [`data: ${JSON.stringify({ error: { code: 40201, message: "insufficient credits" } })}\n\n`]));
  await assert.rejects(collect(provider, quota), error => error.code === "QUOTA_EXHAUSTED" && error.status === 402);
  const empty = context(response(200, ["data: [DONE]\n\n"]));
  await assert.rejects(collect(provider, empty), error => error.code === "UPSTREAM_FAILED" && error.status === 502);
  console.log("PASS Lobster plugin provider: OpenAI SSE, model limits, split think tags, tool deltas, usage, quota and empty response");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
