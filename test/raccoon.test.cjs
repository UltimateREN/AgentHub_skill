"use strict";
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { rewriteBody, createRaccoon, parseCatalog } = require("../src/providers/raccoon/provider.cjs");
const body = rewriteBody("raccoon-chat", { messages: [{ role: "user", content: "hi" }] }, {});
assert.equal(body.model, "raccoon-chat-ml-5-5"); assert.equal(body.stream, true); assert.equal(body.stream_options.include_usage, true); assert.equal(body.max_tokens, 80000);
assert.equal(createRaccoon().id, "raccoon");
assert.deepEqual(parseCatalog({ data: { categories: [{ type: "image", models: [{ name: "ignored" }] }, { type: "chat", models: [
  { name: "model-id", display_name: "Model Display", params: { context_window: 131072, max_tokens: 8192 }, billing_effective_multiplier: 0.5, supports_reasoning: true },
  { name: "model-id", display_name: "duplicate" },
] }] } }), [{ id: "model-id", name: "Model Display", capabilities: { tools: true, reasoning: true }, contextLength: 131072, maxOutputTokens: 8192, rate: 0.5 }]);
async function main() {
  let received;
  const server = http.createServer((req, res) => { received = { headers: req.headers, body: "" }; req.setEncoding("utf8"); req.on("data", chunk => received.body += chunk); req.on("end", () => { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "hello" } }] })}\n\ndata: ${JSON.stringify({ choices: [{ finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } })}\n\ndata: [DONE]\n\n`); }); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const provider = createRaccoon({ chatUrl: `http://127.0.0.1:${server.address().port}/chat` });
    const ctx = { signal: new AbortController().signal, pool: { credentials: async () => ({ token: "scoped-token" }), context: async () => ({ accountId: "acct", uid: "uid", identity: { deviceId: "stable-device", officeIdentity: "org-1" } }), network: () => ({ fetch }) } };
    const catalogCalls = [];
    const catalogCtx = { pool: { credentials: async () => ({ token: "scoped-token" }), context: async () => ({ models: [{ id: "cached" }], identity: { officeIdentity: "org-1" } }),
      network: () => ({ fetch: async (url, options) => { catalogCalls.push({ url, options }); return new Response(JSON.stringify({ data: { categories: [{ type: "chat", models: [{ name: "live-model", display_name: "Live Model" }] }] } })); } }) } };
    assert.deepEqual((await provider.listModels({ grantId: "grant" }, catalogCtx)).map(item => item.id), ["cached"]);
    assert.deepEqual((await provider.listModels({ grantId: "grant", force: true }, catalogCtx)).map(item => item.id), ["live-model"]);
    assert.equal(catalogCalls[0].url, "https://xiaohuanxiong.com/api/web/llm/v2/model_catalog");
    assert.equal(catalogCalls[0].options.headers["X-Org-Code"], "org-1");
    await assert.rejects(provider.listModels({ grantId: "grant", force: true }, { ...catalogCtx, pool: { ...catalogCtx.pool,
      network: () => ({ fetch: async () => new Response(JSON.stringify({ data: { categories: [] } })) }) } }), error => error.code === "EMPTY_CATALOG");
    const events = []; for await (const event of provider.invoke({ model: "raccoon-chat", input: { messages: [{ role: "user", content: "你好" }] } }, ctx)) events.push(event);
    const sent = JSON.parse(received.body);
    assert.equal(received.headers.authorization, "Bearer scoped-token"); assert.equal(received.headers["x-client-device-id"], "stable-device"); assert.equal(received.headers["x-org-code"], "org-1");
    assert.match(received.headers["x-raccoon-title"], /%E4%BD%A0%E5%A5%BD/); assert.equal(sent.model, "raccoon-chat-ml-5-5");
    assert.equal(events[0].delta.content, "hello"); assert.equal(events.some(event => event.type === "usage" && event.usage.total_tokens === 3), true); assert.equal(events.at(-1).type, "finish");
    console.log("PASS Raccoon plugin provider: scoped identity/token, model alias, safe headers, SSE usage and finish");
  } finally { server.close(); await once(server, "close"); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
