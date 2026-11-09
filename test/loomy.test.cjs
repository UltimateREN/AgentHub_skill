"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { RpcPeer } = require("../sdk/rpc.cjs");
const { ProviderSession } = require("../sdk/provider-session.cjs");
const { LIMITS } = require("../sdk/provider-protocol.cjs");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ah-independent-plugin-"));

async function main() {
  let mode = "normal", received, stopped = 0;
  const upstream = http.createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    received = { url: req.url, headers: req.headers, body: text ? JSON.parse(text) : null };
    if (req.method === "GET" && req.url === "/api/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [
        { id: "spark-x", name: "Spark X2.5 (x0.1)", context_window: 128000, max_output_tokens: 8192,
          capabilities: { reasoning: true, function_calling: true, vision: true, input_modalities: ["text", "image"] } },
        { id: "anthropic-model", protocol: "anthropic_messages" },
        { id: "image-only", type: "image" },
      ] })); return;
    }
    if (mode === "401") { res.writeHead(401); res.end("sensitive upstream details"); return; }
    if (mode === "429") { res.writeHead(429); res.end("upstream rate detail"); return; }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = value => res.write(`data: ${JSON.stringify(value)}\n\n`);
    if (mode === "hold") {
      send({ choices: [{ delta: { content: "started" } }] });
      res.once("close", () => { stopped++; });
      return;
    }
    if (mode === "business-auth") {
      send({ code: "020002", desc: "session expired" });
      res.end(); return;
    }
    send({ choices: [{ delta: { content: "你" } }] });
    send({ choices: [{ delta: { content: "好", tool_calls: [{ index: 0, id: "one", type: "function", function: { name: "lookup", arguments: "{}" } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 } });
    res.end("data: [DONE]\n\n");
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  fs.writeFileSync(path.join(temporary, "settings.json"), JSON.stringify({ loomy: { modelBase: `http://127.0.0.1:${upstream.address().port}/api/v1`, models: ["deepseek-real"] } }));
  const child = spawn(process.execPath, [path.resolve(__dirname, "../src/main.cjs")], {
    cwd: path.resolve(__dirname, ".."), windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", AGENTHUB_PLUGIN_DATA_DIR: temporary },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let diagnostics = "";
  child.stderr.on("data", buffer => { diagnostics = (diagnostics + buffer).slice(-4096); });
  const exited = new Promise(resolve => child.once("exit", resolve));
  const peer = new RpcPeer({ input: child.stdout, output: child.stdin, prefix: "h:", remotePrefix: "p:", maxFrameBytes: LIMITS.frameBytes });
  const closeNetwork = require("./network-fixture.cjs").installNetwork(peer, `http://127.0.0.1:${upstream.address().port}`);
  const grants = new Set();
  peer.handle("pool.readForwardCredentials", ({ grantId }) => {
    assert.ok(grants.has(grantId));
    return { token: "test-session" };
  });
  peer.handle("pool.readForwardContext", ({ grantId }) => {
    assert.ok(grants.has(grantId));
    return { models: [{ id: "deepseek-real" }] };
  });
  const session = new ProviderSession({
    peer, identity: { pluginId: "com.agenthub.forwarding-suite", publisherId: "test-publisher", generation: 1 },
    declarations: require("../manifest.json").contributes.providers,
    onRevoke: id => { grants.delete(id); closeNetwork(id); },
  });
  let counter = 0;
  const invoke = (onEvent = () => {}, extra = {}) => {
    const id = `invocation-${++counter}`;
    grants.add(id);
    return session.invoke({ invocationId: id, providerId: "loomy", channel: "loomy", model: "deepseek-real", grantId: id, deadlineAt: Date.now() + 5000,
      input: { model: "visible-deepseek-alias", messages: [{ role: "user", content: [{ type: "text", text: "test" }, { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } }] }] }, onEvent, ...extra });
  };
  try {
    await session.initialize();
    grants.add("catalog-refresh");
    const catalogArgs = { providerId: "loomy", channel: "loomy", grantId: "catalog-refresh", invocationId: "catalog-refresh" };
    const beforeRead = received;
    assert.deepEqual(await session.listModels(catalogArgs), [{ id: "deepseek-real" }]);
    assert.equal(received, beforeRead, "ordinary catalog reads must not access the network");
    const refreshed = await session.listModels({ ...catalogArgs, force: true });
    assert.deepEqual(refreshed, [{ id: "spark-x", name: "Spark X2.5", rate: 0.1,
      contextLength: 128000, maxOutputTokens: 8192,
      capabilities: { images: true, tools: true, reasoning: true, video: false } }]);
    assert.equal(received.url, "/api/v1/models");
    assert.equal(received.headers.authorization, "Bearer test-session");
    grants.delete("catalog-refresh");
    assert.deepEqual(await session.listModels({ providerId: "loomy", channel: "loomy" }), [{ id: "deepseek-real" }]);
    const events = [];
    await invoke(event => { events.push(event); });
    assert.equal(received.url, "/api/v1/chat/completions");
    assert.equal(received.headers.token, "test-session");
    assert.equal(received.headers.authorization, "Bearer test-session");
    assert.equal(received.body.model, "deepseek-real", "resolved target model, not visible alias, goes upstream");
    assert.equal(received.body.messages[0].content[1].text, "<image_base64>QUJD</image_base64>");
    assert.equal(events.filter(event => event.type === "delta").map(event => event.delta.content).join(""), "你好");
    assert.equal(events.at(-2).usage.total_tokens, 7, "usage preceding final termination must survive");
    assert.equal(events.at(-1).reason, "tool_calls");
    assert.equal(events.filter(event => event.type === "finish").length, 1);
    for (const [testMode, category] of [["401", "auth"], ["429", "rate"], ["business-auth", "auth"]]) {
      mode = testMode;
      await assert.rejects(invoke(), error => error.category === category && !error.message.includes("sensitive"));
      assert.equal(grants.size, 0);
    }
    mode = "hold";
    const controller = new AbortController();
    const cancelled = invoke(event => { if (event.type === "delta") controller.abort(new Error("cancel-test")); }, { signal: controller.signal });
    await assert.rejects(cancelled, /cancel-test/);
    const deadline = Date.now() + 2500;
    while (stopped === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(stopped, 1, "cancel must abort the real upstream HTTP stream");
    assert.equal(grants.size, 0);
    assert.equal(diagnostics, "", "no credential-bearing diagnostics");
    console.log("PASS independent Loomy plugin: real child/loopback, scoped token, resolved models, images, tools, usage/terminal order, HTTP/business auth errors, rate errors and upstream cancellation");
  } finally {
    closeNetwork(); session.close(); child.kill(); await exited;
    await new Promise(resolve => upstream.close(resolve));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
