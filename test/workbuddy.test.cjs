"use strict";
const assert = require("node:assert/strict");
const { createWorkBuddy, rewrite } = require("../src/providers/workbuddy/provider.cjs");
const body = rewrite("gpt-test", { messages: [{ role: "developer", content: "x-anthropic-billing-header:bad; hi" }], max_completion_tokens: 42, tool_choice: "none", tools: [{ type: "function" }] }, { uid: "u" }, {});
assert.equal(body.stream, true);
assert.equal(body.max_tokens, 42);
assert.equal(body.messages[0].role, "system");
assert.equal(body.tools, undefined);
const injected = rewrite("gpt-test", { messages: [{ role: "user", content: "hi" }] }, { uid: "u" }, {});
assert.equal(injected.messages[0].role, "system");
assert.equal(injected.messages[0].content, "你是一个得力助手");
assert.match(injected.prompt_cache_key, /^wb2a-u-[a-f0-9]{32}$/);
assert.deepEqual(injected.stream_options, { include_usage: true });
const explicitStream = rewrite("gpt-test", { messages: [{ role: "system", content: "s" }], stream_options: { include_usage: false } }, {}, {});
assert.deepEqual(explicitStream.stream_options, { include_usage: false });
const image = rewrite("gpt-test", { messages: [{ role: "user", content: [{ type: "image_url", image_url: "data:image/png;base64,x" }] }] }, {}, {});
assert.deepEqual(image.messages[1].content[0].image_url, { url: "data:image/png;base64,x" });
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
  assert.equal(calls[0].options.headers["x-product"], "SaaS");
  assert.equal(calls[0].options.headers["x-ide-version"], "5.9.3");
  assert.equal(calls[0].options.headers.accept, "application/json");
  assert.equal(calls[0].options.headers["x-conversation-id"], undefined, "catalog requests do not carry conversation identity");
}
async function invoke(provider, channel, account) {
  const requests = [];
  const ctx = { signal: new AbortController().signal,
    pool: { ensureCredentials: async () => ({ token: "token-1" }),
      context: async () => account,
      network: () => ({ fetch: async (url, options) => { requests.push({ url, options });
        return new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }); } }) } };
  try {
    for await (const event of provider.invoke({ model: account.models[0].id, channel, input: { messages: [{ role: "user", content: "hi" }] } }, ctx)) void event;
  } catch { /* 空流走上游错误分支，这里只关心实际发出的请求 */ }
  return requests[0];
}
async function routingTest() {
  const provider = createWorkBuddy();
  const cn = await invoke(provider, "workbuddy", { uid: "user-1", enterpriseId: "ent-1", domain: "www.workbuddy.cn",
    models: [{ id: "public-id", routing: { upstreamModel: "upstream-id" } }] });
  assert.equal(cn.url, "https://www.workbuddy.cn/v2/chat/completions", "CN chat uses the desktop client endpoint");
  assert.equal(JSON.parse(cn.options.body).model, "upstream-id", "live routing carries the upstream model name");
  assert.equal(JSON.parse(cn.options.body).messages[0].content, "你是一个得力助手");
  assert.match(cn.options.headers["user-agent"], /^WorkBuddy\/5\.9\.3 WorkBuddy\/5\.9\.3 CLI\/2\.165\.0$/, "official three-segment desktop UA");
  assert.equal(cn.options.headers["x-product"], "SaaS");
  assert.equal(cn.options.headers["x-ide-name"], "WorkBuddy");
  assert.equal(cn.options.headers["x-ide-type"], "WorkBuddy");
  assert.equal(cn.options.headers["x-ide-version"], "5.9.3");
  assert.equal(cn.options.headers["x-private-data"], "true");
  assert.equal(cn.options.headers["x-agent-intent"], "craft");
  assert.equal(cn.options.headers["x-enterprise-id"], "ent-1");
  assert.equal(cn.options.headers["x-tenant-id"], "ent-1");
  assert.equal(cn.options.headers["x-domain"], "www.workbuddy.cn");
  assert.equal(cn.options.headers.referer, undefined, "desktop gateway requests do not send Referer");
  assert.equal(cn.options.headers["x-no-enterprise-id"], undefined, "identity headers are only sent when present");
  assert.ok(cn.options.headers["x-conversation-id"] && cn.options.headers["x-conversation-request-id"] && cn.options.headers["x-request-id"]);

  const ai = await invoke(provider, "workbuddy_ai", { uid: "user-2", enterpriseId: "ent-2", domain: "www.workbuddy.ai",
    models: [{ id: "ai-id", routing: { upstreamModel: "ai-upstream" } }] });
  assert.equal(ai.url, "https://www.workbuddy.ai/v2/chat/completions");
  assert.equal(JSON.parse(ai.options.body).model, "ai-upstream");
  assert.match(ai.options.headers["user-agent"], /^WorkBuddy\/5\.9\.4 WorkBuddy\/5\.9\.4 CLI\/2\.165\.0$/, "AI client has its own version");
  assert.equal(ai.options.headers["x-product"], "SaaS");
  assert.equal(ai.options.headers["x-ide-version"], "5.9.4");
  assert.equal(ai.options.headers["x-domain"], "www.workbuddy.ai");
}
catalogTest().then(routingTest).then(() => console.log("PASS WorkBuddy plugin provider: dual channels, scoped credentials, official client identity, body normalization, live routing and stream contract"))
  .catch(error => { console.error(error); process.exitCode = 1; });
