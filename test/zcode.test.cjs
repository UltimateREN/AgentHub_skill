"use strict";
const assert = require("node:assert/strict");
const { createZcode, glmModel, mappedError } = require("../src/providers/zcode/provider.cjs");
const { toAnthropic } = require("../src/providers/zcode/anthropic.cjs");

function event(type, data) { return `data: ${JSON.stringify({ type, ...data })}\n\n`; }
async function main() {
  assert.equal(glmModel("glm-5.3-flash"), "GLM-5.3-Flash");
  assert.equal(mappedError(403, { code: 3007 }, "captcha").code, "UPSTREAM_CHALLENGE");
  const payload = toAnthropic("GLM-5.3", { messages: [
    { role: "system", content: "instructions" }, { role: "user", content: "hello" },
    { role: "assistant", content: "working", tool_calls: [{ id: "call-1", function: { name: "lookup", arguments: "{\"x\":1}" } }] },
    { role: "tool", tool_call_id: "call-1", content: "ok" },
  ] }, { defaultMaxTokens: 128000 });
  assert.equal(payload.system, "instructions"); assert.equal(payload.max_tokens, 128000);
  assert.equal(payload.messages[1].content[1].type, "tool_use");
  assert.equal(payload.messages[2].content[0].type, "tool_result");

  const seen = [];
  let call = 0;
  const upstream = async (url, init) => {
    seen.push({ url, init, body: JSON.parse(init.body) });
    call++;
    if (call === 1) return new Response(JSON.stringify({ code: 1113, message: "Insufficient balance" }), { status: 402 });
    return new Response([
      event("message_start", { message: { usage: { input_tokens: 0 } } }),
      event("content_block_start", { index: 0, content_block: { type: "tool_use", id: "tool-1", name: "lookup" } }),
      event("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: "{\"ok\":true}" } }),
      event("content_block_start", { index: 1, content_block: { type: "text", text: "" } }),
      event("content_block_delta", { index: 1, delta: { type: "text_delta", text: "done" } }),
      event("message_delta", { delta: { stop_reason: "tool_use" }, usage: { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 2 } }),
      event("message_stop", {}),
    ].join(""), { headers: { "content-type": "text/event-stream" } });
  };
  const provider = createZcode({ zaiAnthropicBase: "https://test.example/zai", startPlanAnthropicBase: "https://test.example/start" });
  const ctx = { signal: new AbortController().signal, pool: {
    credentials: async () => ({ token: "jwt", modelApiKey: "key.secret" }),
    context: async () => ({ identity: { deviceMid: "device" }, models: [{ id: "glm-5.3", maxOutputTokens: 128000 }] }),
    network: () => ({ fetch: upstream }),
  } };
  const events = [];
  for await (const item of provider.invoke({ model: "glm-5.3", input: { messages: [{ role: "user", content: "hello" }] } }, ctx)) events.push(item);
  assert.equal(seen.length, 2, "paid-plan quota falls back once to JWT start-plan");
  assert.equal(seen[0].url, "https://test.example/zai/v1/messages");
  assert.equal(seen[0].init.headers["x-api-key"], "key.secret");
  assert.equal(seen[1].url, "https://test.example/start/v1/messages");
  assert.equal(seen[1].init.headers.authorization, "Bearer jwt");
  assert.equal(seen[1].body.metadata.user_id.includes("device"), true);
  assert.equal(events.find(item => item.type === "usage").usage.prompt_tokens, 7);
  assert.equal(events.find(item => item.type === "finish").reason, "tool_calls");
  assert.equal(events.filter(item => item.type === "finish").length, 1);
  assert.ok(events.some(item => item.delta?.tool_calls));
  assert.ok(events.some(item => item.delta?.content === "done"));

  const catalogProvider = createZcode();
  const catalog = await catalogProvider.listModels({ grantId: "grant", force: true }, { signal: ctx.signal, pool: {
    context: async () => ({ models: [{ id: "GLM-5.3", capabilities: { images: true }, contextLength: 1000000 }] }),
    credentials: async () => { throw new Error("Fixed catalog must not read credentials"); },
    network: () => { throw new Error("Fixed catalog must never query balance or network"); },
  } });
  assert.deepEqual(catalog.map(model => model.id), ["GLM-5.3"]);
  assert.equal(catalog[0].contextLength, 1000000);
  let partialCalls = 0;
  const partial = createZcode();
  const partialCtx = {
    signal: ctx.signal,
    pool: {
      credentials: ctx.pool.credentials,
      context: ctx.pool.context,
      network: () => ({ fetch: async () => {
        partialCalls++;
        return new Response([event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "already sent" } }),
          event("message_delta", { delta: { stop_reason: "end_turn" }, usage: {} }), event("error", { error: { code: 1113, message: "quota exhausted" } })].join(""), { headers: { "content-type": "text/event-stream" } });
      } }),
    },
  };
  const partialEvents = [];
  await assert.rejects(async () => { for await (const item of partial.invoke({ model: "GLM-5.3", input: { messages: [{ role: "user", content: "x" }] } }, partialCtx)) partialEvents.push(item); }, error => error.category === "quota");
  assert.equal(partialCalls, 1, "never replay a request after visible output");

  // 国际版：双区参数化验证——provider 默认 zai、无 bigmodel 并存推理平面、base 切到 api.z.ai
  const intl = createZcode({}, "zcode_intl");
  assert.equal(intl.id, "zcode_intl");
  assert.deepEqual(intl.channels, ["zcode_intl"]);
  const intlSeen = [];
  const intlCtx = {
    signal: new AbortController().signal,
    pool: {
      credentials: async () => ({ token: "intl-jwt", modelApiKey: "intl-key.secret" }),
      context: async () => ({ identity: { provider: "", deviceMid: "dev" }, models: [{ id: "glm-5.3" }] }),
      network: () => ({ fetch: async (url, init) => {
        intlSeen.push({ url, init });
        return new Response([event("message_start", { message: { usage: { input_tokens: 1 } } }),
          event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
          event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "intl" } }),
          event("message_delta", { delta: { stop_reason: "end_turn" }, usage: { input_tokens: 1, output_tokens: 2 } }),
          event("message_stop", {})].join(""), { headers: { "content-type": "text/event-stream" } });
      } }),
    },
  };
  const intlEvents = [];
  for await (const item of intl.invoke({ model: "glm-5.3", input: { messages: [{ role: "user", content: "hi" }] } }, intlCtx)) intlEvents.push(item);
  assert.equal(intlSeen.length, 1, "intl coding-plan succeeds on first try");
  assert.equal(intlSeen[0].url, "https://api.z.ai/api/anthropic/v1/messages", "intl coding-plan goes to api.z.ai (zai), never open.bigmodel.cn");
  assert.equal(intlSeen[0].init.headers["x-api-key"], "intl-key.secret");
  // INTL 无 bigmodel 并存推理平面：即使 context.identity.provider 误传 bigmodel，也回落 zai
  const intlBmSeen = [];
  const intlBmCtx = {
    signal: new AbortController().signal,
    pool: {
      credentials: async () => ({ token: "", modelApiKey: "k.s" }),
      context: async () => ({ identity: { provider: "bigmodel", deviceMid: "dev" }, models: [] }),
      network: () => ({ fetch: async (url) => { intlBmSeen.push(url); return new Response([event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "x" } }), event("message_delta", { delta: { stop_reason: "end_turn" }, usage: {} }), event("message_stop", {})].join(""), { headers: { "content-type": "text/event-stream" } }); } }),
    },
  };
  for await (const item of intl.invoke({ model: "glm-5.3", input: { messages: [{ role: "user", content: "hi" }] } }, intlBmCtx)) { if (item.type === "finish") break; }
  assert.ok(intlBmSeen[0].startsWith("https://api.z.ai/"), "intl never routes to open.bigmodel.cn even if provider=bigmodel");
  console.log("PASS ZCode plugin dual credentials, upstream override, Anthropic tools/usage, quota fallback, no replay after visible output, and INTL region");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
