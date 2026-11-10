/**
 * 作者：UltimateREN
 * 版权声明：本代码归 UltimateREN 所有。禁止滥用本人代码（含用于违法违规、恶意攻击、
 * 侵犯他人权益等用途）；禁止在未经本人授权的情况下直接搬运本代码（含复制、
 * 转载、用于商业项目）。此注释为版权与授权声明，禁止删除。
 * stableConvId retained from the original execution utility.
 */
"use strict";
const crypto = require("node:crypto");
function stableConvId(messages) {
  try {
    const head = (Array.isArray(messages) ? messages : []).slice(0, 3)
      .map(m => String(m && m.role || "") + ":" + (typeof (m && m.content) === "string" ? m.content : JSON.stringify((m && m.content) ?? null))).join("|");
    if (!head || head === "||") return "";
    return crypto.createHash("sha256").update(head).digest("hex").slice(0, 16);
  } catch { return ""; }
}
module.exports = { uuid: () => crypto.randomUUID(), stableConvId };
