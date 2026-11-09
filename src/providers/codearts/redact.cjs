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
// 反代网关 · CodeArts 出站错误脱敏：上游有时把被拒的凭据或请求头原文回显在错误体里，
// 而这份错误体会一路冒到客户端与请求日志。一处回显就够把一份 AK/SK/STS、一份 refresh token、
// 一把 DPoP 私钥交给所有能看到日志的人。
//
// 四个要点：
//   1. 同一份秘密要盖三种拼法：原文、URL 编码形、JSON 字符串转义形 —— 少盖一种就等于没盖；
//   2. 长的先盖：完整令牌先于它的任何子串被替换；
//   3. 截断会切在秘密中间：错误体有上限，最后一截可能是某个秘密的前缀，要按后缀匹配把残段也盖掉；
//   4. 盖上之后不再比对原文：替换成 [REDACTED] 后再做下一次 contains 判断。
// 空串必须剔除（"abc".replace("", "X") 得到 "XaXbXc"，一条空秘密就足以毁掉整条错误消息）。
"use strict";

// 从一轮请求里收集要盖的秘密（AK/SK/STS/refresh_token + OAuth 上下文里的 DPoP 私钥 d / 公钥 x/y）
function secretMaterial(credential) {
  const out = [];
  const push = (v) => {
    const s = String(v || "").trim();
    if (s && s.length >= 8) out.push(s);
  };
  if (credential) {
    push(credential.access_key_id);
    push(credential.secret_access_key);
    push(credential.security_token);
    push(credential.refresh_token);
    const ctx = credential.oauth_context;
    if (ctx && ctx.dpop_key_pair) {
      const priv = ctx.dpop_key_pair.private_key_jwk || {};
      push(priv.d);
      push(priv.x);
      push(priv.y);
    }
  }
  return out;
}

// 把文本里出现的秘密逐个盖掉；suffixMatch=true 时按后缀匹配（覆盖截断切在秘密中间的残段）
function redactValues(text, secrets, suffixMatch) {
  let out = String(text == null ? "" : text);
  // 长的先盖：按长度降序，完整令牌先于子串被替换
  const sorted = [...secrets].filter(Boolean).sort((a, b) => b.length - a.length);
  for (const secret of sorted) {
    const variants = [secret];
    try { variants.push(encodeURIComponent(secret)); } catch { /* 忽略不可编码项 */ }
    try { variants.push(JSON.stringify(secret).slice(1, -1)); } catch { /* 忽略 */ }
    for (const variant of variants) {
      if (!variant) continue;
      if (suffixMatch) {
        // 残段覆盖：从长到短尝试匹配 secret 的后缀
        for (let len = variant.length; len >= 8; len--) {
          const tail = variant.slice(variant.length - len);
          if (out.includes(tail)) {
            out = out.split(tail).join("[REDACTED]");
            break;
          }
        }
      } else if (out.includes(variant)) {
        out = out.split(variant).join("[REDACTED]");
      }
    }
  }
  return out;
}

module.exports = { redactValues, secretMaterial };
