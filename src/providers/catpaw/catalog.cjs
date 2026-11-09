"use strict";
// Read-only, request-scoped host facts. No local catalog/store/management HTTP.
const { current } = require("./runtime-context.cjs");
function list() { return current().models; }
function findRemote(value) {
  const wanted = String(value || "").trim().toLowerCase();
  return list().find(item => ["id", "name"].some(key => String(item[key] || "").trim().toLowerCase() === wanted)) || null;
}
module.exports = { list, findRemote, knownIds: () => list().map(item => item.id) };
