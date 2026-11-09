"use strict";
// Standalone child + real HTTP, synthetic credentials, no host source dependency.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { RpcPeer } = require("../sdk/rpc.cjs");
const { ProviderSession } = require("../sdk/provider-session.cjs");
const { validateExecutionFacts } = require("../sdk/provider-protocol.cjs");
const { rewriteBody } = require("../src/providers/autoclaw/provider.cjs");
const { resolveRoute } = require("../src/providers/autoclaw/models.cjs");
const defaults = require("../src/providers/autoclaw/defaults.json");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ah-autoclaw-plugin-"));
const entries = [{ id: "catalog-only", name: "Catalog Display", routeId: "zaicoding_private-route" }];
const input = { messages: [{ role: "system", content: "İ YOU ARE CODEX 中文" },
  { role: "developer", content: [{ type: "text", text: "You are Claude Code" }] },
  { role: "user", content: "You are Codex" }], max_tokens: 12, max_completion_tokens: 99 };

async function main() {
  const before = structuredClone(input);
  for (const model of ["catalog-only", "Catalog Display", "zaicoding_private-route"]) {
    const changed = rewriteBody(model, input, entries);
    assert.equal(changed.routeModelId, "zaicoding_private-route");
    assert.equal(changed.body.model, "catalog-only");
    assert.match(changed.body.messages[0].content, /^You are a personal assistant running inside OpenClaw\./);
    assert.match(changed.body.messages[0].content, /İ You are a coding agent 中文/);
    assert.match(changed.body.messages[1].content[0].text, /You are a coding assistant/);
    assert.equal(changed.body.messages[2].content, "You are Codex");
    assert.equal(changed.body.max_tokens, 10000);
    assert.equal(changed.body.max_completion_tokens, 99);
    assert.deepEqual(rewriteBody(model, changed.body, entries).body, changed.body, "rewrite is idempotent");
  }
  for (const value of [0, -1, null, "4096", 1.5, 10000, 20000]) {
    assert.equal(rewriteBody("catalog-only", { max_tokens: value }, entries).body.max_tokens, value);
  }
  assert.equal("max_tokens" in rewriteBody("unknown", {}, entries).body, false);
  assert.deepEqual(resolveRoute("unknown", entries), { routeModelId: "zai_auto", bodyModelId: "unknown" });
  assert.deepEqual(resolveRoute("Catalog Display", [{ id: "catalog-only", name: "Catalog Display", routing: { routeId: "zaicoding_private-route" } }]),
    { routeModelId: "zaicoding_private-route", bodyModelId: "catalog-only" }, "live routing carries the private route id");
  assert.deepEqual(resolveRoute("zaicoding_model", []), { routeModelId: "zaicoding_model", bodyModelId: "model" });
  assert.deepEqual(input, before);
  assert.match(defaults.autoclaw.userapiBase, /acceleration/);
  assert.equal(defaults.autoclaw.llmVersion, "2.2.0");
  assert.equal(defaults.autoclaw_intl.llmVersion, "1.17.8");

  let mode = "ok", received, sent = 0, preflights = 0, closed = 0, catalogCalls = 0;
  const timers = new Set();
  const upstream = http.createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    if (req.url === "/autoclaw-proxy/proxy/autoclaw-model-config") {
      catalogCalls++;
      received = { url: req.url, headers: req.headers };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [{ id: "zaicoding_catalog-only", name: "Catalog Display", input: ["text", "image"], contextWindow: 65536, maxTokens: 8192 }] }));
      return;
    }
    sent++; received = { url: req.url, headers: req.headers, body: JSON.parse(raw) };
    if (["401", "402", "429", "413", "406", "large"].includes(mode)) {
      res.writeHead(mode === "large" ? 500 : Number(mode), { "retry-after": "3" });
      res.end(mode === "large" ? "x".repeat(65537) : mode === "406" ? "" : "private-detail"); return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders();
    const emit = chunk => res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    if (mode === "headers-only") { res.once("close", () => { closed++; }); return; }
    if (mode === "empty") { res.end("data: [DONE]\n\n"); return; }
    if (mode === "early-error") { emit({ error: { code: "6004", message: "private-detail" } }); res.end(); return; }
    // A non-content SSE event must release the original first-event timer.
    if (mode === "slow-after-event") emit({ choices: [{ delta: { role: "assistant" } }] });
    const finish = () => {
      emit({ model: "private-model-name", choices: [{ delta: { content: "你好", reasoning_content: "reason" } }] });
      if (mode === "hold") { res.once("close", () => { closed++; }); return; }
      if (mode === "late-error") { emit({ error: { code: 6004, message: "private-detail" } }); res.end(); return; }
      emit({ choices: [{ delta: { tool_calls: [{ index: 0, id: "one", type: "function", function: { name: "lookup", arguments: "{}" } }] }, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 } });
      res.end("data: [DONE]\n\n");
    };
    if (mode === "slow-after-event") {
      const timer = setTimeout(() => { timers.delete(timer); finish(); }, 700); timers.add(timer);
    } else finish();
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const config = { userapiBase: `http://127.0.0.1:${upstream.address().port}`, firstByteBaseMs: 250, firstByteMaxMs: 250 };
  fs.writeFileSync(path.join(directory, "settings.json"), JSON.stringify({ autoclaw: config, autoclaw_intl: config }));
  const child = spawn(process.execPath, [path.resolve(__dirname, "../src/main.cjs")], { cwd: path.resolve(__dirname, ".."), windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", AGENTHUB_PLUGIN_DATA_DIR: directory }, stdio: ["pipe", "pipe", "pipe"] });
  const exited = new Promise(resolve => child.once("exit", resolve));
  let diagnostics = "";
  child.stderr.on("data", chunk => { diagnostics = (diagnostics + chunk).slice(-4096); });
  const peer = new RpcPeer({ input: child.stdout, output: child.stdin, prefix: "h:", remotePrefix: "p:" });
  const grants = new Map(), tickets = new Map(), facts = [];
  peer.handle("pool.ensureForwardCredentials", ({ grantId, reason }) => {
    assert.ok(grants.has(grantId)); assert.equal(reason, "preflight"); preflights++; return { token: "effective-cache-token" };
  });
  peer.handle("pool.readForwardCredentials", ({ grantId }) => { assert.ok(grants.has(grantId)); return { token: "effective-cache-token" }; });
  peer.handle("pool.readForwardContext", ({ grantId }) => { assert.ok(grants.has(grantId)); return { models: entries }; });
  peer.handle("execution.reserveAttempt", ({ invocationId, grantId, reason }) => {
    assert.ok(grants.has(grantId)); assert.equal(invocationId, grantId); assert.equal(reason, "initial"); assert.ok(!tickets.has(grantId));
    const ticket = { attemptId: `ticket-${grantId}`, number: 1, remaining: 0 }; tickets.set(grantId, ticket); return ticket;
  });
  const check = params => { assert.ok(grants.has(params.grantId)); assert.equal(params.invocationId, params.grantId); assert.equal(params.attemptId, tickets.get(params.grantId)?.attemptId); };
  peer.handle("execution.startAttempt", params => { check(params); return { started: true }; });
  peer.handle("execution.completeAttempt", params => { check(params); return { completed: true }; });
  peer.handle("execution.reportFacts", params => { check(params); validateExecutionFacts(params.facts); facts.push(params.facts); return { recorded: true }; });
  const closeNetwork = require("./network-fixture.cjs").installNetwork(peer, `http://127.0.0.1:${upstream.address().port}`);
  const session = new ProviderSession({ peer, identity: { pluginId: "suite", publisherId: "publisher", generation: 1 },
    declarations: require("../manifest.json").contributes.providers, onRevoke: id => { closeNetwork(id); grants.delete(id); tickets.delete(id); } });
  let counter = 0;
  function invoke(channel = "autoclaw", onEvent = () => {}, extra = {}) {
    const id = `autoclaw-${++counter}`; grants.set(id, channel);
    return session.invoke({ invocationId: id, providerId: channel, channel, model: "Catalog Display", grantId: id, input,
      deadlineAt: Date.now() + 5000, attemptBudget: true, onEvent, ...extra });
  }
  try {
    await session.initialize();
    assert.ok(session.supports("request-headers@1"));
    await new Promise(resolve => setTimeout(resolve, 25));
    const initialCatalogCalls = catalogCalls;
    for (const channel of ["autoclaw", "autoclaw_intl"]) {
      grants.set("catalog", channel); const count = preflights, catalogsBeforeRead = catalogCalls;
      assert.deepEqual(await session.listModels({ providerId: channel, channel, grantId: "catalog", force: false }), [{ id: "catalog-only", name: "Catalog Display" }]);
      assert.equal(catalogCalls, catalogsBeforeRead, "ordinary catalog reads do not contact upstream");
      const refreshedCatalog = await session.listModels({ providerId: channel, channel, grantId: "catalog", invocationId: "catalog", force: true });
      assert.equal(catalogCalls, initialCatalogCalls + (channel === "autoclaw" ? 1 : 2), "force refresh fetches the live catalog");
      assert.equal(refreshedCatalog[0].id, "catalog-only");
      assert.equal(refreshedCatalog[0].routeId, "zaicoding_catalog-only");
      assert.equal(refreshedCatalog[0].contextLength, 65536);
      assert.equal(refreshedCatalog[0].maxOutputTokens, 8192);
      assert.equal(refreshedCatalog[0].capabilities.images, true);
      assert.equal(received.headers["x-auth-appid"], "100003");
      assert.match(received.headers["x-auth-sign"], /^[0-9a-f]{32}$/);
      grants.delete("catalog"); assert.equal(preflights, count, "directory has no refresh side effect");
      const events = [];
      await invoke(channel, event => { events.push(event); }, { requestHeaders: { "x-autoclaw-session-id": "session-one", "x-autoclaw-agent-id": "agent-one", "x-autoclaw-zcode-invocation-id": "inv-one" } });
      assert.equal(received.url, "/autoclaw-proxy/proxy/autoclaw/chat/completions");
      assert.equal(received.headers["x-authorization"], "Bearer effective-cache-token");
      assert.equal(received.headers["x-request-model"], "zaicoding_catalog-only", "execution uses the same refreshed route returned by catalog force");
      assert.equal(received.body.model, "catalog-only");
      assert.equal(received.headers["x-version"], defaults[channel].llmVersion);
      assert.equal(received.headers["x-tm"], process.platform === "darwin" ? "mac" : "win");
      for (const name of ["authorization", "x-harness-type", "x-auth-sign", "cookie"]) assert.equal(name in received.headers, false);
      assert.equal(received.headers["x-session-id"], "session-one");
      assert.equal(received.headers["x-agent-id"], "agent-one");
      assert.equal(received.headers["x-zcode-invocation-id"], "inv-one");
      assert.equal(received.body.max_tokens, 10000);
      assert.deepEqual(facts.slice(-2), [{ state: "planned", actualModel: "catalog-only" }, { state: "responded", actualModel: "catalog-only" }]);
      assert.equal(events[0].delta.content, "你好"); assert.equal(events[0].delta.reasoning_content, "reason");
      assert.equal(events[1].delta.tool_calls[0].function.name, "lookup");
      assert.equal(events.at(-2).usage.total_tokens, 7);
      assert.equal(events.filter(event => event.type === "finish").length, 1); assert.equal(events.at(-1).reason, "tool_calls");
      assert.doesNotMatch(JSON.stringify(events), /private-model-name/);
    }
    await invoke(); assert.equal("x-session-id" in received.headers, false, "missing granted headers stay absent");
    mode = "slow-after-event"; const events = []; const started = Date.now();
    await invoke("autoclaw", event => { events.push(event); });
    assert.ok(Date.now() - started >= 650); assert.equal(events.at(-1).type, "finish", "first SSE event clears timer even before content");
    for (const [scenario, category, scope, replay] of [["401", "auth", "account", "safe"], ["402", "quota", "account", "safe"],
      ["429", "rate", "account", "safe"], ["413", "model", "invocation", "safe"], ["406", "upstream", "account", "safe"],
      ["early-error", "rate", "account-model", "safe"], ["late-error", "rate", "account-model", "unsafe"],
      ["empty", "network", "service", "unknown"], ["large", "network", "service", "unknown"], ["headers-only", "network", "invocation", "unknown"]]) {
      mode = scenario; const sendsBefore = sent;
      await assert.rejects(invoke(), error => {
        assert.equal(error.category, category, scenario); assert.equal(error.scope, scope, scenario); assert.equal(error.replay, replay, scenario);
        assert.doesNotMatch(error.message, /private-detail|xxxx/);
        if (scenario === "406") assert.match(error.message, /406/);
        return true;
      });
      assert.equal(sent, sendsBefore + 1, "one reserved attempt, no silent internal retry"); assert.equal(grants.size, 0);
    }
    mode = "hold"; const controller = new AbortController();
    await assert.rejects(invoke("autoclaw", event => { if (event.type === "delta") controller.abort(new Error("cancel-autoclaw")); }, { signal: controller.signal }), /cancel-autoclaw/);
    const until = Date.now() + 2500;
    while (closed < 2 && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(closed, 2, "first-event timeout and cancellation close real upstream sockets");
    assert.equal(preflights, counter); assert.equal(grants.size, 0); assert.deepEqual(input, before); assert.equal(diagnostics, "");
    console.log("PASS standalone AutoClaw: both regions, original catalog routes/prompt/token floor, effective preflight, client session headers, child/HTTP/facts, tools/reasoning/usage, first SSE timer, typed errors, cancellation");
  } finally {
    session.close(); child.kill(); await exited;
    for (const timer of timers) clearTimeout(timer);
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(directory, { recursive: true, force: true }));
