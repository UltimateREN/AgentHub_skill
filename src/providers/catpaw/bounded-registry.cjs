"use strict";
const { SessionRegistry, isExpired } = require("./registry.cjs");
const CatPawError = require("./errors.cjs");
const limit = () => new CatPawError(503, "CatPaw 插件会话缓存已达上限", { fatal: true });
const bytes = value => Buffer.byteLength(JSON.stringify(value), "utf8");
class BoundedRegistry extends SessionRegistry {
  constructor({ maxRecords = 200, maxBytes = 4 * 1024 * 1024, totalBytes = () => 0, globalBytes = Infinity } = {}) {
    super();
    this.maxRecords = maxRecords;
    this.maxBytes = maxBytes;
    this.totalBytes = totalBytes;
    this.globalBytes = globalBytes;
    this.claims = new Map();
  }
  records() { return [...this.sessions.values(), ...this.anonymous.values()]; }
  bytes() { return this.records().reduce((sum, record) => sum + bytes(record), 0); }
  busy(record) { return this.isInflight(record.sessionId) || this.claims.has(record.conversationId); }
  markInflight(sessionId, identity) {
    // Expire an idle old mapping before this new request claims the session.
    this._cleanupExpired(Date.now());
    return super.markInflight(sessionId, identity);
  }
  _cleanupExpired(now) {
    for (const record of this.records()) {
      if (isExpired(record, now) && !this.busy(record)) this.invalidateByConversation(record.conversationId, "expired");
    }
  }
  lookupByCallId(id) {
    this._cleanupExpired(Date.now());
    const record = super.lookupByCallId(id);
    return record && !isExpired(record, Date.now()) ? record : null;
  }
  claimContinuation(record) {
    if (this.claims.has(record.conversationId)) throw new CatPawError(409, "工具续接正在执行", { fatal: true });
    if (super.lookupByConversation(record.conversationId) !== record) throw CatPawError.badRequest("工具会话已失效");
    const owner = Symbol("continuation");
    this.claims.set(record.conversationId, owner);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.claims.get(record.conversationId) === owner) this.claims.delete(record.conversationId);
      // Remove only the consumed record, never a successful replacement.
      if (super.lookupByConversation(record.conversationId) === record) this.invalidateByConversation(record.conversationId, "continuation-consumed");
    };
  }
  evict() {
    const candidates = this.records().filter(row => !this.busy(row))
      .sort((a, b) => (this.lastSequence.get(a.conversationId) || 0) - (this.lastSequence.get(b.conversationId) || 0));
    if (!candidates.length) throw limit();
    this.invalidateByConversation(candidates[0].conversationId, "bounded-capacity");
  }
  _evictLru() { this.evict(); }
  register(record) {
    record = { ...record, lastActiveAt: Date.now() };
    const size = bytes(record);
    if (size > 1024 * 1024) throw limit();
    this._cleanupExpired(Date.now());
    const replacing = super.lookupByConversation(record.conversationId)
      || record.sessionId && this.sessions.get(record.sessionId);
    for (const callId of record.pendingCallIds) {
      const owner = this.callIndex.get(callId);
      if (owner && owner !== record.conversationId && owner !== replacing?.conversationId) {
        throw new CatPawError(502, "上游工具调用标识冲突", { fatal: true });
      }
    }
    const oldSize = replacing ? bytes(replacing) : 0;
    let count = this.sessions.size + this.anonymous.size + (replacing ? 0 : 1);
    let local = this.bytes() - oldSize + size;
    let global = this.totalBytes() - oldSize + size;
    const candidates = this.records().filter(row => row !== replacing && !this.busy(row))
      .sort((a, b) => (this.lastSequence.get(a.conversationId) || 0) - (this.lastSequence.get(b.conversationId) || 0));
    const victims = [];
    while (count > this.maxRecords || local > this.maxBytes || global > this.globalBytes) {
      const victim = candidates.shift();
      if (!victim) throw limit();
      victims.push(victim);
      const removed = bytes(victim);
      count--; local -= removed; global -= removed;
    }
    // No mutations until the complete admission has succeeded.
    for (const victim of victims) this.invalidateByConversation(victim.conversationId, "bounded-capacity");
    super.register(record);
  }
}
module.exports = { BoundedRegistry };
