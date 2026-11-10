"use strict";
// 会话式三渠道：OrcaTerm（两步有状态）/ AStudio（Responses）/ 豆包工作（命名事件 SSE）
const assert = require("node:assert/strict");
const { ReadableStream } = require("node:stream/web");
const orca = require("../src/providers/orcaterm/provider.cjs");
const astudio = require("../src/providers/astudio/provider.cjs");
const doubao = require("../src/providers/doubaowork/provider.cjs");

function sseResponse(frames, status = 200, type = "text/event-stream") {
  const text = frames.join("");
  return {
    ok: status >= 200 && status < 300, status,
    headers: new Headers({ "content-type": type }),
    body: new ReadableStream({ start(controller) { controller.enqueue(Buffer.from(text)); controller.close(); } }),
    async text() { return text; },
  };
}
function jsonResponse(value, status = 200) {
  const text = JSON.stringify(value);
  return { ok: status >= 200 && status < 300, status, headers: new Headers({ "content-type": "application/json" }),
    body: new ReadableStream({ start(controller) { controller.enqueue(Buffer.from(text)); controller.close(); } }),
    async text() { return text; } };
}
async function collect(provider, request, ctx) {
  const events = [];
  for await (const event of provider.invoke(request, ctx)) events.push(event);
  return events;
}
function ctx({ credentials, models = [], handler }) {
  const calls = [];
  return { calls, signal: new AbortController().signal,
    pool: {
      credentials: async () => credentials,
      context: async () => ({ accountId: "a", uid: "u", models }),
      network: () => ({ fetch: async (url, init) => { calls.push({ url, init }); return handler(url, init); } }),
    },
    attempts: { report: async () => {} } };
}

