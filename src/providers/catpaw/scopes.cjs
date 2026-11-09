"use strict";
const { CLIENT_SESSION_TTL_MS } = require("./registry.cjs");
const { BoundedRegistry } = require("./bounded-registry.cjs");
const CatPawError = require("./errors.cjs");
const limit = () => new CatPawError(503, "CatPaw 插件会话缓存已达上限", { fatal: true });
function createScopePool({ maxGroups = 32, globalBytes = 32 * 1024 * 1024 } = {}) {
  const groups = new Map();
  const totalBytes = () => [...groups.values()].reduce((n, entry) => n + entry.registry.bytes(), 0);
  function removeIdle(predicate) {
    for (const [key, entry] of groups) if (!entry.active && predicate(entry)) { entry.registry.clearAll(); groups.delete(key); }
  }
  function acquire(scope, accountId, uid, endpoint, accountExecutionEpoch) {
    const now = Date.now();
    removeIdle(entry => now - entry.used >= CLIENT_SESSION_TTL_MS);
    // Opaque epochs have no ordering. A late old invocation must not mark a
    // newer epoch stale. Separate keys fence access; ordinary TTL/LRU reclaims it.
    for (const [key, entry] of groups) if (entry.accountId === accountId && entry.accountExecutionEpoch === accountExecutionEpoch && entry.uid !== uid) {
      entry.stale = true;
      if (!entry.active) { entry.registry.clearAll(); groups.delete(key); }
    }
    const key = JSON.stringify([scope, accountId, uid, endpoint, accountExecutionEpoch]);
    let entry = groups.get(key);
    if (entry?.stale) throw limit();
    if (!entry) {
      if (groups.size >= maxGroups) {
        const victim = [...groups].filter(([, item]) => !item.active).sort((a, b) => a[1].used - b[1].used)[0];
        if (!victim) throw limit();
        victim[1].registry.clearAll(); groups.delete(victim[0]);
      }
      entry = { registry: new BoundedRegistry({ totalBytes, globalBytes }), accountId, uid, accountExecutionEpoch, active: 0, used: now, stale: false };
      groups.set(key, entry);
    }
    entry.active++; entry.used = now;
    let released = false;
    return { registry: entry.registry, release() {
      if (released) return;
      released = true; entry.active--; entry.used = Date.now();
      if (entry.stale && !entry.active) { entry.registry.clearAll(); if (groups.get(key) === entry) groups.delete(key); }
    } };
  }
  return { acquire, stats: () => ({ groups: groups.size, bytes: totalBytes(), active: [...groups.values()].reduce((n, e) => n + e.active, 0) }) };
}
module.exports = { createScopePool, BoundedRegistry };
