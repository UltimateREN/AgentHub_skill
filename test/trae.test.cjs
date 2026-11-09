"use strict";
const assert = require("node:assert/strict");
const { rewrite, mapModel, createTrae } = require("../src/providers/trae/provider.cjs");
const { normalize, findModel } = require("../src/providers/trae/catalog.cjs");
assert.deepEqual(mapModel("DeepSeek_V4", { modelMap: { "deepseek-v4": ["DeepSeek-V4", "deepseek_v4__dev"] } }), { configName: "DeepSeek-V4", modelName: "deepseek_v4__dev" });
const body = rewrite("deepseek-v4", { messages: [{ role: "user", content: "hi" }], tool_choice: "none" }, { uid: "u", accountId: "a" }, { modelMap: { "deepseek-v4": ["DeepSeek-V4", "deepseek_v4__dev"] } });
assert.equal(body.config_name, "DeepSeek-V4"); assert.equal(body.messages[0].content[0].text, "hi"); assert.equal(body.tools, undefined);
assert.equal(createTrae().id, "trae");
const remote = normalize({ function_configs: [
  { function: "solo_work_lite", config_info_list: [
    { config_name: "glm-live", display_name: "GLM Live", config_switch: true, usage: "chat_completion",
      context_window_tokens: { dev: 128000, max: 512000 }, multimodal: true,
      model_detail_list: [{ model_name: "glm-live__dev", max_tokens: 8192 }, { model_name: "glm-live__max", max_tokens: 32768 }] },
    { config_name: "hidden-agent", hidden: true, model_detail_list: [{ model_name: "hidden-agent__dev" }] },
  ] },
  { function: "solo_coder", config_info_list: [
    { config_name: "glm-live", display_name: "GLM Live", config_switch: true, usage: "chat_completion",
      model_detail_list: [{ model_name: "glm-live-coder__dev", max_tokens: 4096 }] },
  ] },
] });
assert.deepEqual(remote.map(row => row.id), ["glm-live", "glm-live-max"]);
assert.equal(remote[0].contextLength, 128000);
assert.equal(remote[0].maxOutputTokens, 8192);
assert.equal(remote[0].routes.length, 2, "same public model retains per-function execution candidates");
assert.equal(remote[1].route.function, "solo_work_lite");
assert.equal(findModel(remote, "GLM LIVE").id, "glm-live");
const routed = rewrite("glm-live", { messages: [{ role: "user", content: "hi" }], max_tokens: 10000 }, { uid: "u" }, {}, remote[0].routes[0]);
assert.equal(routed.function, "solo_work_lite");
assert.equal(routed.model_name, "glm-live__dev");
assert.equal(routed.max_tokens, 8192);
console.log("trae provider tests passed");
