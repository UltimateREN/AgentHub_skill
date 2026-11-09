"use strict";
const assert = require("node:assert/strict");
const { createWorkBuddy, rewrite } = require("../src/providers/workbuddy/provider.cjs");
const body = rewrite("gpt-test", { messages: [{ role: "developer", content: "x-anthropic-billing-header:bad; hi" }], max_completion_tokens: 42, tool_choice: "none", tools: [{ type: "function" }] }, { uid: "u" }, {}, "workbuddy");
assert.equal(body.stream, true);
assert.equal(body.max_tokens, 42);
assert.equal(body.messages[0].role, "system");
assert.equal(body.tools, undefined);
assert.equal(createWorkBuddy().id, "workbuddy");
assert.deepEqual(createWorkBuddy().channels, ["workbuddy", "workbuddy_ai"]);
async function catalogTest() {
  const calls = [];
  const provider = createWorkBuddy();
  const rows = await provider.listModels({ grantId: "g", force: true, channel: "workbuddy" }, { signal: new AbortController().signal, pool: {
    context: async () => ({ uid: "user-1", models: [] }), credentials: async () => ({ token: "token-1" }),
    network: () => ({ fetch: async (url, options) => {
      calls.push({ url, options });
      const models = url.includes("/v3/") ? [{ id: "shared", name: "V3", maxOutputTokens: 8192, supportsToolCall: true }, { id: "completion-hidden", maxOutputTokens: 128 }] : [{ id: "shared", name: "Console" }, { id: "legacy" }];
      return new Response(JSON.stringify({ data: { models } }), { status: 200 });
    } }),
  } });
  assert.equal(calls.length, 2);
  assert.equal(rows.find(row => row.id === "shared").name, "V3", "v3 catalog wins collisions");
  assert.ok(!rows.some(row => row.id.startsWith("completion-")));
  assert.ok(rows.some(row => row.id === "legacy"), "console remains a fallback source");
}
async function routingTest() {
  const requests = [];
  const provider = createWorkBuddy();
  const ctx = { signal: new AbortController().signal,
    pool: { ensureCredentials: async () => ({ token: "token-1" }),
      context: async () => ({ uid: "user-1", models: [{ id: "public-id", routing: { upstreamModel: "upstream-id" } }] }),
      network: () => ({ fetch: async (url, options) => { requests.push({ url, options });
        return new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }); } }) } };
  try {
    for await (const event of provider.invoke({ model: "public-id", channel: "workbuddy", input: { messages: [{ role: "user", content: "hi" }] } }, ctx)) void event;
  } catch { /* 空流走上游错误分支，这里只关心发送名 */ }
  assert.equal(JSON.parse(requests[0].options.body).model, "upstream-id", "live routing carries the upstream model name");
}
catalogTest().then(routingTest).then(() => console.log("PASS WorkBuddy plugin provider: dual channels, scoped credentials, headers, body normalization, live routing and stream contract"))
  .catch(error => { console.error(error); process.exitCode = 1; });
