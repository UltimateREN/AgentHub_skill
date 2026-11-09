"use strict";
const assert = require("node:assert/strict");
const { ReadableStream } = require("node:stream/web");
const { createCodeArts } = require("../src/providers/codearts/provider.cjs");

function response(frames) {
  const text = frames.map(frame => `data: ${frame}\n\n`).join("");
  return { ok: true, status: 200, body: new ReadableStream({ start(controller) { controller.enqueue(Buffer.from(text)); controller.close(); } }) };
}

async function main() {
  const calls = [];
  const provider = createCodeArts({ base: "https://codearts.test" });
  const catalogCalls = [];
  const catalogProvider = createCodeArts({ base: "https://codearts.test", pluginVersion: "26.9.101" });
  const catalog = await catalogProvider.listModels({ grantId: "catalog-grant", force: true }, { signal: new AbortController().signal, pool: {
    credentials: async () => ({ signing: { access_key_id: "ak", secret_access_key: "sk", security_token: "sts" } }),
    context: async () => ({ models: [] }),
    network: () => ({ fetch: async (url, options) => {
      catalogCalls.push({ url, options });
      let payload;
      if (url.includes("useragents")) payload = { agents: [{ agent_id: "agent-1" }] };
      else if (url.includes("agents/detail")) payload = { gpts: { models: [{ model_name: "Agent GPT", model_parameters: { model_id: "agent-gpt", enabled: true, context_window: 100000 } }] } };
      else if (url.endsWith("/v1/model/builtin")) payload = { builtinModels: [{ model_id: "GLM-5.3V", model_name: "GLM-5.3V", multimodal: true }] };
      else payload = { enabled: false };
      return new Response(JSON.stringify(payload), { status: 200 });
    } }),
  } });
  assert.equal(catalogCalls.length, 4, "manual refresh requests all three CodeArts sources and details each agent");
  assert.ok(catalogCalls.every(call => call.options.headers.Authorization.startsWith("SDK-HMAC-SHA256")));
  assert.deepEqual(catalog.map(model => model.id), ["agent-gpt", "GLM-5.3V"]);
  assert.equal(catalog[1].routing.source, "builtin");
  assert.equal(catalog[1].capabilities.images, true);
  const context = { accountId: "a1", maxConcurrent: 3, models: [{ id: "GLM-5.2", name: "GLM", source: "benefit", images: false }] };
  const ctx = { signal: new AbortController().signal, pool: {
    credentials: async () => ({ signing: { access_key_id: "ak", secret_access_key: "sk", security_token: "sts" } }),
    context: async () => context,
    network: () => ({ fetch: async (url, options) => { calls.push({ url, options }); return response([
      JSON.stringify({ choices: [{ delta: { reasoning_content: "think" } }] }),
      JSON.stringify({ choices: [{ delta: { content: "answer" }, finish_reason: "stop" }] }), "[DONE]"
    ]); } }),
  }, attempts: { report: async () => {} } };
  const events = [];
  for await (const event of provider.invoke({ model: "glm-5.2", input: { messages: [{ role: "user", content: "hi" }] } }, ctx)) events.push(event);
  assert.equal(calls.length, 1);
  const request = JSON.parse(calls[0].options.body);
  assert.equal(request.model, "GLM-5.2");
  assert.equal(calls[0].options.headers["maas_type"], "benefit");
  assert.equal(events.filter(event => event.type === "delta").length, 2);
  assert.equal(events.at(-1).type, "finish");
  // 实时目录把来源放在 routing 里，执行同样要带福利头。
  calls.length = 0;
  const liveContext = { ...context, models: [{ id: "GLM-5.2", name: "GLM", routing: { source: "benefit" } }] };
  for await (const event of provider.invoke({ model: "glm-5.2", input: { messages: [{ role: "user", content: "hi" }] } },
    { ...ctx, pool: { ...ctx.pool, context: async () => liveContext } })) void event;
  assert.equal(calls[0].options.headers["maas_type"], "benefit", "live routing keeps the benefit source");

  const signingFailure = createCodeArts({ base: "not-a-url" });
  await assert.rejects((async () => { for await (const _event of signingFailure.invoke({ model: "GLM-5.2", input: {} }, ctx)) {} })());
  let retried = 0;
  for await (const _event of provider.invoke({ model: "glm-5.2", input: { messages: [] } }, ctx)) retried++;
  assert.ok(retried > 0, "signing/setup failures release the account permit");

  const faultProvider = createCodeArts({ base: "https://codearts.test" });
  const faultCtx = { ...ctx, pool: { ...ctx.pool, network: () => ({ fetch: async () => response([JSON.stringify({ error_code: "InferHub.4291.200", error_msg: "rate limit" })]) }) } };
  await assert.rejects((async () => { for await (const _event of faultProvider.invoke({ model: "GLM-5.2", input: {} }, faultCtx)) {} })(), error => error.code === "QUOTA_EXHAUSTED" && error.status === 429);
  console.log("PASS CodeArts plugin provider: signed benefit headers, case-insensitive catalog, reasoning/content stream and in-stream fault");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
