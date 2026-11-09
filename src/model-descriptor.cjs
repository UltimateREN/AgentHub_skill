"use strict";
// Public directory metadata only. Provider-private routing keys travel inside
// `routing`, which the host stores as an opaque bounded value and never reads.
const PUBLIC_FIELDS = ["name", "rate", "contextLength", "maxOutputTokens"];
const PUBLIC_CAPABILITIES = ["images", "tools", "reasoning", "audio", "video", "pdf"];

function routingOf(entry) {
  const value = entry && entry.routing;
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

// Execution prefers the live catalog entry. The host-owned management snapshot
// keeps the same keys at the top level, so both shapes stay readable until every
// account has refreshed once.
function privateValue(entry, key) {
  const routing = routingOf(entry);
  if (routing && routing[key] !== undefined) return routing[key];
  return entry ? entry[key] : undefined;
}

function descriptor(entry) {
  if (typeof entry === "string") return { id: entry };
  const out = { id: entry.id };
  for (const field of PUBLIC_FIELDS) {
    if (entry[field] !== undefined) out[field] = entry[field];
  }
  if (entry.capabilities && typeof entry.capabilities === "object") {
    out.capabilities = {};
    for (const key of PUBLIC_CAPABILITIES) {
      if (typeof entry.capabilities[key] === "boolean") out.capabilities[key] = entry.capabilities[key];
    }
  }
  const routing = routingOf(entry);
  if (routing) out.routing = { ...routing };
  return out;
}

module.exports = { descriptor, routingOf, privateValue };
