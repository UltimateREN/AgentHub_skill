/**
 * ============================================================
 *  作者：UltimateREN
 *  日期：2026-11-09
 *  版权声明：本代码归 UltimateREN 所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 增强网关 · 小浣熊思考档位归一（按模型家族把客户端的档位翻成上游认的形态）。
//
// ── 为什么必须归一，而不是原样透传 ────────────────────────────
// 小浣熊的不同模型家族认**完全不同的**思考参数：DeepSeek 系只认开关
// （`thinking: {type}`），GLM-5.3 / Kimi-K3 只认 low/high 两档，
// SenseNova / raccoon 系认 low/medium/high 三档。把 `xhigh` 原样发给只认
// 两档的上游会直接 400；把 `off` 发给认开关的上游同样不认。
//
// 家族表与档位映射来自实测 + Agent2Providers raccoon/reasoning.rs，不是猜的：
//   · sn-deepseek-* / deepseek-*        → thinking 开关
//   · sn-glm-5-3 / sn-kimi-k3           → reasoning_effort: low | high
//   · sn-sensenova-* / raccoon-*        → reasoning_effort: low | medium | high
//   表外模型一律不动（没有已确认的思考参数就不注入，宁可不优化也不乱改字节）。
"use strict";

/** 可翻译给上游的正向档位（由弱到强，下标即强弱序号） */
const EFFORT_LEVELS = Object.freeze(["minimal", "low", "medium", "high", "xhigh", "max"]);
/** 关闭思考的两档：一律不注入正向档位 */
const OFF_LEVELS = Object.freeze(["off", "none"]);

const lower = (value) => String(value || "").trim().toLowerCase();

/** 模型 id 去掉厂商前缀后的小写形态（`vendor/sn-glm-5-3` → `sn-glm-5-3`） */
function modelName(model) {
  const text = String(model || "").trim();
  return lower(text.split("/").pop() || text);
}

/** 模型家族：决定注入哪个字段、档位怎么折叠 */
function family(model) {
  const name = modelName(model);
  if (name.startsWith("sn-deepseek-") || name.startsWith("deepseek-")) return "thinking";
  if (name.startsWith("sn-glm-5-3") || name.startsWith("sn-kimi-k3")) return "low_high";
  if (name.startsWith("sn-sensenova-") || name.startsWith("raccoon-")) return "effort";
  return "";
}

function isThinkingOff(level) {
  return OFF_LEVELS.includes(lower(level));
}

/** 档位 → 强弱序号（0 = 最弱）。表外值与关闭档返回 undefined */
function effortRank(level) {
  const key = lower(level);
  if (!key) return undefined;
  const index = EFFORT_LEVELS.indexOf(key);
  return index >= 0 ? index : undefined;
}

/** 客户端是否已经显式指定了思考参数（并集口径，与示例项目一致） */
function explicitLevel(body) {
  for (const key of ["reasoning_effort", "reasoningEffort", "reasoning", "thinking", "enable_thinking"]) {
    if (body && body[key] !== undefined && body[key] !== null) return true;
  }
  return false;
}

/**
 * 就地归一 body（返回同一个对象，调用方已保证是拷贝）。
 *
 * 只做「客户端写了档位 → 翻成该家族认的形态」；客户端没写就不动
 * （不替用户开思考：默认档位属于用户偏好，插件不该凭空注入）。
 */
function normalize(body, model) {
  if (!body || typeof body !== "object") return body;
  // 驼峰别名先归到蛇形（下游各家客户端写法不统一）
  if (body.reasoning_effort === undefined && body.reasoningEffort !== undefined) {
    body.reasoning_effort = body.reasoningEffort;
    delete body.reasoningEffort;
  }
  const kind = family(model);
  if (!kind) return body;
  const effort = body.reasoning_effort;
  if (kind === "thinking") {
    // 开关家族：只处理「关闭」这一种（正向档位它认不了，删掉即"按默认开"）
    const hasThinking = body.thinking !== undefined && body.thinking !== null;
    if (!hasThinking && typeof effort === "string" && isThinkingOff(effort)) {
      delete body.reasoning_effort;
      body.thinking = { type: "disabled" };
      return body;
    }
    if (!hasThinking && effortRank(effort) !== undefined) {
      delete body.reasoning_effort;
      body.thinking = { type: "enabled" };
    }
    return body;
  }
  if (kind === "low_high") {
    // 两档家族：off/minimal/low → low；medium 及以上 → high
    if (body.thinking?.type === "disabled") {
      delete body.thinking;
      body.reasoning_effort = "low";
      return body;
    }
    const rank = effortRank(effort);
    if (rank !== undefined) body.reasoning_effort = rank <= 1 ? "low" : "high";
    else if (typeof effort === "string" && isThinkingOff(effort)) body.reasoning_effort = "low";
    return body;
  }
  // 三档家族：minimal/low → low，medium → medium，high 及以上 → high
  const rank = effortRank(effort);
  if (rank !== undefined) body.reasoning_effort = rank <= 1 ? "low" : rank === 2 ? "medium" : "high";
  else if (typeof effort === "string" && isThinkingOff(effort)) delete body.reasoning_effort;
  return body;
}

module.exports = { normalize, family, effortRank, isThinkingOff, explicitLevel, modelName, EFFORT_LEVELS, OFF_LEVELS };
