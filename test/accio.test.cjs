"use strict";
const assert = require("node:assert/strict");
const { createAccio, parseCatalog } = require("../src/providers/accio/provider.cjs");
const { ReadableStream } = require("node:stream/web");
async function main() {
  const calls = [], facts = [];
  const provider = createAccio("accio", { llmBase: "https://accio.test/api/adk/llm" });
  const context = { models: [{ id: "gemini-test", name: "Gemini", upstreamKey: "upstream-gemini", protocolKind: "properties", reasoningEfforts: ["low", "high"] }] };
  assert.deepEqual(parseCatalog({ data: [{ modelList: [
    { modelCode: "opaque-code", modelDisplayName: "Model Display", visible: true, contextWindow: 262144, multimodal: true, reasoningEfforts: ["low"] },
    { modelCode: "hidden", visible: false },
  ] }] }), [{ id: "opaque-code", name: "Model Display", capabilities: { tools: true, images: true, reasoning: true }, contextLength: 262144, maxOutputTokens: 0,
    routing: { upstreamKey: "opaque-code", protocolKind: "top", reasoningEfforts: ["low"] } }]);
  // 上游代号会换，展示名不会。老配置写的是代号之前的名字，目录按展示名接回去。
  assert.deepEqual(parseCatalog({ data: [{ modelList: [
    { modelCode: "1Orbit-abc", modelDisplayName: "Claude Sonnet 4.6", visible: true, protocol: "responses" },
  ] }] })[0], { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", capabilities: { tools: true, images: false, reasoning: false }, contextLength: 0, maxOutputTokens: 0,
    routing: { upstreamKey: "1Orbit-abc", protocolKind: "properties", reasoningEfforts: [] } });
  const catalogCalls = [];
  const catalogProvider = createAccio("accio_cn", { gatewayBase: "https://catalog.test" });
  const catalogCtx = { signal: new AbortController().signal, pool: { credentials: async () => ({ token: "catalog-token" }), context: async () => ({ models: [{ id: "cached" }] }),
    network: () => ({ fetch: async (url, options) => { catalogCalls.push({ url, options });
      if (url.endsWith("/api/llm/config")) return new Response("unavailable", { status: 503 });
      return new Response(JSON.stringify({ data: [{ modelList: [{ modelCode: "live-code", modelDisplayName: "Live Model", visible: true, reasoningEfforts: [] }] }] }));
    } }) } };
  assert.deepEqual((await catalogProvider.listModels({ grantId: "grant" }, catalogCtx)).map(item => item.id), ["cached"]);
  assert.deepEqual((await catalogProvider.listModels({ grantId: "grant", force: true }, catalogCtx)).map(item => item.id), ["live-code"]);
  assert.deepEqual(catalogCalls.map(call => call.url), ["https://catalog.test/api/llm/config", "https://catalog.test/api/llm/config/v2"]);
  assert.equal(catalogCalls[1].options.headers["x-package-region"], "CN");
  assert.deepEqual(JSON.parse(catalogCalls[1].options.body), { token: "catalog-token", supportAutoModel: true });
  await assert.rejects(catalogProvider.listModels({ grantId: "grant", force: true }, { ...catalogCtx,
    pool: { ...catalogCtx.pool, network: () => ({ fetch: async () => new Response(JSON.stringify({ data: [] })) }) } }), error => error.code === "CATALOG_REFRESH_FAILED");
  const ctx = { signal: new AbortController().signal, pool: { credentials: async () => ({ token: "access-token" }), context: async () => context,
    network: () => ({ fetch: async (url, options) => { calls.push({ url, options }); const text = [`data: ${JSON.stringify({ content: { role: "model", parts: [{ text: "hello" }] }, partial: true })}\n\n`, `data: ${JSON.stringify({ turnComplete: true, finishReason: "STOP", usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1 } })}\n\n`, "data: [DONE]\n\n"].join(""); return { ok: true, status: 200, body: new ReadableStream({ start(controller) { controller.enqueue(Buffer.from(text)); controller.close(); } }) }; } }) }, attempts: { report: async value => facts.push(value) } };
  const events = []; for await (const event of provider.invoke({ model: "gemini-test", input: { messages: [{ role: "user", content: "hello" }], reasoning_effort: "high" } }, ctx)) events.push(event);
  assert.match(calls[0].url, /^https:\/\/accio\.test\/api\/adk\/llm\/generateContent\?sg_k=[a-f0-9]{32}$/);
  const payload = JSON.parse(calls[0].options.body); assert.equal(payload.model, "upstream-gemini"); assert.equal(payload.token, "access-token"); assert.equal(payload.properties.reasoning_effort, "high"); assert.equal(payload.reasoning_effort, undefined);
  assert.deepEqual(facts.map(value => value.state), ["planned", "responded"]); assert.equal(events.some(event => event.type === "delta" && event.delta.content === "hello"), true); assert.equal(events.at(-1).type, "finish");
  // 刷新后的目录只带 routing；执行必须用 routing 里的上游代号与档位落点。
  const liveContext = { models: [{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6",
    routing: { upstreamKey: "1Orbit-abc", protocolKind: "properties", reasoningEfforts: ["low", "high"] } }] };
  const liveCtx = { ...ctx, pool: { ...ctx.pool, context: async () => liveContext } };
  calls.length = 0;
  for await (const event of provider.invoke({ model: "claude-sonnet-4-6", input: { messages: [{ role: "user", content: "hello" }], reasoning_effort: "high" } }, liveCtx)) void event;
  const livePayload = JSON.parse(calls[0].options.body);
  assert.equal(livePayload.model, "1Orbit-abc");
  assert.equal(livePayload.properties.reasoning_effort, "high");
  // 老配置直接写代号，也要命中同一条目录。
  calls.length = 0;
  for await (const event of provider.invoke({ model: "1Orbit-abc", input: { messages: [{ role: "user", content: "hello" }] } }, liveCtx)) void event;
  assert.equal(JSON.parse(calls[0].options.body).model, "1Orbit-abc");
  console.log("PASS Accio plugin provider: scoped credentials/catalog, stable ids, live routing, ADK body and SSE translation");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
