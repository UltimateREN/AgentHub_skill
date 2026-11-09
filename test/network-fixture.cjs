"use strict";
// Loopback HTTP bridge for integration tests. Never used by the shipped plugin.
const assert = require("node:assert/strict");
function installNetwork(peer, origin) {
  const requests = new Map();
  let nextId = 0;
  peer.handle("pool.network.open", async params => {
    assert.equal(new URL(params.url).origin, origin);
    const requestId = `http-${++nextId}`, controller = new AbortController();
    const state = { controller, invocationId: params.invocationId };
    requests.set(requestId, state);
    try {
      const response = await fetch(params.url, { method: params.method, headers: params.headers,
        body: params.body === undefined ? undefined : Buffer.from(params.body, "base64"), signal: controller.signal });
      state.reader = response.body?.getReader();
      return { requestId, status: response.status, headers: Object.fromEntries(response.headers), done: !state.reader };
    } catch (error) { requests.delete(requestId); throw error; }
  });
  peer.handle("pool.network.read", async params => {
    const state = requests.get(params.requestId);
    assert.ok(state);
    const part = await state.reader.read();
    if (part.done) requests.delete(params.requestId);
    return { done: part.done, chunk: part.value ? Buffer.from(part.value).toString("base64") : "" };
  });
  peer.handle("pool.network.close", params => {
    const state = requests.get(params.requestId);
    state?.controller.abort(); requests.delete(params.requestId);
    return { closed: true };
  });
  return invocationId => {
    for (const [id, state] of requests) if (!invocationId || state.invocationId === invocationId) {
      state.controller.abort(); requests.delete(id);
    }
  };
}
module.exports = { installNetwork };
