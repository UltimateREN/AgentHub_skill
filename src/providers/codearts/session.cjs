/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-21
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 反代网关 · CodeArts 会话并发闸：每账号上游只有 3 路并发会话。
//
// 顺序是有意的：先过本地准入再占上游会话。反过来一个满员的账号会白占一个上游槽位并立刻释放，
// 把并发闸变成噪声。满员回 409，不冷却账号（这是并发，不是故障）。
//
// 身份优先用凭据里的 domain_id + user_id；两个都取不到时退到账号行 id（不是 AK —— AK 每次续期都换，
// 用它当键等于每刷一次期就把并发上限清零）。面板的「并发上限」旋钮写的是账号上的 maxConcurrent，必须读它。
"use strict";

const DEFAULT_SESSION_LIMIT = 3;

// 进程级本地准入闸：identity -> 当前在占会话数
const gate = new Map();

function limitFor(override) {
  const n = Number(override);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_SESSION_LIMIT;
}

// 准入：满员返回 { acquired:false, status:409 }，否则占一个名额
function acquire(identity, override) {
  const key = String(identity || "anon");
  const limit = limitFor(override);
  const cur = gate.get(key) || 0;
  if (cur >= limit) return { acquired: false, status: 409, message: `该账号已达并发上限（${limit} 路）` };
  gate.set(key, cur + 1);
  return { acquired: true, release: () => release(key) };
}

function release(identity) {
  const key = String(identity || "anon");
  const cur = gate.get(key) || 0;
  if (cur <= 1) gate.delete(key);
  else gate.set(key, cur - 1);
}

// 会话身份：domain+user 优先，退账号行 id
function identityOf(credential, accountId) {
  const domain = String((credential && credential.domain_id) || "").trim();
  const user = String((credential && credential.user_id) || "").trim();
  if (domain && user) return `${domain}:${user}`;
  return `account:${accountId}`;
}

module.exports = { acquire, release, identityOf, DEFAULT_SESSION_LIMIT };
