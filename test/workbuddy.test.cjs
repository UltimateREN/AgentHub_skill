"use strict";
const assert = require("node:assert/strict");
const { createWorkBuddy, rewrite, classifyWorkBuddy } = require("../src/providers/workbuddy/provider.cjs");
const body = rewrite("gpt-test", { messages: [{ role: "developer", content: "x-anthropic-billing-header:bad; hi" }], max_completion_tokens: 42, tool_choice: "none", tools: [{ type: "function" }] }, { uid: "u" }, {});
assert.equal(body.stream, true);
assert.equal(body.max_tokens, 42);
assert.equal(body.messages[0].role, "system");
assert.equal(body.tools, undefined);
const injected = rewrite("gpt-test", { messages: [{ role: "user", content: "hi" }] }, { uid: "u" }, {});
assert.equal(injected.messages[0].role, "system");
assert.equal(injected.messages[0].content, "你是一个得力助手");
assert.match(injected.prompt_cache_key, /^wb2a-u-[a-f0-9]{32}$/);
assert.deepEqual(injected.stream_options, { include_usage: true });
const explicitStream = rewrite("gpt-test", { messages: [{ role: "system", content: "s" }], stream_options: { include_usage: false } }, {}, {});
assert.deepEqual(explicitStream.stream_options, { include_usage: false });
const image = rewrite("gpt-test", { messages: [{ role: "user", content: [{ type: "image_url", image_url: "data:image/png;base64,x" }] }] }, {}, {});
assert.deepEqual(image.messages[1].content[0].image_url, { url: "data:image/png;base64,x" });
assert.equal(createWorkBuddy().id, "workbuddy");
assert.deepEqual(createWorkBuddy().channels, ["workbuddy", "workbuddy_ai"]);

// ===== 错误分类：业务码语义（对齐示例项目 Agent2Providers workbuddy/errors.rs）=====
function kindOf(status, payload) {
  return classifyWorkBuddy(status, { error: { code: payload.code, message: payload.message || "" } }).kind;
}
// 11140 同码两义：无明确限流文案时一律按账号级风控（宁可冷却，也不反复撞）
assert.equal(kindOf(403, { code: 11140, message: "request illegal" }), "account_blocked");
assert.equal(kindOf(403, { code: 11140, message: "" }), "account_blocked", "11140 无文案时按账号风控兜底");
assert.equal(kindOf(403, { code: 11140, message: "rate-limiting" }), "rate");
assert.equal(kindOf(401, {}), "relogin");
assert.equal(kindOf(400, { code: 12153 }), "relogin", "12153 是 token 过期业务码");
assert.equal(kindOf(400, { code: 11102, message: "service info not found" }), "model_blocked");
assert.equal(kindOf(400, { code: 11115, message: "prompt is too long" }), "prompt_too_long");
assert.equal(kindOf(402, { code: 14001 }), "credit", "402/额度码必须归 credit 才能冷却账号");
assert.equal(kindOf(200, { code: 6004, message: "您的使用量已超出频率限制" }), "model_rate", "6004 是模型级限流");
assert.equal(kindOf(429, {}), "rate");
assert.equal(kindOf(400, { code: 11128 }), "content_blocked");
assert.equal(kindOf(400, { code: 11101 }), "bad_params");
assert.equal(kindOf(502, {}), "server");
// 业务码埋在 /data 与 /error/data 深层时也要找得到
assert.equal(classifyWorkBuddy(403, { error: { data: { code: 11140, msg: "request illegal" } } }).kind, "account_blocked");
assert.equal(classifyWorkBuddy(400, { error: { data: { code: 11102, msg: "service info not found" } } }).kind, "model_blocked");

