"use strict";

// Execution-side model normalization. The host owns the account-backed model
// catalog; this module only validates the model id sent to Kuku's upstream.
const endpoints = require("./endpoints.cjs");

const FALLBACK_MODEL_IDS = Object.freeze([
  "auto", "gateway-deepseek-v4.1-flash-tencent", "gateway-deepseek-v4-pro-tencent",
  "gateway-deepseek-v4-flash-tencent", "gateway-glm-5.3-flash", "glm-5.3",
  "gateway-glm-5.2", "gateway-glm-5.1-kuaishou", "ernie-5.1", "ms-kimi-k3",
  "gateway-kimi-k2.7-code-tencent", "gateway-kimi-k2.6", "ali-minimax/minimax-m3",
]);

function resolveModel(value) {
  let text = String(value || "").trim();
  if (text.toLowerCase().startsWith("kuku/")) text = text.slice(5).trim();
  if (!text) return endpoints.DEFAULT_MODEL;
  return text;
}

module.exports = { resolveModel, FALLBACK_MODEL_IDS };
