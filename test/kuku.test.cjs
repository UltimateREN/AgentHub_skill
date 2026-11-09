"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createKuku } = require("../src/providers/kuku/provider.cjs");

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

async function main() {
  const filename = path.resolve(__dirname, "../src/providers/kuku/credentials.cjs");
  assert.equal(fs.existsSync(filename), false, "Cookie parsing must remain in the AgentHub host");
  const source = fs.readFileSync(path.resolve(__dirname, "../src/providers/kuku/provider.cjs"), "utf8");
  assert.doesNotMatch(source, /parseCookieHeader|credentialsFromPayload/);

  const originalFetch = global.fetch;
  const requests = [];
  const reports = [];
  global.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    requests.push({ url, options });
    const cookie = options.headers?.Cookie || options.headers?.cookie;
    assert.match(cookie || "", /BDUSS=bduss-12345678/);
    assert.match(cookie || "", /STOKEN=business-token/);
    assert.match(cookie || "", /PTOKEN=passport-token/);
    assert.match(cookie || "", /gfprotpl=genflowpro/);
    if (url.pathname.endsWith("/common/userreport")) return json({ errno: 0, data: { bdstoken: "bdstoken", uinfo: "uinfo", uk: 7 } });
    if (url.pathname.endsWith("/model/list")) return json({ status: { code: 0 }, data: { model_list: [{ model_name: "remote-kuku-model" }] } });
    if (url.pathname.endsWith("/sendmsg")) return json({ status: { code: 0 }, data: { session_id: "session-1", reply_id: "reply-1" } });
    if (url.pathname.endsWith("/idallochstr") || url.pathname.endsWith("/sessionswitch")) return json({ status: { code: 0 } });
    if (url.pathname.endsWith("/getchatcontent")) {
      return new Response([
        `data: ${JSON.stringify({ type: "TEXT_BLOCK_DELTA", data: { delta: "hello" } })}\n\n`,
        `data: ${JSON.stringify({ type: "REPLY_END", data: {} })}\n\n`,
      ].join(""), { headers: { "content-type": "text/event-stream" } });
    }
    throw new Error(`Unexpected Kuku endpoint ${url.pathname}`);
  };

  try {
    const provider = createKuku({ baseUrl: "https://kuku.test", firstByteBaseMs: 1000 });
    const controller = new AbortController();
    const ctx = {
      signal: controller.signal,
      pool: { network: () => ({ fetch: (...args) => global.fetch(...args) }), credentials: async () => ({
        bduss: "bduss-12345678", stoken: "business-token", ptoken: "passport-token",
        extras: [["PTOKEN", "passport-token"], ["BAIDUID", "device-cookie"]],
      }), context: async () => ({ models: [{ id: "auto", name: "Automatic" }] }) },
      attempts: { report: async fact => { reports.push({ ...fact, requestCount: requests.length }); } },
    };
    const events = [];
    for await (const event of provider.invoke({ model: "auto", input: { messages: [{ role: "user", content: "test" }] } }, ctx)) events.push(event);
    assert.equal(requests.length, 5, "userreport, session create, allocation, session switch and model SSE are all plugin-owned");
    assert.deepEqual(reports.map(item => item.state), ["planned", "responded"]);
    assert.equal(reports[0].requestCount, 0, "planned is recorded before any upstream operation");
    assert.equal(reports[1].requestCount, 5, "responded is recorded when the model SSE response headers arrive");
    assert.equal(events.filter(item => item.type === "delta").map(item => item.delta.content).join(""), "hello");
    assert.equal(events.at(-1).type, "finish");
    assert.ok(requests.some(item => item.url.pathname.endsWith("/getchatcontent")));

    const beforeCatalog = requests.length;
    assert.deepEqual((await provider.listModels({ grantId: "grant" }, ctx)).map(item => item.id), ["auto"]);
    assert.equal(requests.length, beforeCatalog, "ordinary catalog reads use the host snapshot without network access");
    const refreshed = await provider.listModels({ grantId: "grant", force: true }, ctx);
    assert.deepEqual(refreshed.map(item => item.id), ["remote-kuku-model"]);
    assert.equal(requests.at(-1).url.pathname, "/wenchain/genflowpro/model/list");
    assert.match(requests.at(-1).url.search, /bdstoken=bdstoken&uinfo=uinfo&uk=7/);
    // 刷新出来的新模型必须马上能执行，不能只在列表里出现。
    const liveEvents = [];
    for await (const event of provider.invoke({ model: "remote-kuku-model", input: { messages: [{ role: "user", content: "test" }] } },
      { ...ctx, pool: { ...ctx.pool, context: async () => ({ models: refreshed }) } })) liveEvents.push(event);
    assert.equal(liveEvents.at(-1).type, "finish", "a freshly refreshed model executes without a restart");

    let networkCalls = 0;
    global.fetch = async () => { networkCalls++; throw new Error("invalid credentials must fail before network access"); };
    const invalid = provider.invoke({ model: "auto", input: { messages: [{ role: "user", content: "test" }] } }, {
      ...ctx, pool: { network: () => ({ fetch: (...args) => global.fetch(...args) }), context: async () => ({ models: [{ id: "auto" }] }), credentials: async () => ({ bduss: "", stoken: "", extras: [], ptoken: "" }) },
    });
    await assert.rejects(invalid.next(), error => error.category === "auth");
    assert.equal(networkCalls, 0);
    console.log("PASS Kuku provider: host-parsed credential projection, no plugin parser, four-hop model protocol, response-head facts and invalid-credential no-network gate");
  } finally { global.fetch = originalFetch; }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
