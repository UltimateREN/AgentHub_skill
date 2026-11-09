"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { runStdio } = require("../sdk/runtime/provider.cjs");
const { createLoomy } = require("./providers/loomy/provider.cjs");
const { createCline } = require("./providers/cline/provider.cjs");
const { createAutoClaw } = require("./providers/autoclaw/provider.cjs");
const { createCatPaw } = require("./providers/catpaw/provider.cjs");
const { createMonkeyCode } = require("./providers/monkeycode/provider.cjs");
const { createKuku } = require("./providers/kuku/provider.cjs");
const { createAccio } = require("./providers/accio/provider.cjs");
const { createCodeArts } = require("./providers/codearts/provider.cjs");
const { createModelScope } = require("./providers/modelscope/provider.cjs");
const { createLobster } = require("./providers/lobster/provider.cjs");
const { createTrae } = require("./providers/trae/provider.cjs");
const { createRaccoon } = require("./providers/raccoon/provider.cjs");
const { createWorkBuddy } = require("./providers/workbuddy/provider.cjs");
const { createQoder } = require("./providers/qoder/provider.cjs");
const { createZcode } = require("./providers/zcode/provider.cjs");

function settings() {
  const directory = process.env.AGENTHUB_PLUGIN_DATA_DIR;
  if (!directory) return {};
  const filename = path.join(directory, "settings.json");
  try {
    const stat = fs.statSync(filename);
    if (stat.size > 1024 * 1024) throw new Error("Plugin settings exceed limit");
    return JSON.parse(fs.readFileSync(filename, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

const config = settings();
runStdio({ providers: [createLoomy(config.loomy || {}),
  createTrae(config.trae || {}), createRaccoon(config.raccoon || {}),
  createCline("cline_free", config.cline || {}), createCline("cline_pass", config.cline || {}),
  createAutoClaw("autoclaw", config.autoclaw || {}), createAutoClaw("autoclaw_intl", config.autoclaw_intl || {}),
  createCatPaw(config.catpaw || {}), createMonkeyCode("monkeycode", config.monkeycode || {}),
  createMonkeyCode("monkeycode_intl", config.monkeycode_intl || {}), createKuku(config.kuku || {}),
  createAccio("accio", config.accio || {}), createAccio("accio_cn", config.accio_cn || {}),
  createCodeArts(config.codearts || {}), createModelScope(config.modelscope || {}), createLobster(config.lobster || {}),
  createWorkBuddy(config.workbuddy || {}), createQoder("qoder", config.qoder || {}),
  createQoder("qoder_intl", config.qoder_intl || {}), createZcode(config.zcode || {})] });
