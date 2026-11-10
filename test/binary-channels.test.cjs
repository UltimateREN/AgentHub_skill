"use strict";
// Kiro（AWS event stream 二进制帧）/ Antigravity（Gemini 信封）
const assert = require("node:assert/strict");
const { ReadableStream } = require("node:stream/web");
const kiro = require("../src/providers/kiro/provider.cjs");
const anti = require("../src/providers/antigravity/provider.cjs");

/** 造一个 AWS event stream 帧（只实现我们解析的 string / int 头） */
function awsFrame(headers, payload) {
  const headerParts = [];
  for (const [name, value] of Object.entries(headers)) {
    const nameBuf = Buffer.from(name, "utf8");
    const valueBuf = Buffer.from(String(value), "utf8");
    headerParts.push(Buffer.from([nameBuf.length]), nameBuf, Buffer.from([7]), Buffer.from([valueBuf.length >> 8, valueBuf.length & 0xff]), valueBuf);
  }
  const headerBlock = Buffer.concat(headerParts);
  const payloadBuf = Buffer.from(JSON.stringify(payload), "utf8");
  const total = 12 + headerBlock.length + payloadBuf.length + 4;
  const prelude = Buffer.alloc(12);
  prelude.writeUInt32BE(total, 0);
  prelude.writeUInt32BE(headerBlock.length, 4);
  prelude.writeUInt32BE(0, 8);
  const crc = Buffer.alloc(4);
  return Buffer.concat([prelude, headerBlock, payloadBuf, crc]);
}
function binaryResponse(buffer, status = 200) {
  return {
    ok: status >= 200 && status < 300, status,
    headers: new Headers({ "content-type": "application/vnd.amazon.eventstream" }),
    body: new ReadableStream({ start(controller) { controller.enqueue(buffer); controller.close(); } }),
    async text() { return buffer.toString("utf8"); },
  };
}
function sseResponse(frames, status = 200) {
  const text = frames.map((f) => (typeof f === "string" ? f : `data: ${JSON.stringify(f)}\n\n`)).join("");
  return { ok: status >= 200 && status < 300, status, headers: new Headers({ "content-type": "text/event-stream" }),
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
    pool: { credentials: async () => credentials, context: async () => ({ models }),
      network: () => ({ fetch: async (url, init) => { calls.push({ url, init }); return handler(url, init); } }) },
    attempts: { report: async () => {} } };
}

