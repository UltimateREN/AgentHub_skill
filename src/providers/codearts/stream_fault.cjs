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
// 反代网关 · CodeArts 流内错误信封：失败有时不体现在 HTTP 状态上。
//
// 上游把「福利额度用尽」这类失败塞在 HTTP 200 的 SSE 体里：流干净地开始、干净地结束，
// 中间只有一帧 {"error_code":"InferHub.4291.200","error_msg":"insufficient quota"}。只看 HTTP 状态
// 就成了「成功但一个字都没答」——而跨账号降级链的触发条件完全依赖错误分类是否正确，分类错了
// 编排层就不会换下一个账号，用户拿到一个假成功。所以这套判定权重最高。
//
// 三条不能想当然的规则：
//   1. error_code 为空、或 ∈ {0, 0000, success} 不算故障（这三个值是这套信封的「成功」写法）；
//   2. 同一帧里只要带了任何答案，就绝不判故障（delta.content / reasoning_content / tool_calls /
//      choices[].text / 非 [DONE] 的 text 都算答案）——带错误码又带内容的帧，丢内容比漏报故障更糟；
//   3. details[] 只取一条「短且不含冒号」的（里面装的是 requestId:/traceId: 这类 trace 装饰，
//      含冒号的一律跳过）。
// 分类：insufficient quota → 403（额度，换账号）；含 429 / rate limit / too many → 429；其余 → 502。
"use strict";

const DONE_SENTINEL = "[DONE]";

function isSuccessCode(code) {
  const c = String(code || "").toLowerCase();
  return c === "0" || c === "0000" || c === "success";
}

// 一个 delta 里带的答案内容；null / 空 / 只有 role 的 delta 都算「没内容」
function deltaHasContent(delta) {
  if (!delta || typeof delta !== "object") return false;
  const content = delta.content;
  if (typeof content === "string") return content.length > 0;
  if (Array.isArray(content)) return content.some((p) => p && typeof p.text === "string" && p.text.length > 0);
  if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) return true;
  return Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0;
}

function choicesHaveContent(choices) {
  if (!Array.isArray(choices)) return false;
  return choices.some((choice) =>
    deltaHasContent(choice && choice.delta) ||
    deltaHasContent(choice && choice.message) ||
    (choice && typeof choice.text === "string" && choice.text.length > 0));
}

// 判一帧（已去掉 data: 前缀并解成 JSON 的载荷）是不是故障帧；宁可漏报一帧，也不要把内容丢掉
function streamFrameFault(payload) {
  const trimmed = String(payload || "").trim();
  if (!trimmed || trimmed === DONE_SENTINEL) return null;
  let frame;
  try { frame = JSON.parse(trimmed); } catch { return null; }
  if (!frame || typeof frame !== "object") return null;
  const code = String(frame.error_code || "").trim();
  if (!code || isSuccessCode(code)) return null;

  // 有答案就不算故障（规则 2），三个位置都要看
  const text = typeof frame.text === "string" ? frame.text.trim() : "";
  const hasAnswer =
    deltaHasContent(frame.delta) ||
    choicesHaveContent(frame.choices) ||
    (text && text !== DONE_SENTINEL);
  if (hasAnswer) return null;

  let message = `上游报告 ${code}`;
  const errorMsg = typeof frame.error_msg === "string" ? frame.error_msg.trim() : "";
  if (errorMsg) message += `：${errorMsg}`;
  // details 只认一条「短且不含冒号」的补充说明
  if (Array.isArray(frame.details)) {
    for (const item of frame.details) {
      const detail = String((item && (item.error_msg || item.error_code)) || "").trim();
      if (!detail || message.includes(detail) || detail.includes(":")) continue;
      message += `（${detail}）`;
      break;
    }
  }
  if (message.toLowerCase().includes("benefit not found")) {
    message += "（该账号还没有福利档案，余额查询会自动向官方注册，稍等片刻重试即可）";
  }
  const lowered = message.toLowerCase();
  let status = 502;
  if (lowered.includes("insufficient quota")) status = 403;
  else if (code.includes("429") || lowered.includes("rate limit") || lowered.includes("too many")) status = 429;
  return { code, message, status };
}

// 把流内故障转成带分类状态码的错误（额度/限流让编排层换账号，而不是普通失败）
function faultToError(fault) {
  const err = Object.assign(new Error(fault.message), { status: fault.status, code: fault.code });
  if (fault.status === 403) err.code = "insufficient_quota";
  if (fault.status === 429) err.code = "rate_limit_exceeded";
  return err;
}

module.exports = { streamFrameFault, faultToError, DONE_SENTINEL };
