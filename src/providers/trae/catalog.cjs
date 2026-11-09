"use strict";
const FUNCTIONS = Object.freeze(["chat_v3", "solo_work_lite", "solo_agent", "solo_agent_lite", "solo_coder", "solo_work_remote", "solo_agent_remote"]);
const MAX_SUFFIX = "-max";

function text(value) { return typeof value === "string" ? value.trim() : ""; }
function embedded(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") { try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}; } catch {} }
  return {};
}
function positive(value) { const number = Number(value); return Number.isSafeInteger(number) && number > 0 ? number : undefined; }
function detail(entry, tier) {
  const rows = Array.isArray(entry?.model_detail_list) ? entry.model_detail_list : [];
  return rows.find(row => text(row?.model_name).split("__").at(-1) === tier);
}
function displayName(entry) {
  const display = embedded(entry?.display_config);
  return text(display.display_name) || text(entry?.display_name) || text(entry?.display_model_name) || text(entry?.config_name);
}
function selectable(entry) {
  const id = text(entry?.config_name).toLowerCase(), display = embedded(entry?.display_config);
  if (!id || /^(custom_model|search_agent|fast_apply)/.test(id) || ["file_search_agent", "summary", "title_generation", "input_optimization", "laziness_detection"].includes(id)) return false;
  if (["hidden", "disabled", "is_invisible_to_user", "is_custom_model"].some(key => entry?.[key] === true)
    || entry.config_switch === false || display.is_custom_model === true) return false;
  return !text(entry.usage) || text(entry.usage) === "chat_completion";
}
function normalize(payload) {
  const groups = payload?.function_configs || payload?.data?.function_configs;
  if (!Array.isArray(groups)) throw new Error("Trae catalog response has no function_configs");
  const byId = new Map();
  for (const functionName of FUNCTIONS) for (const group of groups.filter(row => row?.function === functionName)) {
    for (const entry of Array.isArray(group.config_info_list) ? group.config_info_list : []) {
      const id = text(entry?.config_name);
      if (!selectable(entry)) continue;
      const key = id.toLowerCase();
      let model = byId.get(key);
      if (!model) {
        const dev = detail(entry, "dev"), display = embedded(entry.display_config), extra = embedded(entry.extra_config);
        const contextLength = positive(entry.context_window_tokens?.dev);
        const maxOutputTokens = positive(dev?.max_tokens) || Math.min(...(Array.isArray(entry.model_detail_list) ? entry.model_detail_list : []).filter(row => !String(row?.model_name || "").endsWith("__max")).map(row => positive(row?.max_tokens)).filter(Boolean));
        const reasoningConfig = embedded(entry.reasoning_effort_config || display.reasoning_effort_config || dev?.reasoning_effort_config);
        model = { id, name: displayName(entry), ...(contextLength ? { contextLength } : {}), ...(Number.isFinite(maxOutputTokens) ? { maxOutputTokens } : {}),
          capabilities: { tools: extra.native_function_call !== false,
            ...(typeof (entry.multimodal ?? display.multimodal ?? dev?.multimodal) === "boolean" ? { images: entry.multimodal ?? display.multimodal ?? dev.multimodal } : {}),
            ...(display.model_capability === "reasoning_model" ? { reasoning: true } : display.model_capability === "chat_model" ? { reasoning: false } : reasoningConfig.options?.length ? { reasoning: true } : {}) }, routes: [] };
        byId.set(key, model);
      }
      const dev = detail(entry, "dev");
      model.routes.push({ function: functionName, configName: id, ...(text(dev?.model_name) ? { modelName: text(dev.model_name) } : {}), ...(positive(dev?.max_tokens) ? { maxTokens: positive(dev.max_tokens) } : {}) });
      const max = detail(entry, "max"), devWindow = positive(entry.context_window_tokens?.dev), maxWindow = positive(entry.context_window_tokens?.max);
      if (max && maxWindow && maxWindow > (devWindow || 0) && !model.max) {
        model.max = { id: `${id}${MAX_SUFFIX}`, name: `${model.name} (Max)`, contextLength: maxWindow,
          ...(positive(max.max_tokens) ? { maxOutputTokens: positive(max.max_tokens) } : {}), capabilities: model.capabilities,
          route: { function: functionName, configName: id, ...(text(max.model_name) ? { modelName: text(max.model_name) } : {}), ...(positive(max.max_tokens) ? { maxTokens: positive(max.max_tokens) } : {}) } };
      }
    }
  }
  const result = [];
  for (const model of byId.values()) {
    if (!model.routes.length) continue;
    result.push(model);
    if (model.max) { model.maxOf = model.id; result.push(model.max); }
    delete model.max;
  }
  if (!result.length) throw new Error("Trae catalog contains no selectable chat models");
  return result;
}
function findModel(catalog, name) {
  const key = String(name || "").trim().toLowerCase();
  return catalog?.find(model => String(model.id).toLowerCase() === key || String(model.name).toLowerCase() === key) || null;
}
module.exports = { FUNCTIONS, MAX_SUFFIX, normalize, findModel };
