"use strict";
// Model-only policy. No host checkout, account selection or management APIs.
const state = require("./degrade.cjs");
function neutralize(input) {
  if (!input || !Array.isArray(input.messages)) return input;
  return { ...input, messages: input.messages.map(message => message?.role === "system"
    ? { ...message, content: state.NEUTRAL_PROMPT } : message) };
}
function content(delta) {
  return !!(delta?.content || delta?.reasoning_content || delta?.tool_calls?.length
    || delta?.function_call?.name || delta?.function_call?.arguments);
}
async function* withContentRemediation({ input, execute, reserveAttempt, signal }) {
  let committed = false, unsafe = false;
  const degraded = state.active();
  try {
    for await (const event of execute(degraded ? neutralize(input) : input)) {
      signal?.throwIfAborted();
      if (event.type === "checkpoint" && event.replay !== "safe") unsafe = true;
      if (event.type === "delta" && content(event.delta)) committed = true;
      if (event.type === "error") throw Object.assign(new Error(event.message || "Upstream model failed"), event);
      yield event;
    }
  } catch (original) {
    signal?.throwIfAborted();
    const eligible = !committed && !unsafe && !degraded && original.replay === "safe"
      && [400, 403, 451].includes(Number(original.status)) && state.isContentBlock(original.privateDetail || original.message);
    if (!eligible) throw original;
    // Preserve original state semantics; actual second model send requires a
    // host-owned attempt reservation. No optional local retry counter fallback.
    state.trigger();
    if (typeof reserveAttempt !== "function" || await reserveAttempt() !== true) throw original;
    signal?.throwIfAborted();
    let retryCommitted = false, retryUnsafe = false;
    try {
      for await (const event of execute(neutralize(input))) {
        signal?.throwIfAborted();
        if (event.type === "error") throw Object.assign(new Error(event.message || "Upstream model failed"), event);
        if (event.type === "delta" && content(event.delta)) retryCommitted = true;
        if (event.type === "checkpoint" && event.replay !== "safe") retryUnsafe = true;
        yield event;
      }
    } catch (retryError) {
      if (signal?.aborted) throw signal.reason;
      // Once retry has emitted content, preserve that failure instead of masking
      // its possible task/stream side effects as the original pre-content error.
      // A second dispatch may have created a task even without output. Never
      // disguise its unknown outcome as the first, explicitly rejected request.
      throw retryCommitted || retryUnsafe || retryError.replay !== "safe" ? retryError : original;
    }
  }
}
module.exports = { neutralize, withContentRemediation };
