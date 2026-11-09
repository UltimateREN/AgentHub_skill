"use strict";
// Split incremental values without breaking surrogate pairs or repeating tool
// names/IDs. fits() includes the negotiated wire envelope, not only JSON payload.
function* parts(value, wrap, fits) {
  let offset = 0;
  while (offset < value.length) {
    let low = 1, high = value.length - offset, best = 0;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      let size = mid;
      const last = value.charCodeAt(offset + size - 1);
      if (last >= 0xd800 && last <= 0xdbff && offset + size < value.length) size--;
      if (size > 0 && fits(wrap(value.slice(offset, offset + size)))) { best = size; low = mid + 1; }
      else high = mid - 1;
    }
    if (!best) {
      const count = value.codePointAt(offset) > 0xffff ? 2 : 1;
      if (!fits(wrap(value.slice(offset, offset + count)))) throw new Error("Model delta cannot fit negotiated event limit");
      best = count;
    }
    yield wrap(value.slice(offset, offset + best)); offset += best;
  }
}
function* splitDelta(delta, fits) {
  if (fits(delta)) { yield delta; return; }
  for (const [key, value] of Object.entries(delta)) {
    if (["content", "reasoning_content"].includes(key) && typeof value === "string") {
      yield* parts(value, part => ({ [key]: part }), fits);
    } else if (key === "tool_calls" && Array.isArray(value)) {
      for (const call of value) {
        const header = { ...call, function: { ...call.function, arguments: "" } };
        if (call.id || call.type || call.function?.name) {
          const frame = { tool_calls: [header] };
          if (!fits(frame)) throw new Error("Model tool metadata exceeds negotiated event limit");
          yield frame;
        }
        yield* parts(call.function?.arguments || "", part => ({ tool_calls: [{ index: call.index, function: { arguments: part } }] }), fits);
      }
    } else {
      const frame = { [key]: value };
      if (!fits(frame)) throw new Error("Unsupported oversized model delta");
      yield frame;
    }
  }
}
module.exports = { splitDelta };
