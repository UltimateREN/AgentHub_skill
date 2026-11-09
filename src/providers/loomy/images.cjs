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
// 反代网关 · Loomy 图片适配（deepseek 系模型）
//
// deepseek 系模型只认 <image_base64> 标记，标准 OpenAI 的 image_url 会被上游当文本读
// （用户报的「图片被截断 / 不支持图片识别」）；其余模型保持 image_url。
// 判断用客户端请求名（body.model 此刻还没被 wire 改写）：目录名与映射别名都含 deepseek，
// 宽松匹配让两段链路都成立。
"use strict";

// 客户端请求名是否偏好 <image_base64> 标记形态
function prefersTagFormat(requestedModel) {
  return String(requestedModel || "").toLowerCase().includes("deepseek");
}

// 把一个 OpenAI 请求体里的图片块改写为 <image_base64> 文本标记。
// 返回 { body, converted }：深拷贝后改写（渠道回退链复用同一 body，就地改会泄漏给其它渠道）。
function rewriteToTag(body) {
  const out = structuredClone(body || {});
  let converted = 0;
  const messages = Array.isArray(out.messages) ? out.messages : [];
  for (const msg of messages) {
    const content = msg && msg.content;
    if (!Array.isArray(content)) continue;
    const rebuilt = [];
    for (const part of content) {
      const p = part || {};
      const isImage = p.type === "image_url" || p.type === "input_image";
      const urlRaw = p.image_url;
      const url = typeof urlRaw === "string" ? urlRaw : urlRaw && typeof urlRaw === "object" ? urlRaw.url : "";
      if (isImage && typeof url === "string" && url.startsWith("data:")) {
        const comma = url.indexOf(",");
        const b64 = comma >= 0 ? url.slice(comma + 1) : "";
        if (b64) {
          rebuilt.push({ type: "text", text: `<image_base64>${b64}</image_base64>` });
          converted += 1;
          continue;
        }
      }
      rebuilt.push(p);
    }
    msg.content = rebuilt;
  }
  return { body: out, converted };
}

module.exports = { prefersTagFormat, rewriteToTag };
