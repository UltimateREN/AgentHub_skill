"use strict";
// Standalone suite process + loopback HTTP. No host checkout, DB or live account.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { RpcPeer } = require("../sdk/rpc.cjs");
const { ProviderSession } = require("../sdk/provider-session.cjs");
const { rewriteBody, parseTryAgainMs } = require("../src/providers/cline/protocol.cjs");
const { parseRecommended, filterByPool } = require("../src/providers/cline/models.cjs");
const { buildUpstreamHeaders } = require("../src/providers/cline/headers.cjs");
const { errorFor, retryAfter, createCline, catalogRows } = require("../src/providers/cline/provider.cjs");
const { validateExecutionFacts } = require("../sdk/provider-protocol.cjs");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ah-cline-plugin-"));
const declarations = require("../manifest.json").contributes.providers;
const entries = {
  cline_free: [{ id: "cline-free/Model-A" }, { id: "vendor/free-model" }],
  cline_pass: [{ id: "cline-pass/Model-A" }, { id: "vendor/pass-model" }],
};

async function main() {
  const body = { messages: [{ role: "user", content: "hello" }], reasoningEffort: "low", max_tokens: 0, extra: "preserve" };
  const before = structuredClone(body);
  for (const [pool, channel] of [["free", "cline_free"], ["pass", "cline_pass"]]) {
    const changed = rewriteBody("model-a", body, entries[channel], pool);
    assert.equal(changed.body.model, `${pool === "free" ? "cline-free" : "cline-pass"}/Model-A`);
    assert.equal(changed.body.reasoning_effort, "low");
    assert.equal(changed.body.extra, "preserve");
    assert.equal("max_tokens" in changed.body, false);
    assert.equal("reasoningEffort" in changed.body, false);
    assert.equal(rewriteBody("unknown", {}, entries[channel], pool).body.model, "unknown");
    assert.equal(rewriteBody("vendor/model", {}, entries[channel], pool).body.model, "vendor/model");
    const other = pool === "free" ? "cline-pass/Model-A" : "cline-free/Model-A";
    assert.equal(rewriteBody(other, {}, entries[channel], pool).body.model, other, "no cross-pool billing rewrite");
    assert.equal(rewriteBody("model-a", { reasoning_effort: "none", reasoningEffort: "high", max_tokens: 12 }, entries[channel], pool).body.reasoning_effort, "none");
    const plain = rewriteBody("model-a", {}, entries[channel], pool).body;
    assert.equal(plain.reasoning_effort, "high");
    assert.equal("max_tokens" in plain, false, "no invented output limit");
  }
  assert.deepEqual(body, before, "fallback input stays immutable");
  const parsed = parseRecommended({ free: [{ id: "vendor/bare" }], clinePass: [{ id: "cline-pass/a" }], recommended: [{ id: "cline-cloud/no" }] });
  assert.deepEqual(filterByPool(parsed, "free").map(item => item.id), ["vendor/bare"], "public group facts never inferred from a vendor prefix");
  const remoteCatalog = { free: [{ id: "vendor/bare-free", name: "Bare Free" }, { id: "cline-cloud/blocked" }],
    clinePass: [{ id: "vendor/bare-pass", name: "Bare Pass" }], recommended: [{ id: "cline-pass/recommended" }] };
  assert.deepEqual(catalogRows(remoteCatalog, "cline_free").map(item => item.id), ["vendor/bare-free"]);
  assert.deepEqual(catalogRows(remoteCatalog, "cline_pass").map(item => item.id), ["vendor/bare-pass", "cline-pass/recommended"]);
  const catalogCalls = [];
  const clineProvider = createCline("cline_free", { apiBase: "https://cline.test/api/v1" });
  const catalogCtx = { pool: { context: async () => ({ models: [{ id: "cached" }] }), network: () => ({
    fetch: async (url, options) => { catalogCalls.push({ url, options }); return new Response(JSON.stringify(remoteCatalog)); },
  }) } };
  assert.deepEqual((await clineProvider.listModels({ grantId: "grant" }, catalogCtx)).map(item => item.id), ["cached"]);
  assert.equal(catalogCalls.length, 0, "ordinary directory reads do not access the network");
  assert.deepEqual((await clineProvider.listModels({ grantId: "grant", force: true }, catalogCtx)).map(item => item.id), ["vendor/bare-free"]);
  assert.equal(catalogCalls[0].url, "https://cline.test/api/v1/ai/cline/recommended-models");
  await assert.rejects(clineProvider.listModels({ grantId: "grant", force: true }, { pool: { context: async () => ({ models: [{ id: "cached" }] }),
    network: () => ({ fetch: async () => new Response(JSON.stringify({ free: [] })) }) } }), error => error.code === "CATALOG_REFRESH_FAILED");
  assert.equal(parseTryAgainMs("Try again in 17h 59m"), (17 * 60 + 59) * 60000);
  assert.equal(parseTryAgainMs("Try again in 1d 2h 30m 4s 5ms"), 95404005);
  assert.equal(retryAfter(new Headers({ "retry-after": "12" })), 12000);
  assert.equal(retryAfter(new Headers({ "retry-after-ms": "120" })), 120);
  assert.equal(retryAfter(new Headers({ "retry-after": "999999" })), 0);
  const headers = buildUpstreamHeaders({ upstreamHeaders: { Authorization: "bad", Accept: "bad", "X-Task-ID": "bad", "X-CLIENT-TYPE": "", Test: "ok" } },
    { authorization: "Bearer original", accept: "text/event-stream", "x-task-id": "dynamic", "x-client-type": "cline-sdk" });
  assert.equal(headers.authorization, "Bearer original"); assert.equal(headers.accept, "text/event-stream");
  assert.equal(headers["x-task-id"], "dynamic"); assert.equal("x-client-type" in headers, false);
  assert.equal(errorFor(403, "not a supported client").scope, "service");
  assert.equal(errorFor(403, '{"error":{"message":"ENTITLEMENT_ERROR"}}').retryable, false);
  assert.equal(errorFor(404, "model not found").scope, "invocation");

  let mode = "ok", received, closed = 0, sent = 0, callbackCount = 0;
  const upstream = http.createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    sent++; received = { url: req.url, headers: req.headers, body: JSON.parse(raw) };
    if (["401", "403", "404", "429", "large"].includes(mode)) {
      res.writeHead(mode === "large" ? 403 : Number(mode), { "retry-after": "120" });
      res.end(mode === "large" ? "x".repeat(65537) : mode === "429" ? "Try again in 17h 59m private-detail" : "private-detail"); return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const emit = chunk => res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    if (mode === "empty") { res.end("data: [DONE]\n\n"); return; }
    emit({ model: "private-internal-name", choices: [{ delta: { content: "你好", reasoning_content: "reason" } }] });
    if (mode === "hold") { res.once("close", () => { closed++; }); return; }
    if (mode === "stream-error") { emit({ error: { code: "PRIVATE", message: "private-detail" } }); res.end(); return; }
    emit({ choices: [{ delta: { tool_calls: [{ index: 0, id: "one", type: "function", function: { name: "lookup", arguments: "{}" } }] }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 } });
    res.end("data: [DONE]\n\n");
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  fs.writeFileSync(path.join(directory, "settings.json"), JSON.stringify({ cline: { apiBase: `http://127.0.0.1:${upstream.address().port}/api/v1`,
    upstreamHeaders: { Authorization: "cannot-override", "X-Task-ID": "cannot-override", "X-Title": "" } } }));
  const child = spawn(process.execPath, [path.resolve(__dirname, "../src/main.cjs")], { cwd: path.resolve(__dirname, ".."), windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", AGENTHUB_PLUGIN_DATA_DIR: directory }, stdio: ["pipe", "pipe", "pipe"] });
  const exited = new Promise(resolve => child.once("exit", resolve));
  let diagnostics = "";
  child.stderr.on("data", bytes => { diagnostics = (diagnostics + bytes).slice(-4096); });
  const peer = new RpcPeer({ input: child.stdout, output: child.stdin, prefix: "h:", remotePrefix: "p:" });
  const grants = new Map();
  peer.handle("pool.ensureForwardCredentials", ({ grantId, reason }) => {
    assert.ok(grants.has(grantId)); assert.equal(reason, "preflight"); callbackCount++;
    return { token: "original-jwt" };
  });
  peer.handle("pool.readForwardContext", ({ grantId }) => {
    const channel = grants.get(grantId); assert.ok(channel); return { models: entries[channel] };
  });
  const tickets = new Map(), reports = [];
  peer.handle("execution.reserveAttempt", ({ grantId, invocationId, reason }) => {
    assert.ok(grants.has(grantId)); assert.equal(invocationId, grantId); assert.equal(reason, "initial"); assert.ok(!tickets.has(grantId));
    const ticket = { attemptId: `ticket-${grantId}`, number: 1, remaining: 0 }; tickets.set(grantId, ticket); return ticket;
  });
  const checkTicket = params => {
    assert.ok(grants.has(params.grantId)); assert.equal(params.invocationId, params.grantId);
    assert.equal(params.attemptId, tickets.get(params.grantId)?.attemptId);
  };
  peer.handle("execution.startAttempt", params => { checkTicket(params); return { started: true }; });
  peer.handle("execution.completeAttempt", params => { checkTicket(params); return { completed: true }; });
  peer.handle("execution.reportFacts", params => {
    checkTicket(params); validateExecutionFacts(params.facts); reports.push({ invocationId: params.invocationId, ...params.facts }); return { recorded: true };
  });
  const closeNetwork = require("./network-fixture.cjs").installNetwork(peer, `http://127.0.0.1:${upstream.address().port}`);
  const session = new ProviderSession({ peer, identity: { pluginId: "suite", publisherId: "publisher", generation: 1 }, declarations,
    onRevoke: id => { closeNetwork(id); grants.delete(id); tickets.delete(id); } });
  let counter = 0;
  function invoke(channel = "cline_free", onEvent = () => {}, extra = {}) {
    const id = `cline-${++counter}`; grants.set(id, channel);
    return session.invoke({ invocationId: id, providerId: channel, channel, model: "model-a", grantId: id, input: body,
      deadlineAt: Date.now() + 5000, attemptBudget: true, onEvent, ...extra });
  }
  try {
    await session.initialize();
    assert.ok(session.supports("explicit-retry-policy@1"));
    assert.ok(session.supports("execution-facts@1"));
    for (const channel of ["cline_free", "cline_pass"]) {
      grants.set("directory", channel);
      assert.deepEqual(await session.listModels({ providerId: channel, channel, grantId: "directory" }), entries[channel]);
      grants.delete("directory");
      const events = []; await invoke(channel, event => { events.push(event); });
      assert.equal(received.url, "/api/v1/chat/completions");
      assert.equal(received.headers.authorization, "Bearer workos:original-jwt");
      assert.equal(received.headers["x-client-type"], "cline-sdk");
      assert.equal("x-title" in received.headers, false);
      assert.equal(received.headers["x-task-id"], received.body.session_id);
      assert.equal(received.body.model, entries[channel][0].id);
      assert.deepEqual(reports.slice(-2).map(({ invocationId, ...facts }) => facts), [
        { state: "planned", actualModel: received.body.model }, { state: "responded", actualModel: received.body.model },
      ]);
      assert.equal(received.body.reasoning_effort, "low");
      assert.equal(received.body.extra, "preserve");
      assert.equal("max_tokens" in received.body, false);
      assert.equal(events[0].delta.content, "你好");
      assert.equal(events[1].delta.tool_calls[0].function.name, "lookup");
      assert.equal(events.at(-2).usage.total_tokens, 7);
      assert.equal(events.at(-1).reason, "tool_calls");
      assert.equal(events.filter(event => event.type === "finish").length, 1);
      assert.doesNotMatch(JSON.stringify(events), /private-internal-name/);
    }
    for (const [scenario, category, scope, retryable] of [["401", "auth", "account", true], ["403", "model", "invocation", false],
      ["404", "model", "invocation", false], ["429", "rate", "account", true], ["stream-error", "upstream", "invocation", false]]) {
      mode = scenario; const sendsBefore = sent;
      await assert.rejects(invoke(), error => {
        assert.equal(error.category, category); assert.equal(error.scope, scope); assert.equal(error.retryable, retryable);
        assert.doesNotMatch(error.message, /private-detail/);
        if (scenario === "429") assert.equal(error.retryAfterMs, (17 * 60 + 59) * 60000);
        if (scenario === "stream-error") assert.equal(error.replay, "unsafe");
        return true;
      });
      assert.equal(sent, sendsBefore + 1, "provider does not retry deterministic errors or spend a second unreserved attempt");
      assert.equal(grants.size, 0);
    }
    mode = "empty"; await assert.rejects(invoke(), error => error.replay === "unknown");
    mode = "large"; await assert.rejects(invoke(), error => error.replay === "unknown" && !error.message.includes("xxx"));
    mode = "hold";
    const controller = new AbortController();
    await assert.rejects(invoke("cline_free", event => { if (event.type === "delta") controller.abort(new Error("cancel-cline")); }, { signal: controller.signal }), /cancel-cline/);
    const until = Date.now() + 2500;
    while (!closed && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(closed, 1, "cancel aborts real upstream HTTP");
    assert.equal(grants.size, 0);
    assert.equal(callbackCount, counter, "exactly one original preflight per invocation");
    assert.deepEqual(body, before);
    assert.equal(diagnostics, "");
    console.log("PASS standalone Cline suite: both pools, original model/body/header semantics, scoped preflight, real child/HTTP, tools/reasoning/usage, 403/404 no-retry policy, rate reset, redaction, bounded errors and cancellation");
  } finally {
    session.close(); child.kill(); await exited;
    await new Promise(resolve => upstream.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(directory, { recursive: true, force: true }));
