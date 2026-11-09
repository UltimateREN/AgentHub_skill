"use strict";
// Actual standalone suite process, local HTTP and synthetic grant callbacks.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { RpcPeer } = require("../sdk/rpc.cjs");
const { ProviderSession } = require("../sdk/provider-session.cjs");
const { validateExecutionFacts } = require("../sdk/provider-protocol.cjs");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ah-catpaw-"));
const models = [{ id: "remote-model", name: "Remote Model", modelType: 177 }];
const user = [{ role: "user", content: "你好" }];
const scopeA = "a".repeat(64), scopeB = "b".repeat(64);
async function main() {
  let cancelledStreams = 0;
  let mode = "ok", hold, uid = "paired-uid", accountId = "account", busy = false, accountExecutionEpoch = "1".repeat(32);
  const requests = [], facts = [];
  const upstream = http.createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push({ url: req.url, headers: req.headers, body });
    res.setHeader("content-type", req.url.endsWith("/turn") ? "text/event-stream" : "application/json");
    if (!req.url.endsWith("/turn")) {
      if (busy && req.url.endsWith("/round")) { busy = false; res.end(JSON.stringify({ code: 1, message: "会话正在执行中" })); return; }
      if (req.url.endsWith("/model-types")) {
        res.end(JSON.stringify({ code: 0, data: [
          { modelTypeName: "remote-model", modelTypeId: 177, supportImage: true,
            extendedInfo: { modelCaptionZhCN: "远程模型", rateMultiplier: "0.25" },
            parameterDefinitions: [{ id: "context", values: [{ value: "200000" }, { value: "1000000" }] }] },
          { modelTypeName: "user-model", modelTypeId: 200, provider: "user_custom" },
          { modelTypeName: "unknown-model", modelTypeId: 0 },
        ] })); return;
      }
      res.end(JSON.stringify({ code: 0, data: {} })); return;
    }
    const write = (text, finished, tool = false) => res.write("data: " + JSON.stringify({ code: 0, data: {
      conversationId: body.conversationId, message: { type: "assistant", messageId: "m",
        content: [{ type: "text", text, reasoningContent: "思考" }, ...(tool ? [{ type: "tool_use", toolCallId: "call-one", toolName: "lookup", toolParams: "{}" }] : [])], finished }
    } }) + "\n");
    if (mode === "tools") { write("", true, true); res.end(); return; }
    if (mode === "large") { write("中文😀".repeat(3000), true); res.end(); return; }
    if (mode === "empty") { res.end(); return; }
    write("你", false);
    if (mode === "hold") { res.once("close", () => { cancelledStreams++; }); hold = () => { write("你好", true); res.end(); }; return; }
    if (mode === "utf8") {
      const wire = Buffer.from("data: " + JSON.stringify({ code: 0, data: { conversationId: body.conversationId,
        message: { type: "assistant", content: [{ type: "text", text: "你好", reasoningContent: "思考" }], finished: true } } }) + "\n");
      const at = wire.indexOf(Buffer.from("好")) + 1;
      res.write(wire.subarray(0, at)); res.end(wire.subarray(at)); return;
    }
    write("你好", true);
    if (mode === "late-error") { res.end("data: " + JSON.stringify({ code: 0, data: { error: { code: 77, message: "private-secret" } } }) + "\n"); return; }
    // finished=true must not prevent reading this trailing usage-only frame.
    res.end("data: " + JSON.stringify({ code: 0, data: { conversationId: body.conversationId, usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 10 } } }) + "\n");
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ catpaw: { baseUrl: "http://127.0.0.1:" + upstream.address().port, stopTimeoutMs: 200, sseTimeoutMs: 5000 } }));
  const child = spawn(process.execPath, [path.resolve(__dirname, "../src/main.cjs")], {
    cwd: path.resolve(__dirname, ".."), windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", AGENTHUB_PLUGIN_DATA_DIR: dir }
  });
  const exited = new Promise(resolve => child.once("exit", resolve));
  let diagnostics = ""; child.stderr.on("data", chunk => { diagnostics += chunk; });
  const peer = new RpcPeer({ input: child.stdout, output: child.stdin, prefix: "h:", remotePrefix: "p:" });
  const grants = new Map(), tickets = new Map();
  peer.handle("pool.readForwardCredentials", ({ grantId }) => { assert.ok(grants.has(grantId)); return { token: "paired-token", uid: grants.get(grantId).uid }; });
  peer.handle("pool.readForwardContext", ({ grantId }) => { assert.ok(grants.has(grantId)); return { models, accountId: grants.get(grantId).accountId, accountExecutionEpoch: grants.get(grantId).accountExecutionEpoch }; });
  peer.handle("pool.ensureForwardCredentials", () => { throw new Error("CatPaw must not introduce refresh"); });
  peer.handle("execution.reserveAttempt", ({ invocationId, grantId, reason }) => {
    assert.ok(grants.has(grantId)); assert.equal(invocationId, grantId); assert.equal(reason, "initial");
    assert.ok(!tickets.has(grantId));
    const ticket = { attemptId: "ticket-" + grantId, number: 1, remaining: 0 }; tickets.set(grantId, ticket); return ticket;
  });
  const check = params => { assert.ok(grants.has(params.grantId)); assert.equal(params.attemptId, tickets.get(params.grantId)?.attemptId); };
  peer.handle("execution.startAttempt", p => { check(p); return { started: true }; });
  peer.handle("execution.completeAttempt", p => { check(p); return { completed: true }; });
  peer.handle("execution.reportFacts", p => { check(p); validateExecutionFacts(p.facts); facts.push(p.facts); return { recorded: true }; });
  const closeNetwork = require("./network-fixture.cjs").installNetwork(peer, `http://127.0.0.1:${upstream.address().port}`);
  const session = new ProviderSession({ peer, eventBytes: 1024, windowBytes: 2048, identity: { pluginId: "suite", publisherId: "publisher", generation: 1 },
    declarations: require("../manifest.json").contributes.providers, onRevoke: id => { closeNetwork(id); grants.delete(id); tickets.delete(id); } });
  let count = 0;
  function invoke(input = {}, options = {}) {
    const id = "catpaw-" + ++count; grants.set(id, { uid, accountId, accountExecutionEpoch });
    return session.invoke({ invocationId: id, providerId: "catpaw", channel: "catpaw", model: "remote-model", grantId: id,
      input: { messages: user, stream: true, ...input }, stateScope: scopeA, requestHeaders: { "x-session-id": "session-one" },
      deadlineAt: Date.now() + 7000, attemptBudget: true, onEvent: () => {}, ...options });
  }
  const tools = [{ type: "function", function: { name: "lookup", description: "lookup", parameters: { type: "object" } } }];
  const continued = { tools, messages: [...user, { role: "assistant", content: null,
    tool_calls: [{ id: "call-one", type: "function", function: { name: "lookup", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call-one", content: "result" }] };
  try {
    await session.initialize();
    assert.ok(session.supports("state-scope@1"));
    grants.set("catalog", { uid, accountId, accountExecutionEpoch });
    assert.deepEqual(await session.listModels({ providerId: "catpaw", channel: "catpaw", grantId: "catalog", invocationId: "catalog" }), [{ id: "remote-model", name: "Remote Model" }]);
    const refreshed = await session.listModels({ providerId: "catpaw", channel: "catpaw", grantId: "catalog", invocationId: "catalog", force: true });
    assert.equal(refreshed.length, 1, "user-defined and non-executable models are excluded");
    assert.deepEqual({ id: refreshed[0].id, name: refreshed[0].name, modelType: refreshed[0].modelType,
      rate: refreshed[0].rate, contextLength: refreshed[0].contextLength, images: refreshed[0].capabilities.images },
    { id: "remote-model", name: "远程模型", modelType: 177, rate: 0.25, contextLength: 1000000, images: true });
    assert.equal(requests[0].url, "/api/agent/maas/model-types");
    assert.deepEqual(requests[0].body, { tenant: "CatDesk", scene: "CATX_APP", env: "EXTERNAL" });
    assert.equal(requests[0].headers.cookie, "X-Passport-Token=paired-token");
    requests.length = 0;
    grants.delete("catalog"); assert.equal(requests.length, 0, "ordinary catalog reads only use existing facts");
    const events = [];
    await invoke({}, { onEvent: e => { events.push(e); } });
    assert.deepEqual(requests.map(r => r.url), ["/api/agent/conversation/round", "/api/agent/conversation/event", "/api/agent/conversation/turn", "/api/agent/conversation/event"]);
    assert.equal(requests[0].body.modelType, 177);
    assert.equal(requests[0].headers.cookie, "X-Passport-Token=paired-token");
    assert.equal(requests[0].headers["user-uid"], uid);
    assert.equal(requests.at(-1).body.data.status, "completed");
    assert.equal(events.filter(e => e.type === "delta").map(e => e.delta.content || "").join(""), "你好");
    assert.deepEqual(events.find(e => e.type === "usage").usage, { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 });
    assert.equal(events.filter(e => e.type === "finish").length, 1);
    assert.deepEqual(facts.slice(-2), [{ state: "planned", actualModel: "177" }, { state: "responded", actualModel: "177" }]);
    const firstId = requests[0].body.conversationId;
    const history = [...user, { role: "assistant", content: "你好", reasoning_content: "思考" }, { role: "user", content: "下一条" }];
    let start = requests.length;
    await invoke({ messages: history });
    assert.equal(requests[start].body.conversationId, firstId, "long conversation reused");
    assert.equal(requests[start].body.messages.length, 1, "only incremental user submitted");
    start = requests.length; await invoke({}, { stateScope: scopeB });
    assert.notEqual(requests[start].body.conversationId, firstId, "different authenticated scope isolated");
    // Stream a cumulative response much larger than the negotiated event/window,
    // with a slow consumer; every wire delta must remain within those limits.
    mode = "large"; start = requests.length;
    const largeEvents = [];
    await invoke({}, { requestHeaders: { "x-session-id": "large" }, onEvent: async e => {
      largeEvents.push(e); if (e.type === "delta") await new Promise(resolve => setTimeout(resolve, 1));
    } });
    assert.equal(largeEvents.filter(e => e.type === "delta").map(e => e.delta.content || "").join(""), "中文😀".repeat(3000));
    assert.equal(largeEvents.at(-1).type, "finish");
    mode = "tools"; start = requests.length;
    await invoke({ tools }, { requestHeaders: { "x-session-id": "tools" } });
    assert.equal(requests.length, start + 3, "tool return does not complete upstream round");
    const toolId = requests[start].body.conversationId;
    start = requests.length;
    await assert.rejects(invoke(continued, { stateScope: scopeB, requestHeaders: { "x-session-id": "tools" } }), error => error.status === 409);
    assert.equal(requests.length, start, "foreign scope cannot replay private tool state");
    accountId = "different-account";
    await assert.rejects(invoke(continued, { requestHeaders: { "x-session-id": "tools" } }), error => error.status === 409);
    accountId = "account"; assert.equal(requests.length, start);
    mode = "hold"; hold = null;
    const running = invoke(continued, { requestHeaders: { "x-session-id": "tools" } });
    const until = Date.now() + 3000;
    while (!hold && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(hold);
    start = requests.length;
    await assert.rejects(invoke(continued, { requestHeaders: { "x-session-id": "tools" } }), error => error.status === 409 && error.retryable === false);
    assert.equal(requests.length, start, "concurrent continuation has no private side effect");
    hold(); await running;
    assert.equal(requests.at(-2).body.conversationId, toolId);
    assert.equal(requests.at(-2).url, "/api/agent/conversation/turn");
    mode = "ok"; start = requests.length;
    await assert.rejects(invoke(continued, { requestHeaders: { "x-session-id": "tools" } }), error => error.status === 409);
    assert.equal(requests.length, start, "already consumed tools cannot create a new task");
    mode = "tools";
    await invoke({ tools }, { requestHeaders: { "x-session-id": "epoch-test" } });
    accountExecutionEpoch = "2".repeat(32); start = requests.length;
    await assert.rejects(invoke(continued, { requestHeaders: { "x-session-id": "epoch-test" } }), error => error.status === 409);
    assert.equal(requests.length, start, "a new execution epoch cannot continue an idle old tool task");
    mode = "ok";
    await invoke({}, { requestHeaders: { "x-session-id": "epoch-test" } });
    mode = "tools";
    await invoke({ tools, stream: false }, { requestHeaders: {} });
    mode = "ok"; start = requests.length;
    await invoke({ ...continued, stream: false }, { requestHeaders: {} });
    assert.deepEqual(requests.slice(start).map(r => r.url), ["/api/agent/conversation/turn", "/api/agent/conversation/event"], "anonymous continuation skips round/running");
    await assert.rejects(invoke({ ...continued, stream: false }, { requestHeaders: {} }), error => error.status === 409);
    mode = "tools";
    await invoke({ tools }, { requestHeaders: { "x-session-id": "uid-test" } });
    uid = "replacement-uid"; start = requests.length;
    await assert.rejects(invoke(continued, { requestHeaders: { "x-session-id": "uid-test" } }), error => error.status === 409);
    assert.equal(requests.length, start, "different effective uid cannot continue old task"); uid = "paired-uid";
    mode = "ok";
    await invoke({}, { requestHeaders: { "x-session-id": "busy" } });
    start = requests.length; busy = true;
    await invoke({ messages: history }, { requestHeaders: { "x-session-id": "busy" } });
    const rounds = requests.slice(start).filter(r => r.url.endsWith("/round"));
    assert.equal(rounds.length, 2); assert.notEqual(rounds[0].body.conversationId, rounds[1].body.conversationId);
    assert.equal(rounds[0].body.messages.length, 1); assert.equal(rounds[1].body.messages.length, 3, "explicit busy rejection heals once with complete history");
    mode = "hold"; hold = null; start = requests.length;
    const held = invoke({}, { requestHeaders: { "x-session-id": "parallel" } });
    const waitUntil = Date.now() + 3000;
    while (!hold && Date.now() < waitUntil) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(hold); const activeConversation = requests[start].body.conversationId;
    mode = "ok"; start = requests.length;
    await invoke({}, { requestHeaders: { "x-session-id": "parallel" } });
    assert.notEqual(requests[start].body.conversationId, activeConversation, "parallel same session runs independently");
    hold(); await held; start = requests.length;
    await invoke({ messages: history }, { requestHeaders: { "x-session-id": "parallel" } });
    assert.equal(requests[start].body.conversationId, activeConversation, "parallel request did not replace long session");
    mode = "utf8";
    const utf8 = [];
    await invoke({}, { requestHeaders: { "x-session-id": "utf8" }, onEvent: e => utf8.push(e) });
    assert.equal(utf8.filter(e => e.type === "delta").map(e => e.delta.content || "").join(""), "你好");
    for (const scenario of ["late-error", "empty"]) {
      mode = scenario;
      await assert.rejects(invoke({}, { requestHeaders: { "x-session-id": scenario } }), error => {
        assert.equal(error.replay, "unsafe"); assert.equal(error.retryable, false); assert.doesNotMatch(error.message, /private-secret/); return true;
      });
      assert.equal(requests.at(-1).body.data.status, "failed");
    }
    // 刷新后的目录只保留 routing，执行仍要拿到数字 modelType。
    mode = "ok";
    models.splice(0, models.length, { id: "remote-model", name: "Remote Model", routing: { modelType: 177 } });
    start = requests.length;
    await invoke({}, { requestHeaders: { "x-session-id": "live-routing" } });
    assert.equal(requests[start].body.modelType, 177, "live routing carries the numeric model type");
    cancelledStreams = 0; mode = "hold";
    const controller = new AbortController();
    await assert.rejects(invoke({}, { signal: controller.signal, requestHeaders: { "x-session-id": "cancel" },
      onEvent: e => { if (e.type === "delta") controller.abort(new Error("cancel-catpaw")); } }), /cancel-catpaw/);
    const cleaned = Date.now() + 2500;
    while (!cancelledStreams && Date.now() < cleaned) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(cancelledStreams > 0, "revoking the host grant aborts the active upstream stream; remote stop is best effort");
    assert.equal(grants.size, 0); assert.equal(diagnostics, "");
    console.log("PASS standalone CatPaw: numeric catalog, original paired credentials, round/running/turn/completed, incremental history, scope isolation, tool continuation/claim/consumption, trailing usage, errors and cancellation");
  } finally {
    session.close(); child.kill(); await exited;
    upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
