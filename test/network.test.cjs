"use strict";
const assert = require("node:assert/strict");
const { createNetwork } = require("../sdk/runtime/network.cjs");

async function main() {
  const calls = [];
  const pool = {
    invocationId: "invocation",
    open: async params => { calls.push(["open", params]); return { requestId: params.kind === "websocket" ? "ws-1" : "http-1", status: params.kind === "websocket" ? 101 : 200, headers: { "content-type": "text/plain" }, done: false }; },
    read: async id => { calls.push(["read", id]); if (id === "http-1") return calls.filter(item => item[0] === "read" && item[1] === id).length === 1 ? { done: false, chunk: Buffer.from("hello").toString("base64") } : { done: true, chunk: "" }; return await new Promise(() => {}); },
    close: async id => { calls.push(["close", id]); return { closed: true }; },
    send: async (id, chunk) => { calls.push(["send", id, chunk]); return { sent: true }; },
  };
  const network = createNetwork(pool, new AbortController().signal);
  const response = await network.fetch("https://example.test/data", { method: "POST", headers: { Accept: "text/plain" }, body: "body" });
  assert.equal(await response.text(), "hello");
  assert.equal(calls[0][1].body, Buffer.from("body").toString("base64"));
  const socket = await network.webSocket("wss://example.test/socket", { headers: { Origin: "https://example.test" } });
  assert.equal(socket.readyState, 1);
  await socket.send("frame");
  await socket.close();
  assert.equal(calls.some(item => item[0] === "send"), true);
  console.log("PASS host-managed network SDK: bounded HTTP body and WebSocket capability wiring");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