// ===== 回归：数字业务码绝不能再退化成协议异常 =====
// 旧实现的 `Number(data.error.code) || "UPSTREAM_FAILED"` 恒为 number，
// 撞上协议层 identifier(code) 只收字符串的断言 -> PLUGIN_PROTOCOL -> 宿主只见 UPSTREAM_FAILED。
async function errorClassification() {
  const cases = [
    { status: 403, payload: { error: { code: 11140, message: "request illegal" } }, code: "UPSTREAM_ACCOUNT_BLOCKED", category: "account", scope: "account" },
    { status: 402, payload: { error: { code: 14001, message: "额度已用尽" } }, code: "UPSTREAM_CREDIT", category: "quota", scope: "account" },
    { status: 400, payload: { error: { code: 11102, message: "service info not found" } }, code: "UPSTREAM_MODEL_BLOCKED", category: "model", scope: "account-model" },
    { status: 401, payload: { error: { code: 12153, message: "token expired" } }, code: "UPSTREAM_RELOGIN", category: "auth", scope: "account" },
    { status: 500, payload: "upstream exploded", code: "UPSTREAM_SERVER", category: "upstream", scope: "account" },
  ];
  for (const testCase of cases) {
    const provider = createWorkBuddy();
    const account = { uid: "user-1", models: [{ id: "hy4-preview" }] };
    const ctx = { signal: new AbortController().signal,
      pool: { ensureCredentials: async () => ({ token: "token-1" }), context: async () => account,
        network: () => ({ fetch: async () => new Response(JSON.stringify(testCase.payload), { status: testCase.status }) }) } };
    let caught = null;
    try { for await (const event of provider.invoke({ model: "hy4-preview", channel: "workbuddy", input: { messages: [{ role: "user", content: "hi" }] } }, ctx)) void event; }
    catch (error) { caught = error; }
    assert.ok(caught, `HTTP ${testCase.status} 必须抛错`);
    assert.ok(caught.forwardError, `必须带结构化分类，实际得到：${caught.code} / ${caught.message}`);
    assert.equal(caught.forwardError.code, testCase.code);
    assert.equal(caught.forwardError.category, testCase.category);
    assert.equal(caught.forwardError.scope, testCase.scope);
    assert.equal(typeof caught.forwardError.code, "string", "code 必须是字符串（协议层硬要求）");
    assert.ok(caught.forwardError.status >= 400 && caught.forwardError.status <= 599);
  }

  // 流内错误帧（HTTP 200 + SSE，WB 最常见的报错形态）：数字码同样不能退化。
  // 6004 是模型级限流（换模型即可用），4008 是账号级频率限制 —— 口径对齐号池 classify.cjs。
  for (const testCase of [
    { payload: { error: { code: 6004, message: "您的使用量已超出频率限制，将在 2026-11-11 15:00 重置" } }, scope: "account-model" },
    { payload: { error: { code: 4008, message: "rate-limiting" } }, scope: "account" },
  ]) {
    const payload = testCase.payload;
    const provider = createWorkBuddy();
    const ctx = { signal: new AbortController().signal,
      pool: { ensureCredentials: async () => ({ token: "token-1" }),
        context: async () => ({ uid: "user-1", models: [{ id: "hy4-preview" }] }),
        network: () => ({ fetch: async () => new Response(`data: ${JSON.stringify(payload)}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } }) }) } };
    let caught = null;
    try { for await (const event of provider.invoke({ model: "hy4-preview", channel: "workbuddy", input: { messages: [{ role: "user", content: "hi" }] } }, ctx)) void event; }
    catch (error) { caught = error; }
    assert.ok(caught?.forwardError, "流内错误帧必须带结构化分类");
    assert.equal(typeof caught.forwardError.code, "string");
    assert.equal(caught.forwardError.category, "rate");
    assert.equal(caught.forwardError.scope, testCase.scope, `${payload.error.code} 的账号级/模型级归属`);
  }
}

async function catalogTest() {
  const calls = [];
  const provider = createWorkBuddy();
  const rows = await provider.listModels({ grantId: "g", force: true, channel: "workbuddy" }, { signal: new AbortController().signal, pool: {
    context: async () => ({ uid: "user-1", models: [] }), credentials: async () => ({ token: "token-1" }),
    network: () => ({ fetch: async (url, options) => {
      calls.push({ url, options });
      const models = url.includes("/v3/") ? [{ id: "shared", name: "V3", maxOutputTokens: 8192, supportsToolCall: true }, { id: "completion-hidden", maxOutputTokens: 128 }] : [{ id: "shared", name: "Console" }, { id: "legacy" }];
      return new Response(JSON.stringify({ data: { models } }), { status: 200 });
    } }),
  } });
  assert.equal(calls.length, 2);
  assert.equal(rows.find(row => row.id === "shared").name, "V3", "v3 catalog wins collisions");
  assert.ok(!rows.some(row => row.id.startsWith("completion-")), "completion 系模型被过滤");
  assert.ok(rows.some(row => row.id === "legacy"), "console remains a fallback source");
  assert.equal(calls[0].options.headers["x-product"], "SaaS");
  assert.equal(calls[0].options.headers["x-ide-version"], "5.9.3");
  assert.equal(calls[0].options.headers.accept, "application/json");
  assert.equal(calls[0].options.headers["x-conversation-id"], undefined, "catalog requests do not carry conversation identity");
}
async function invoke(provider, channel, account) {
  const requests = [];
  const ctx = { signal: new AbortController().signal,
    pool: { ensureCredentials: async () => ({ token: "token-1" }),
      context: async () => account,
      network: () => ({ fetch: async (url, options) => { requests.push({ url, options });
        return new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }); } }) } };
  try {
    for await (const event of provider.invoke({ model: account.models[0].id, channel, input: { messages: [{ role: "user", content: "hi" }] } }, ctx)) void event;
  } catch { /* 空流走上游错误分支，这里只关心实际发出的请求 */ }
  return requests[0];
}
async function routingTest() {
  const provider = createWorkBuddy();
  const cn = await invoke(provider, "workbuddy", { uid: "user-1", enterpriseId: "ent-1", domain: "www.workbuddy.cn",
    models: [{ id: "public-id", routing: { upstreamModel: "upstream-id" } }] });
  assert.equal(cn.url, "https://www.workbuddy.cn/v2/chat/completions", "CN chat uses the desktop client endpoint");
  assert.equal(JSON.parse(cn.options.body).model, "upstream-id", "live routing carries the upstream model name");
  assert.equal(JSON.parse(cn.options.body).messages[0].content, "你是一个得力助手");
  assert.match(cn.options.headers["user-agent"], /^WorkBuddy\/5\.9\.3 WorkBuddy\/5\.9\.3 CLI\/2\.165\.0$/, "official three-segment desktop UA");
  assert.equal(cn.options.headers["x-product"], "SaaS");
  assert.equal(cn.options.headers["x-ide-name"], "WorkBuddy");
  assert.equal(cn.options.headers["x-ide-type"], "WorkBuddy");
  assert.equal(cn.options.headers["x-ide-version"], "5.9.3");
  assert.equal(cn.options.headers["x-private-data"], "true");
  assert.equal(cn.options.headers["x-agent-intent"], "craft");
  assert.equal(cn.options.headers["x-enterprise-id"], "ent-1");
  assert.equal(cn.options.headers["x-tenant-id"], "ent-1");
  assert.equal(cn.options.headers["x-domain"], "www.workbuddy.cn");
  assert.equal(cn.options.headers.referer, undefined, "desktop gateway requests do not send Referer");
  assert.ok(cn.options.headers["x-conversation-id"] && cn.options.headers["x-conversation-request-id"] && cn.options.headers["x-request-id"]);
  assert.equal(cn.options.headers["x-root-request-id"], cn.options.headers["x-conversation-request-id"], "会话内所有重试复用同一个 root request id");
  assert.equal(cn.options.headers.accept, "application/json, text/event-stream");

  // 个人号（无企业身份）必须显式声明「没有企业 ID」，否则上游把缺省身份当可疑信号
  const personal = await invoke(provider, "workbuddy", { uid: "user-3", enterpriseId: "", domain: "www.workbuddy.cn", models: [{ id: "hy4-preview" }] });
  assert.equal(personal.options.headers["x-no-enterprise-id"], "1", "个人号显式声明无企业 ID");
  assert.equal(personal.options.headers["x-enterprise-id"], undefined, "无企业时不发企业头");

  const ai = await invoke(provider, "workbuddy_ai", { uid: "user-2", enterpriseId: "ent-2", domain: "www.workbuddy.cn",
    models: [{ id: "ai-id", routing: { upstreamModel: "ai-upstream" } }] });
  assert.equal(ai.url, "https://www.workbuddy.ai/v2/chat/completions");
  assert.equal(JSON.parse(ai.options.body).model, "ai-upstream");
  // 平台段必须是国际版产品名：送 CN 的 WorkBuddy 会被上游判成网关并回 403 code 11140
  assert.match(ai.options.headers["user-agent"], /^WorkBuddy\/5\.9\.4 WorkBuddy AI\/5\.9\.4 CLI\/2\.165\.0$/, "AI client uses the international platform segment");
  assert.equal(ai.options.headers["x-product"], "SaaS");
  assert.equal(ai.options.headers["x-ide-version"], "5.9.4");
  // 国际号即使登录态里残留 CN 域，也必须发 .ai 域
  assert.equal(ai.options.headers["x-domain"], "www.workbuddy.ai", "国际号域固定为 .ai，不回退 CN 域");
  assert.equal(ai.options.headers["x-agent-runtime"], undefined, "x-agent-runtime 只属于 CN 渠道");
}
catalogTest().then(errorClassification).then(routingTest)
  .then(() => console.log("PASS WorkBuddy plugin provider: dual channels, scoped credentials, official client identity, body normalization, live routing, stream contract and business-code error classification"))
  .catch(error => { console.error(error); process.exitCode = 1; });