async function main() {
  // ===== AWS event stream 帧解析 =====
  const frame = awsFrame({ ":message-type": "event", ":event-type": "assistantResponseEvent" }, { content: "hi" });
  const parsed = kiro.readFrame(frame);
  assert.ok(parsed, "one complete frame parses");
  assert.equal(parsed.frame.eventType, "assistantResponseEvent");
  assert.equal(parsed.frame.messageType, "event");
  assert.deepEqual(JSON.parse(parsed.frame.payload.toString("utf8")), { content: "hi" });
  assert.equal(parsed.rest.length, 0);
  assert.equal(kiro.readFrame(frame.subarray(0, frame.length - 2)), null, "a partial frame waits for more bytes");
  assert.equal(kiro.frameIsError({ messageType: "exception" }), true);

  // ===== Kiro 转发 =====
  assert.deepEqual(anti.sanitizeUserAgent(), "antigravity/4.3.0");
  assert.equal(anti.sanitizeUserAgent("antigravity/2.0.0"), "antigravity/4.3.0", "old versions are lifted to the floor");
  assert.equal(anti.sanitizeUserAgent("antigravity/9.9.9"), "antigravity/9.9.9");
  assert.equal(anti.v1Base("sandbox"), "https://sandbox-cloudcode-pa.googleapis.com/v1internal");

  const kiroBuffer = Buffer.concat([
    awsFrame({ ":message-type": "event", ":event-type": "assistantResponseEvent" }, { content: "he" }),
    awsFrame({ ":message-type": "event", ":event-type": "assistantResponseEvent" }, { content: "llo" }),
    awsFrame({ ":message-type": "event", ":event-type": "metadataEvent" }, { stopReason: "end_turn", tokenUsage: { uncachedInputTokens: 3, outputTokens: 2 } }),
  ]);
  const kiroCtx = ctx({ credentials: { token: "tk", profileArn: "arn:aws:codewhisperer:eu-central-1:1:profile/x", region: "eu-central-1" }, handler: () => binaryResponse(kiroBuffer) });
  const kiroEvents = await collect(kiro.createKiro({}), { model: "claude-sonnet-4.5", input: { messages: [{ role: "user", content: "hi" }] } }, kiroCtx);
  assert.equal(kiroCtx.calls[0].url, "https://runtime.eu-central-1.kiro.dev/generateAssistantResponse", "runtime host follows the account region");
  assert.equal(kiroCtx.calls[0].init.headers.accept, "application/vnd.amazon.eventstream");
  assert.match(kiroCtx.calls[0].init.headers["user-agent"], /^KiroIDE-1\.1\.70-[0-9a-f]{64}$/);
  const kiroBody = JSON.parse(kiroCtx.calls[0].init.body);
  assert.equal(kiroBody.conversationState.chatTriggerType, "MANUAL");
  assert.equal(kiroBody.conversationState.currentMessage.userInputMessage.origin, "KIRO_CLI");
  assert.equal(kiroBody.profileArn, "arn:aws:codewhisperer:eu-central-1:1:profile/x");
  assert.deepEqual(kiroEvents.filter((e) => e.type === "delta").map((e) => e.delta.content), ["he", "llo"]);
  assert.deepEqual(kiroEvents.find((e) => e.type === "usage").usage, { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
  assert.deepEqual(kiroEvents.at(-1), { type: "finish", reason: "stop" });

  // 异常帧 → 明确错误
  const kiroErr = ctx({ credentials: { token: "tk", region: "us-east-1" }, handler: () => binaryResponse(Buffer.concat([
    awsFrame({ ":message-type": "exception", ":exception-type": "ThrottlingException" }, { message: "slow down" }),
  ])) });
  await assert.rejects(collect(kiro.createKiro({}), { model: "m", input: { messages: [] } }, kiroErr), (e) => e.code === "RATE_LIMITED");

  // ===== Antigravity 信封 =====
  const env = anti.buildEnvelope({ messages: [
    { role: "system", content: "be brief" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "ok" },
  ], tools: [{ type: "function", function: { name: "lookup", parameters: { type: "OBJECT", properties: {}, additionalProperties: false } } }], max_tokens: 1000 }, "gemini-3-pro", { project: "proj-1" });
  assert.equal(env.model, "gemini-3-pro");
  assert.equal(env.project, "proj-1");
  assert.equal(env.userAgent, "antigravity");
  assert.equal("requestType" in env, false, "the agent path must not send requestType");
  assert.match(env.requestId, /^agent\/\d+\/[0-9a-f]{8}$/);
  assert.equal(env.request.systemInstruction.parts[0].text, "be brief");
  assert.equal(env.request.tools.length, 1, "tools are a single group");
  assert.equal(env.request.tools[0].functionDeclarations[0].parameters.type, "object", "schema types are lower-cased");
  assert.equal("additionalProperties" in env.request.tools[0].functionDeclarations[0].parameters, false);
  // contents 必须以 user 结尾：末尾是 model 时补一句
  assert.equal(env.request.contents.at(-1).role, "user");
  assert.equal(env.request.contents.at(-1).parts[0].text, "Please continue your analysis.");
  assert.ok(env.request.generationConfig.maxOutputTokens > env.request.generationConfig.thinkingConfig.thinkingBudget, "maxOutputTokens must exceed the thinking budget");

  const antiCtx = ctx({ credentials: { token: "g-token", project: "proj-1" }, handler: () => sseResponse([
    { response: { candidates: [{ content: { parts: [{ text: "thi", thought: true }] } }] } },
    { response: { candidates: [{ content: { parts: [{ text: "hi" }] } }] } },
    { response: { candidates: [{ content: { parts: [{ functionCall: { name: "lookup", args: { q: 1 } } }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6 } } },
  ]) });
  const antiEvents = await collect(anti.createAntigravity({}), { model: "gemini-3-pro", input: { messages: [{ role: "user", content: "hi" }] } }, antiCtx);
  assert.equal(antiCtx.calls[0].url, "https://sandbox-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse", "sandbox is tried first");
  assert.equal(antiCtx.calls[0].init.headers["x-goog-api-client"], undefined, "x-goog-api-client must never be sent");
  assert.equal(antiCtx.calls[0].init.headers["user-agent"], "antigravity/4.3.0");
  assert.equal(antiEvents.filter((e) => e.type === "delta" && e.delta.reasoning_content).length, 1, "thought parts become reasoning deltas");
  assert.deepEqual(antiEvents.filter((e) => e.type === "delta" && e.delta.content).map((e) => e.delta.content), ["hi"]);
  const antiTool = antiEvents.find((e) => e.type === "delta" && e.delta.tool_calls);
  assert.equal(antiTool.delta.tool_calls[0].function.name, "lookup");
  assert.equal(antiTool.delta.tool_calls[0].function.arguments, JSON.stringify({ q: 1 }));
  assert.deepEqual(antiEvents.find((e) => e.type === "usage").usage, { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 });
  assert.equal(antiEvents.at(-1).reason, "tool_calls");

  console.log("PASS binary channels: AWS event-stream framing + Kiro conversation envelope, Antigravity envelope/schema/thought parts");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
