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
  console.log("PASS Qoder plugin signer lifecycle, scoped identity, OpenAI payload and stream usage/finish");
}
run().catch(error => { console.error(error); process.exitCode = 1; });