async function main() {
  // ===== OrcaTerm：两步（建会话 → SSE）=====
  assert.equal(orca.buildPrompt([{ role: "user", content: "hi" }]), "hi");
  assert.match(orca.buildPrompt([{ role: "system", content: "s" }, { role: "user", content: "u" }]), /^\[以下是本轮之前的对话记录/);
  assert.equal(orca.resolveModel("glm-5.3"), "TokenHub/glm-5.3");
  assert.equal(orca.resolveModel("unknown-model"), "TokenHub/glm-5.3-flash", "unknown models fall back to the verified default");
  assert.equal(orca.unwrapEnvelope('```json\n{"action":"completion","taskCompletion":"done"}\n```'), "done");
  assert.equal(orca.unwrapEnvelope("plain"), "plain");

  const orcaCtx = ctx({ credentials: { token: "tk", uin: "42" }, handler: (url) => {
    if (url.endsWith("/assistant/conversation")) return jsonResponse({ code: 0, data: { id: "cid-1" } });
    return sseResponse([
      `data: ${JSON.stringify({ code: 0, content: "he" })}\n\n`,
      `data: ${JSON.stringify({ code: 0, content: "llo" })}\n\n`,
      "data: [DONE]\n\n",
    ]);
  } });
  const orcaEvents = await collect(orca.createOrcaTerm({}), { model: "glm-5.3", input: { messages: [{ role: "user", content: "hi" }] } }, orcaCtx);
  assert.equal(orcaCtx.calls.length, 2, "conversation is created first, then the chat stream opens");
  assert.ok(orcaCtx.calls[0].url.endsWith("/assistant/conversation"));
  assert.ok(orcaCtx.calls[1].url.includes("/assistant/chat?name=orcaterm&mode=0"));
  assert.equal(orcaCtx.calls[1].init.headers["X-Product"], "orcaterm");
  const orcaBody = JSON.parse(orcaCtx.calls[1].init.body);
  assert.equal(orcaBody.user.id, "42");
  assert.equal(orcaBody.user.setting.model, "TokenHub/glm-5.3");
  assert.equal(orcaBody.input.type, "start");
  assert.equal(orcaBody.input.input, "hi");
  assert.deepEqual(orcaEvents.filter((e) => e.type === "delta").map((e) => e.delta.content), ["he", "llo"]);
  assert.deepEqual(orcaEvents.at(-1), { type: "finish", reason: "stop" });

  // 错误帧不是 JSON：`data: [ERROR]: [LLM_ERROR]: …`
  const orcaErr = ctx({ credentials: { token: "tk", uin: "42" }, handler: (url) => url.endsWith("/assistant/conversation")
    ? jsonResponse({ code: 0, data: { id: "cid-1" } })
    : sseResponse(["data: [ERROR]: [LLM_ERROR]: LLM(TokenHub/hy4-preview) is not loaded\n\n"]) });
  await assert.rejects(collect(orca.createOrcaTerm({}), { model: "hy4-preview", input: { messages: [] } }, orcaErr), (e) => e.code === "MODEL_NOT_LOADED");

  // ===== AStudio：Responses =====
  const req = astudio.buildRequest({ messages: [
    { role: "system", content: "be brief" },
    { role: "user", content: [{ type: "text", text: "hi" }, { type: "image_url", image_url: { url: "https://img" } }] },
    { role: "assistant", content: "ok", tool_calls: [{ id: "c1", function: { name: "lookup", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: "result" },
  ], max_tokens: 100, reasoning_effort: "high", tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }] }, "m1");
  assert.equal(req.instructions, "be brief");
  assert.equal(req.max_output_tokens, 100);
  assert.deepEqual(req.reasoning, { effort: "high" });
  assert.equal(req.tools[0].name, "lookup");
  assert.equal("function" in req.tools[0], false, "Responses tools are flat, not nested under function");
  assert.equal(req.input[0].content[1].type, "input_image");
  // assistant 的正文先成一条 message，再是 function_call；tool 结果最后
  assert.deepEqual(req.input.map((item) => item.type), ["message", "message", "function_call", "function_call_output"]);

  const astCtx = ctx({ credentials: { token: "bearer" }, handler: () => sseResponse([
    `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "hi" })}\n\n`,
    `data: ${JSON.stringify({ type: "response.output_item.added", item: { id: "i1", type: "function_call", call_id: "c1", name: "lookup" } })}\n\n`,
    `data: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "i1", delta: '{"q":1}' })}\n\n`,
    `data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } })}\n\n`,
  ]) });
  const astEvents = await collect(astudio.createAStudio({}), { model: "m1", input: { messages: [{ role: "user", content: "hi" }] } }, astCtx);
  assert.equal(astCtx.calls[0].url, astudio.RESPONSES_URL);
  assert.deepEqual(astEvents.filter((e) => e.type === "delta" && e.delta.content).map((e) => e.delta.content), ["hi"]);
  const toolFrame = astEvents.find((e) => e.type === "delta" && e.delta.tool_calls);
  assert.equal(toolFrame.delta.tool_calls[0].function.arguments, '{"q":1}');
  assert.equal(astEvents.at(-1).reason, "tool_calls");
  assert.deepEqual(astEvents.find((e) => e.type === "usage").usage, { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });

  // ===== 豆包工作：命名事件 SSE =====
  assert.equal(doubao.buildPrompt([{ role: "user", content: "hi" }]), "hi");
  const payload = doubao.buildPayload("bot-1", "m1", "hello");
  assert.equal(payload.client_meta.bot_id, "bot-1");
  assert.equal(payload.messages[0].content_block[0].content.text_block.text, "hello");
  assert.equal(payload.option.need_create_conversation, true);
  const query = doubao.queryOf({ deviceId: "dev-1", clientVersion: "2.33.5" });
  assert.ok(query.includes("device_id=dev-1"));
  assert.ok(query.includes("fp=verify_dev-1"), "device_id implies the verify_ fingerprint");
  assert.ok(query.includes("pc_version=2.33.5"));

  const dbCtx = ctx({ credentials: { token: "sessionid=abc", deviceId: "dev-1", botId: "bot-1" }, handler: () => sseResponse([
    "event: CHUNK_DELTA\ndata: {\"text\":\"he\"}\n\n",
    "event: CHUNK_DELTA\ndata: {\"text\":\"llo\"}\n\n",
    "event: STREAM_MSG_NOTIFY\ndata: {\"content\":{\"content_block\":[{\"content\":{\"text_block\":{\"text\":\" world\"}}}]}}\n\n",
  ]) });
  const dbEvents = await collect(doubao.createDoubaoWork({}), { model: "m1", input: { messages: [{ role: "user", content: "hi" }] } }, dbCtx);
  assert.ok(dbCtx.calls[0].url.includes("/chat/completion?aid=1044603"));
  assert.equal(dbCtx.calls[0].init.headers.cookie, "sessionid=abc");
  assert.deepEqual(dbEvents.filter((e) => e.type === "delta").map((e) => e.delta.content), ["he", "llo", " world"]);
  assert.deepEqual(dbEvents.at(-1), { type: "finish", reason: "stop" });

  console.log("PASS session channels: OrcaTerm two-step + envelope unwrap, AStudio Responses translation, DoubaoWork named-event SSE");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
