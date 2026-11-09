"use strict";
// Self-contained plugin integration: real provider + SDK + HTTP, with a bounded
// host-control responder. The core's formal gateway suite tests the real ledger.
const assert = require("node:assert/strict");
const http = require("node:http");
const { PassThrough } = require("node:stream");
const { RpcPeer } = require("../sdk/rpc.cjs");
const { ProviderSession } = require("../sdk/provider-session.cjs");
const { ProviderRuntime } = require("../sdk/runtime/provider.cjs");
const { createLoomy } = require("../src/providers/loomy/provider.cjs");
const degrade = require("../src/execution/degrade.cjs");
const trace = [], sends = [];
let mode = "retry", limit = 2, reservations = 0, terminalReplay, activeId;
const upstream = http.createServer(async (req, res) => {
  let raw = ""; for await (const chunk of req) raw += chunk;
  sends.push({ headers: req.headers, body: JSON.parse(raw) }); trace.push("http");
  if (mode === "empty") { res.writeHead(200, { "content-type": "text/event-stream" }); res.end("data: [DONE]\n\n"); return; }
  if (mode === "large") { res.writeHead(403); res.end("x".repeat(65537)); return; }
  if (sends.length === 1) {
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "CONTENT_POLICY", message: "content_policy_violation: private-sensitive-detail" } }));
    return;
  }
  if (mode === "disconnect") { req.socket.destroy(); return; }
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end('data: {"choices":[{"delta":{"content":"RECOVERED"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
});
async function main() {
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const toHost = new PassThrough(), toPlugin = new PassThrough();
  const host = new RpcPeer({ input: toHost, output: toPlugin, prefix: "h:", remotePrefix: "p:" });
  const plugin = new RpcPeer({ input: toPlugin, output: toHost, prefix: "p:", remotePrefix: "h:" });
  const runtime = new ProviderRuntime({ peer: plugin, providers: [createLoomy({ modelBase: `http://127.0.0.1:${upstream.address().port}` })] });
  host.handle("pool.readForwardCredentials", ({ grantId }) => { assert.equal(grantId, activeId); return { token: "same-original-account" }; });
  for (const method of ["execution.reserveAttempt", "execution.startAttempt", "execution.completeAttempt"]) host.handle(method, params => {
    assert.equal(params.grantId, activeId); assert.equal(params.invocationId, activeId);
    if (method === "execution.reserveAttempt") {
      if (reservations >= limit) throw Object.assign(new Error("budget exhausted"), { code: -32040 });
      trace.push("reserve");
      return { attemptId: `ticket-${++reservations}`, number: reservations, remaining: limit - reservations };
    }
    if (method === "execution.completeAttempt") terminalReplay = params.replay;
    return { completed: true, started: true };
  });
  const closeNetwork = require("./network-fixture.cjs").installNetwork(host, `http://127.0.0.1:${upstream.address().port}`);
  const session = new ProviderSession({ peer: host, onRevoke: id => closeNetwork(id), identity: { pluginId: "suite", publisherId: "publisher", generation: 1 }, declarations: [{ id: "loomy", channels: ["loomy"] }] });
  let counter = 0;
  const input = { messages: [{ role: "system", content: "CUSTOM_SYS: original" }, { role: "user", content: "hello" }] };
  async function invoke({ budget = 2, scenario = "retry", attemptBudget = true } = {}) {
    degrade.clear(); sends.length = trace.length = reservations = 0; terminalReplay = undefined;
    limit = budget; mode = scenario; activeId = `invocation-${++counter}`;
    const events = [];
    const operation = session.invoke({ invocationId: activeId, providerId: "loomy", channel: "loomy", model: "model",
      grantId: activeId, input, attemptBudget, deadlineAt: Date.now() + 3000, onEvent: event => { events.push(event); } });
    return { events, operation };
  }
  try {
    await session.initialize();
    let run = await invoke(); await run.operation;
    assert.equal(sends.length, 2); assert.equal(reservations, 2);
    assert.deepEqual(trace, ["reserve", "http", "reserve", "http"]);
    assert.equal(sends[0].headers.token, sends[1].headers.token);
    assert.equal(sends[0].body.messages[0].content, "CUSTOM_SYS: original");
    assert.equal(sends[1].body.messages[0].content, degrade.NEUTRAL_PROMPT);
    assert.equal(run.events.find(event => event.type === "delta").delta.content, "RECOVERED");
    assert.equal(input.messages[0].content, "CUSTOM_SYS: original");
    run = await invoke({ budget: 1 });
    await assert.rejects(run.operation, error => error.code === "MODEL_ATTEMPT_LIMIT");
    assert.equal(sends.length, 1); assert.equal(reservations, 1);
    run = await invoke({ scenario: "disconnect" });
    await assert.rejects(run.operation, error => error.replay === "unknown" && !error.message.includes("private-sensitive-detail"));
    assert.equal(sends.length, 2); assert.equal(terminalReplay, "unknown");
    run = await invoke({ attemptBudget: false });
    await assert.rejects(run.operation, error => error.code === "CONTENT_REJECTED" && !error.message.includes("private-sensitive-detail"));
    assert.equal(sends.length, 1, "an unbudgeted legacy test invocation cannot remediate");
    run = await invoke({ scenario: "large" });
    await assert.rejects(run.operation, error => error.replay === "unknown");
    assert.equal(sends.length, 1, "oversized private errors are bounded and not replayed");
    run = await invoke({ scenario: "empty" });
    await assert.rejects(run.operation, error => error.replay === "unknown");
    assert.equal(sends.length, 1, "an empty SSE response must not become a successful answer or a safe retry");
    const deadline = Date.now() + 1000;
    while (runtime.active.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(runtime.active.size, 0);
    console.log("PASS Loomy integrated remediation: real provider/SDK/HTTP, reserve-before-send, same-account retry, shared budget refusal, unknown retry preserved, bounded redacted errors, no legacy retry");
  } finally { session.close(); plugin.close(); toHost.destroy(); toPlugin.destroy(); degrade.clear(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
});
