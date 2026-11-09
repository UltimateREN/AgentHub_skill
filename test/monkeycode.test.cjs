"use strict";
const assert = require("node:assert/strict");
const { createMonkeyCode } = require("../src/providers/monkeycode/provider.cjs");

async function main() {
  const provider = createMonkeyCode("monkeycode");
  assert.deepEqual(provider.channels, ["monkeycode"]);
  const context = { models: [{ id: "openai/gpt", name: "GPT", model: "gpt", upstreamId: "uuid-1", interfaceType: "openai_responses", cliName: "codex", rate: 0, capabilities: { tools: true }, contextLength: 200000, maxOutputTokens: 8192 }], identity: { imageId: "" } };
  assert.deepEqual(await provider.listModels({ grantId: "g" }, { pool: { context: async () => context } }), [{ id: "openai/gpt", name: "GPT", rate: 0, capabilities: { tools: true }, contextLength: 200000, maxOutputTokens: 8192 }]);
  let catalogRequest;
  const fresh = await provider.listModels({ grantId: "g", force: true }, { signal: new AbortController().signal, pool: {
    context: async () => context, credentials: async () => ({ session: "cookie-session" }),
    network: () => ({ fetch: async (url, options) => {
      catalogRequest = { url, options };
      return new Response(JSON.stringify({ data: { models: [{ id: "uuid-2", provider: "openai", model: "gpt-new", display_name: "GPT New", interface_type: "openai_responses", context_limit: 300000, output_limit: 16000, thinking_enabled: true }] } }), { status: 200 });
    } }),
  } });
  assert.equal(catalogRequest.url, "https://monkeycode-ai.com/api/v1/users/models");
  assert.equal(catalogRequest.options.headers.Cookie, "monkeycode_ai_session=cookie-session");
  assert.deepEqual(fresh[0].routing, { upstreamId: "uuid-2", interfaceType: "openai_responses", model: "gpt-new", cliName: "codex" });
  const input = { model: "openai/gpt", messages: [{ role: "user", content: "hello" }] };
  const ctx = { signal: new AbortController().signal, deadlineAt: Date.now() + 10000, pool: { credentials: async () => ({ session: "session" }), context: async () => context } };
  const iterator = provider.invoke({ model: "openai/gpt", input }, ctx);
  await assert.rejects(iterator.next(), error => /镜像 id|image/i.test(String(error.message || "")));
  console.log("PASS MonkeyCode external provider catalog, scoped identity and fail-closed preflight");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
