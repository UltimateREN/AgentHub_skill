"use strict";
// 插件诊断日志：只在失败路径写，落 `$AGENTHUB_PLUGIN_DATA_DIR/logs/plugin.log`
//
// ── 为什么需要它 ──────────────────────────────────────────────
// 宿主只统计 stderr 的字节数、不落库（见主程序 extensions/stdio-transport.cjs 的注释：
// 原始插件诊断可能含上游正文与标识）。于是插件侧一旦失败，宿主日志里只剩一个笼统的
// UPSTREAM_FAILED —— 哪家渠道、什么状态码、哪一步全丢了，排障只能靠猜。
//
// ── 三条硬约束 ────────────────────────────────────────────────
//   ① stdout 是协议通道，绝不能写（会污染 JSON-RPC 帧，宿主解析即崩）；
//   ② 只记元数据：provider / channel / 错误码 / 类别 / 状态码 / 耗时。
//      prompt、正文、token、Cookie、URL 一律不记；
//   ③ 写盘失败绝不反噬调用（全路径 try/catch，最坏情况是这条日志没落下来）。
//
// ── 滚动 ──────────────────────────────────────────────────────
// 单文件 2 MiB，超了改名成 `.1`（只留一代）。日志不是审计数据，够定位一次故障即可。
const fs = require("node:fs");
const path = require("node:path");

const MAX_BYTES = 2 * 1024 * 1024;
const FILE = "plugin.log";
const MAX_LINE = 500;

function logDir() {
  const base = process.env.AGENTHUB_PLUGIN_DATA_DIR;
  return base ? path.join(base, "logs") : "";
}

function rotate(file) {
  try {
    const st = fs.statSync(file);
    if (st.size < MAX_BYTES) return;
    fs.renameSync(file, `${file}.1`);
  } catch {
    /* 文件不存在 / 改名失败：下一次写入会继续追加，不影响功能 */
  }
}

function write(level, scope, message) {
  const dir = logDir();
  if (!dir) return; // 没有数据目录（如宿主自测直接起进程）：静默跳过
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, FILE);
    rotate(file);
    const line = `${new Date().toISOString()} [${level}] [${scope}] ${String(message).slice(0, MAX_LINE)}\n`;
    fs.appendFileSync(file, line, "utf8");
  } catch {
    /* 诊断写盘失败不影响模型调用 */
  }
}

module.exports = {
  info: (scope, message) => write("info", scope, message),
  warn: (scope, message) => write("warn", scope, message),
  error: (scope, message) => write("error", scope, message),
  /** 日志文件绝对路径（宿主/自测想知道去哪儿看时用；没有数据目录返回空串） */
  file: () => {
    const dir = logDir();
    return dir ? path.join(dir, FILE) : "";
  },
};
