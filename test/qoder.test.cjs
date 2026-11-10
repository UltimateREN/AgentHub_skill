"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createQoder, messagesOf, toolsOf, parseQueueAdvice } = require("../src/providers/qoder/provider.cjs");

function response(frames, status = 200) {
  const body = frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("");
  return new Response(body, { status, headers: { "content-type": "text/event-stream" } });
}
async function run() {
  assert.deepEqual(messagesOf([{ role: "developer", content: "system" }, { role: "user", content: "hi" }]).map(item => item.role), ["system", "user"]);
  assert.equal(toolsOf([{ type: "function", function: { name: "lookup" } }, { type: "other" }]).length, 1);
  assert.equal(parseQueueAdvice({ message: JSON.stringify({ waitTime: 12 }) }), 12000);
  let signedArgs, released = 0, request;
  const signer = { async createSession(args) { signedArgs = args; return { prepareInferRequest(url, body, model, source) {
    assert.equal(url, "https://gateway.qoder.com.cn"); assert.equal(model, "qmodel"); assert.equal(source, "system");
    return { url: "https://gateway.qoder.com/infer", headers: { "x-signed": "yes" }, body };
  }, free() { released++; } }; } };
  const frames = [
    { statusCode: "OK", body: JSON.stringify({ choices: [{ delta: { content: "answer" } }] }) },
    { statusCode: "OK", body: JSON.stringify({ choices: [{ finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }) },
  ];
  const provider = createQoder("qoder", {}, signer);
  const ctx = { signal: new AbortController().signal, pool: {
    credentials: async () => ({ token: "session" }), context: async () => ({ uid: "u1", identity: { machineId: "mid" }, models: [{ id: "qmodel", name: "Q Model" }] }),
    network: () => ({ fetch: async (url, init) => { request = { url, init }; return response(frames); } }),
  } };
  const events = [];
  for await (const event of provider.invoke({ model: "qmodel", input: { messages: [{ role: "user", content: "hello" }] } }, ctx)) events.push(event);
  assert.deepEqual(signedArgs, { product: "qoder", token: "session", uid: "u1", machineId: "mid" });
  assert.equal(request.init.headers["x-signed"], "yes");
  assert.equal(JSON.parse(request.init.body).messages[0].content[0].text, "hello");
  assert.equal(events.filter(event => event.type === "finish").length, 1);
  assert.equal(events.find(event => event.type === "usage").usage.total_tokens, 6);
  assert.equal(released, 1);

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "qoder-catalog-test-"));
  const oldProfile = process.env.USERPROFILE;
  try {
    process.env.USERPROFILE = temp;
    const cacheFile = path.join(temp, ".qoder-cn", ".models", "uid-catalog", "catalog-v6");
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, "encrypted-catalog");
    let decrypted, catalogReleased = 0;
    const catalogProvider = createQoder("qoder", {}, { async createSession(args) {
      assert.deepEqual(args, { product: "qoder", token: "session", uid: "uid-catalog", machineId: "mid" });
      return { modelCacheDecrypt(blob, uid) {
        decrypted = { blob, uid };
        return JSON.stringify({ assistant: [
          { key: "qmodel", display_name: "Q Model", context_config: { standard: { token_count: 32000 } }, is_reasoning: true, is_vl: true },
          { key: "retired", enable: false },
        ] });
      }, free() { catalogReleased++; } };
    } });
    const catalog = await catalogProvider.listModels({ grantId: "grant", force: true }, { pool: {
      context: async () => ({ uid: "uid-catalog", identity: { machineId: "mid" }, models: [] }),
      credentials: async () => ({ token: "session" }),
    } });
    assert.deepEqual(decrypted, { blob: "encrypted-catalog", uid: "uid-catalog" });
    assert.deepEqual(catalog.map(model => model.id), ["qmodel"]);
    assert.equal(catalog[0].contextLength, 32000);
    assert.equal(catalog[0].capabilities.images, true);
    assert.equal(catalogReleased, 1);
  } finally {
    if (oldProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = oldProfile;
    fs.rmSync(temp, { recursive: true, force: true });
  }
  // ===== 千问办公双站（qwen_office / qwen_office_intl）=====
  // 同一套协议栈、不同的客户端身份常量（Agent2Providers qoder/endpoints.rs）。
  let qwenArgs, qwenRequest;
  const qwenSigner = { async createSession(args) { qwenArgs = args; return {
    prepareInferRequest(url, body, model) {
      return { url: `${url}/algo/api/v2/service/pro/sse/agent_chat_generation`, headers: {
        "Cosy-Version": "1.1.38", "Cosy-ClientType": "5", "Cosy-Data-Policy": "disagree", "Cosy-Signature": "sig",
      }, body };
    },
    free() {} }; } };
  const qwen = createQoder("qwen_office", {}, qwenSigner);
  const qwenCtx = { signal: new AbortController().signal, pool: {
    credentials: async () => ({ token: "dt-token" }),
    context: async () => ({ uid: "u-qw", identity: { machineId: "mid" }, models: [{ id: "pro", name: "高级" }] }),
    network: () => ({ fetch: async (url, init) => { qwenRequest = { url, init }; return response([{ statusCode: "OK", body: JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }) }]); } }),
  } };
  for await (const _ of qwen.invoke({ model: "pro", input: { messages: [{ role: "user", content: "hi" }] } }, qwenCtx));
  assert.equal(qwenArgs.product, "qwen_office");
  assert.ok(qwenRequest.url.startsWith("https://gateway.qwenwork.cn"), "QwenWork CN must hit its own gateway");
  const qwenBody = JSON.parse(qwenRequest.init.body);
  assert.equal(qwenBody.session_type, "qoder_work", "body session_type must match Cosy-ClientType 6");
  assert.deepEqual(qwenBody.business, { product: "qoder_work", version: "1.1.52" });
  assert.equal(qwenBody.model_config.key, "pro");
  assert.equal(qwenBody.model_config.max_input_tokens, 1024000);
  // 签名后被覆盖成千问办公的身份头（Qoder 客户端的 wasm 产出的是 5 / disagree）
  assert.equal(qwenRequest.init.headers["Cosy-ClientType"], "6");
  assert.equal(qwenRequest.init.headers["Cosy-Data-Policy"], "agree");
  assert.equal(qwenRequest.init.headers["Cosy-Scene"], "qwork");
  assert.equal(qwenRequest.init.headers["Cosy-Business-Product"], "qoder_work");
  assert.equal(qwenRequest.init.headers["Cosy-Business-Type"], "agent");
  assert.equal(qwenRequest.init.headers["Cosy-Version"], "1.1.52");
  assert.equal(qwenRequest.init.headers["User-Agent"], "qoderwork/1.1.0");
  assert.equal(qwenRequest.init.headers["Cosy-Signature"], undefined, "Qoder-only identity headers are replaced, not merged");
  // 国际版主机不同、常量沿用国内版（推断）
  const qwenIntl = createQoder("qwen_office_intl", {}, qwenSigner);
  let intlRequest;
  const intlCtx = { ...qwenCtx, pool: { ...qwenCtx.pool, network: () => ({ fetch: async (url, init) => { intlRequest = { url, init };
    return response([{ statusCode: "OK", body: JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }) }]); } }) } };
  for await (const _ of qwenIntl.invoke({ model: "pro", input: { messages: [{ role: "user", content: "hi" }] } }, intlCtx));
  assert.ok(intlRequest.url.startsWith("https://gateway.qwenwork.ai/"), "QwenWork INTL must hit the .ai gateway");
  assert.equal(JSON.parse(intlRequest.init.body).session_type, "qoder_work");
  // 目录为空时用静态三条兜底（千问办公没有本机 catalog-v6）
  const qwenCatalog = await qwen.listModels({ grantId: "grant" }, { pool: { context: async () => ({ uid: "u", models: [] }), credentials: async () => ({ token: "t" }) } });
  assert.deepEqual(qwenCatalog.map(model => model.id), ["pro", "flash", "qwen3.8-max-preview"]);
  assert.equal(qwenCatalog[0].name, "高级");
  // 强制刷新：千问办公没有本机目录 → 明确报错而不是静默返回空
  await assert.rejects(qwen.listModels({ grantId: "grant", force: true }, { pool: { context: async () => ({ uid: "u", models: [] }), credentials: async () => ({ token: "t" }) } }));
  console.log("PASS Qoder plugin signer lifecycle, scoped identity, OpenAI payload, stream usage/finish and QwenWork site matrix");
}
run().catch(error => { console.error(error); process.exitCode = 1; });
