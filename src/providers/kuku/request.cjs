"use strict";

/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-10-29
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *  此注释为版权与授权声明，禁止删除。
 * ============================================================
 */

// The host has already parsed and policy-filtered this projection. This module
// only serializes trusted fields for Kuku's outbound request shape; it never
// accepts or parses a raw Cookie string.
const endpoints = require("./endpoints.cjs");

function cookieHeader(credential) {
  const bduss = String(credential?.bduss || "").trim();
  if (!bduss) throw Object.assign(new Error("Kuku execution material is missing BDUSS"), { status: 401 });
  const parts = [`BDUSS=${bduss}`];
  const stoken = String(credential?.stoken || "").trim();
  if (stoken) parts.push(`STOKEN=${stoken}`);
  for (const item of credential?.extras || []) {
    if (!Array.isArray(item) || item.length !== 2) continue;
    const name = String(item[0] || "").trim();
    const value = String(item[1] || "").trim();
    if (name && value && !/^(?:bduss|stoken|gfprotpl)$/i.test(name)) parts.push(`${name}=${value}`);
  }
  parts.push("gfprotpl=genflowpro");
  return parts.join("; ");
}

function requestHeaders(credential, accept) {
  const headers = {
    Cookie: cookieHeader(credential),
    "User-Agent": endpoints.USER_AGENT,
    Referer: endpoints.referer(),
    Origin: endpoints.baseUrl(),
    "Accept-Language": "zh-CN,zh;q=0.9",
  };
  if (accept) headers.Accept = accept;
  return headers;
}

module.exports = { cookieHeader, requestHeaders };
