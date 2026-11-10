"use strict";
// AtomCode：UA 常量 / 账号前缀剥离 / stream_options / 假成功与配额文案判定
const assert = require("node:assert/strict");
const { ReadableStream } = require("node:stream/web");
const { createAtomCode, stripAccountPrefix, rewriteBody, classify, ADAPTER_USER_AGENT } = require("../src/providers/atomcode/provider.cjs");

function sseResponse(frames, status = 200, type = "text/event-stream") {
  const text = frames.map((frame) => (typeof frame === "string" ? frame : `data: ${JSON.stringify(frame)}\n\n`)).join("");
  return {
    ok: status >= 200 && status < 300, status,
    headers: new Headers({ "content-type": type }),
    body: new ReadableStream({ start(controller) { controller.enqueue(Buffer.from(text)); controller.close(); } }),
    async text() { return text; },
  };
}
function ctx({ upstream, models = [] } = {}) {
  const calls = [];
  return { calls, signal: new AbortController().signal,
    pool: {
      credentials: async () => ({ token: "atom-token" }),
      context: async () => ({ accountId: "a", uid: "u", models }),
      network: () => ({ fetch: async (url, init) => { calls.push({ url, init }); return upstream; } }),
    },
    attempts: { report: async () => {} } };
}
async function collect(provider, request, context) {
  const events = [];
  for await (const event of provider.invoke(request, context)) events.push(event);
  return events;
}

async function main() {
  // ===== UA 是功能性常量 =====
  assert.ok(!/^atomcode\//i.test(ADAPTER_USER_AGENT), "must never claim to be the official client");
  assert.match(ADAPTER_USER_AGENT, /^agenthub-atomcode\//);

  // ===== 账号前缀剥离 =====
  assert.equal(stripAccountPrefix("acc-1/glm5.3-flash"), "glm5.3-flash");
  assert.equal(stripAccountPrefix("glm5.3-flash"), "glm5.3-flash");
  assert.equal(stripAccountPrefix("/leading"), "/leading", "empty first segment is not an account prefix");

  // ===== stream_options 补全 / 非流式删除 =====
  const streamed = rewriteBody({ stream: true, model: "acc/glm5.3-flash" }, "acc/glm5.3-flash");
  assert.equal(streamed.model, "glm5.3-flash");
  assert.deepEqual(streamed.stream_options, { include_usage: true });
  const kept = rewriteBody({ stream: true, stream_options: { include_usage: false } }, "m");
  assert.deepEqual(kept.stream_options, { include_usage: false }, "an explicit client value wins");
  const nonStream = rewriteBody({ stream: false, stream_options: { include_usage: true } }, "m");
  assert.equal("stream_options" in nonStream, false);

  // ===== 错误分类（假成功 + 配额）=====
  assert.equal(classify(200, "参数错误").code, "MODEL_NOT_ACCEPTED", "HTTP 200 + 参数错误 is a fake success");
  assert.equal(classify(200, "<!DOCTYPE html><html>boom</html>").code, "UPSTREAM_HTML_ERROR");
  assert.equal(classify(200, "在当前 CodingPlan 用量窗口内已达上限").code, "QUOTA_EXHAUSTED");
  assert.equal(classify(403, '{"detail":{"code":"ATOMCODE_SIG_MISSING"}}').code, "SIGNATURE_REQUIRED");
  assert.equal(classify(401, "").status, 401);

  // ===== 转发 =====
  const provider = createAtomCode({});
  const context = ctx({ upstream: sseResponse([
    { choices: [{ delta: { content: "ok" } }] },
    { choices: [{ delta: { content: "!" }, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } },
    "[DONE]",
  ]), models: [{ id: "glm5.3-flash", name: "GLM-5.3-Flash" }] });
  const events = await collect(provider, { model: "glm5.3-flash", input: { messages: [{ role: "user", content: "hi" }], stream: true } }, context);
  assert.equal(context.calls[0].url, "https://api-ai.gitcode.com/v1/chat/completions", "must use the first-party gateway, never llm-api.atomgit.com");
  assert.equal(context.calls[0].init.headers["user-agent"], ADAPTER_USER_AGENT);
  assert.equal(context.calls[0].init.headers.authorization, "Bearer atom-token");
  const posted = JSON.parse(context.calls[0].init.body);
  assert.equal(posted.model, "glm5.3-flash");
  assert.deepEqual(posted.stream_options, { include_usage: true });
  assert.deepEqual(events.filter((event) => event.type === "delta").map((event) => event.delta.content), ["ok", "!"]);
  assert.deepEqual(events.at(-1), { type: "finish", reason: "stop" });

  // 假成功：200 + text/plain「参数错误」→ 明确报错
  const fake = ctx({ upstream: { ok: true, status: 200, headers: new Headers({ "content-type": "text/plain" }),
    async text() { return "参数错误"; } } });
  await assert.rejects(collect(provider, { model: "m", input: { messages: [] } }, fake), (error) => error.code === "MODEL_NOT_ACCEPTED");

  // 配额文案 → 罚账号
  const quota = ctx({ upstream: sseResponse([{ choices: [{ delta: { content: "" }, finish_reason: "stop" }] }], 200) });
  quota.pool.network = () => ({ fetch: async () => {
    const text = "在当前 CodingPlan 用量窗口内已达上限";
    return { ok: false, status: 429, headers: new Headers({ "content-type": "text/plain" }),
      body: new ReadableStream({ start(controller) { controller.enqueue(Buffer.from(text)); controller.close(); } }),
      async text() { return text; } };
  } });
  await assert.rejects(collect(provider, { model: "m", input: { messages: [] } }, quota), (error) => error.code === "QUOTA_EXHAUSTED");

  // 目录：不内置兜底（没有账号目录时就是空）
  assert.deepEqual(await provider.listModels({ grantId: "g" }, { pool: { context: async () => ({ models: [] }) } }), []);
  assert.deepEqual((await provider.listModels({ grantId: "g" }, { pool: { context: async () => ({ models: [{ id: "glm5.3-flash" }] }) } })).map((m) => m.id), ["glm5.3-flash"]);

  console.log("PASS AtomCode: UA constant, account-prefix stripping, stream_options, fake-success/quota classification and gateway host");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
