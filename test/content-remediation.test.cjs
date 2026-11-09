"use strict";
const assert = require("node:assert/strict");
const http = require("node:http");
const state = require("../src/execution/degrade.cjs");
const { withContentRemediation } = require("../src/execution/content-remediation.cjs");
let calls = [], reservations = 0;
const upstream = http.createServer(async (req, res) => {
  let raw = ""; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw); calls.push({ token: req.headers.authorization, body });
  const system = body.messages.find(message => message.role === "system").content;
  if (system.includes("CUSTOM_SYS")) { res.writeHead(400); res.end("content_policy_violation: content blocked by review"); }
  else { res.writeHead(200); res.end("SUCCESS"); }
});
async function main() {
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const input = { model: "model", messages: [{ role: "system", content: "CUSTOM_SYS: 原提示词" }, { role: "user", content: "hello" }] };
  const execute = async function* (body) {
    const response = await fetch(`http://127.0.0.1:${upstream.address().port}`, { method: "POST", headers: { authorization: "Bearer same-account" }, body: JSON.stringify(body) });
    const text = await response.text();
    if (!response.ok) throw Object.assign(new Error(text), { status: response.status, replay: "safe" });
    yield { type: "delta", delta: { content: text } };
    yield { type: "finish", reason: "stop" };
  };
  const collect = async iterator => { const events = []; for await (const event of iterator) events.push(event); return events; };
  const reserveAttempt = async () => { reservations++; return true; };
  state.clear();
  let events = await collect(withContentRemediation({ input, execute, reserveAttempt }));
  assert.equal(calls.length, 2); assert.equal(reservations, 1);
  assert.match(calls[0].body.messages[0].content, /CUSTOM_SYS/);
  assert.equal(calls[1].body.messages[0].content, "You are a helpful assistant.");
  assert.equal(calls[0].token, calls[1].token, "same original credential on remediation");
  assert.equal(events[0].delta.content, "SUCCESS"); assert.equal(state.active(), true);
  const until = state.until(); state.trigger(); assert.equal(state.until(), until, "trigger never extends the period");
  calls = [];
  await collect(withContentRemediation({ input, execute, reserveAttempt }));
  assert.equal(calls.length, 1); assert.equal(calls[0].body.messages[0].content, state.NEUTRAL_PROMPT);
  assert.match(input.messages[0].content, /CUSTOM_SYS/, "original caller input remains intact");
  state.clear(); calls = [];
  await assert.rejects(collect(withContentRemediation({ input, execute })), /content_policy/);
  assert.equal(calls.length, 1, "missing host reservation cannot silently permit another model send");
  state.clear(); calls = [];
  await assert.rejects(collect(withContentRemediation({ input, execute, reserveAttempt: () => false })), /content_policy/);
  assert.equal(calls.length, 1);
  for (const event of [{ type: "delta", delta: { content: "PARTIAL" } }, { type: "checkpoint", replay: "unsafe" }]) {
    state.clear(); let attempts = 0;
    await assert.rejects(collect(withContentRemediation({ input, reserveAttempt, execute: async function* () {
      attempts++; yield event; throw Object.assign(new Error("content_policy_violation"), { status: 400, replay: "safe" });
    } })), /content_policy/);
    assert.equal(attempts, 1, "generated content or task side effects prohibit replay");
  }
  for (const replay of [undefined, "unknown", "unsafe"]) {
    state.clear(); let attempts = 0;
    await assert.rejects(collect(withContentRemediation({ input, reserveAttempt, execute: async function* () {
      attempts++; throw Object.assign(new Error("content_policy_violation"), { status: 400, replay });
    } })), /content_policy/);
    assert.equal(attempts, 1, "content rejection text does not prove safe replay");
  }
  state.clear(); let dispatched = 0;
  const unknown = Object.assign(new Error("second dispatch outcome unknown"), { replay: "unknown" });
  await assert.rejects(collect(withContentRemediation({ input, reserveAttempt, execute: async function* () {
    if (++dispatched === 1) throw Object.assign(new Error("content_policy_violation"), { status: 400, replay: "safe" });
    throw unknown;
  } })), error => error === unknown);
  assert.equal(dispatched, 2, "an unknown retry must not become the first safe rejection");
  console.log("PASS external content remediation: loopback rejection, same account, neutral prompt, next request, no extension, immutable input, host budget refusal, content/task replay protection");
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  state.clear(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve));
});
