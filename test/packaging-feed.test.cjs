/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-11-12
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 板块 4E：分平台 feed 的布局回归。
//
// 要守住的结论（专项 §四 S6.2 的 V2 结案，磁盘为证）：
//   宿主 electron/backend/plugin-feed.cjs 的 plan() 在**平台匹配之前**就用 seen 去重，
//   而 schema:1 的条目只有一个 url。于是
//     ❌「同一个 id 每个平台各出一条」→ 排在前面的平台把后面的静默吞掉（不报错、不更新）
//     ❌「一条目把 platforms 写全」  → 下载到的包内 manifest 只声明单平台，宿主验签必拒
//     ✅「每个平台各一份 feed 文件」  → 本文件锁死这条唯一正确路线
//
// 跑法：node test/packaging-feed.test.cjs
// （CI 的 build 矩阵两步都会跑它；本地没有主仓库同级目录时，宿主相关断言自动跳过并说明）
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { feedFileNamesOf, platformTagOf, feedIndexOf } = require("../tools/build-package.cjs");

const SHA = "a".repeat(64);
const MANIFEST = {
  id: "com.agenthub.forwarding-suite",
  name: "模型增强执行器",
  version: "0.2.8",
  runtime: { kind: "node", platforms: [{ os: "linux", arch: "x64", libc: "glibc" }] },
};

// 主仓库与本仓库是同级的独立仓库（E:\idea work\AgentHub 与 E:\idea work\AgentHub_skill）。
// 找不到就跳过「用宿主真实解析器复核」这一段——CI 上只 clone 本仓库，属于预期情况。
function tryLoadHostFeed() {
  const candidates = [
    path.join(__dirname, "..", "..", "AgentHub", "electron", "backend", "plugin-feed.cjs"),
    process.env.AGENTHUB_HOST_FEED && path.resolve(process.env.AGENTHUB_HOST_FEED),
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) return { feed: require(p), file: p };
  }
  return null;
}

// ===== ① 命名：每个平台一份，且不带后缀的桌面地址只有 win32/x64 能写 =====
function checkFileNames() {
  assert.deepEqual(platformTagOf({ os: "win32", arch: "x64" }), "win32-x64");
  assert.deepEqual(platformTagOf({ os: "linux", arch: "x64", libc: "glibc" }), "linux-x64-glibc");
  assert.deepEqual(platformTagOf({ os: "linux", arch: "arm64", libc: "musl" }), "linux-arm64-musl");

  assert.deepEqual(feedFileNamesOf({ os: "win32", arch: "x64" }),
    ["plugin-index-win32-x64.json", "plugin-index.json"],
    "桌面 DEFAULT_FEED 用的 plugin-index.json 必须由 win32/x64 构建继续产出（桌面零影响）");
  for (const t of [{ os: "linux", arch: "x64", libc: "glibc" }, { os: "linux", arch: "arm64", libc: "glibc" }, { os: "darwin", arch: "arm64" }]) {
    const names = feedFileNamesOf(t);
    assert.ok(!names.includes("plugin-index.json"),
      `${t.os}/${t.arch} 构建绝不允许写不带后缀的索引——那会覆盖桌面的自动更新地址`);
    assert.equal(names.length, 1);
    assert.equal(names[0], `plugin-index-${platformTagOf(t)}.json`);
  }
  console.log("PASS ① feed 文件名：每平台一份；plugin-index.json 只归 win32-x64（linux 构建覆盖不到桌面）");
}

// ===== ② 单平台索引必须被宿主解析器接受，并且本平台匹配、他平台不匹配 =====
function checkAgainstHostParser() {
  const host = tryLoadHostFeed();
  if (!host) { console.log("SKIP ②③ 未找到主仓库 plugin-feed.cjs（本仓库单独 clone 时属正常），宿主断言跳过"); return false; }
  const { feed, file } = host;
  console.log(`      宿主解析器：${path.relative(path.join(__dirname, "..", ".."), file)}`);

  const linuxIndex = feedIndexOf(MANIFEST, "com.agenthub.forwarding-suite-0.2.8-linux-x64-glibc.zip",
    { repo: "UltimateREN/AgentHub_skill", releaseTag: "v0.2.8", sha256: SHA });
  const entries = feed.parseIndex(Buffer.from(JSON.stringify(linuxIndex)));
  assert.equal(entries.length, 1);
  // linux 容器：命中，且 url 指向 glibc 包
  const onLinux = feed.plan(entries, { installed: new Map(), settings: { autoDownload: true }, target: { os: "linux", arch: "x64", libc: "glibc" } });
  assert.equal(onLinux.length, 1, "linux/glibc 容器应能从 linux feed 取到条目");
  assert.match(onLinux[0].url, /linux-x64-glibc\.zip$/);
  // 桌面 windows：同一份 linux feed 不该给出条目（拿错包比拿不到更糟）
  const onWin = feed.plan(entries, { installed: new Map(), settings: { autoDownload: true }, target: { os: "win32", arch: "x64", libc: undefined } });
  assert.deepEqual(onWin, [], "win32 不得消费 linux feed");
  // musl 机器不吃 glibc 包
  const onMusl = feed.plan(entries, { installed: new Map(), settings: { autoDownload: true }, target: { os: "linux", arch: "x64", libc: "musl" } });
  assert.deepEqual(onMusl, [], "musl 不得消费 glibc 包（原生 .node 装不上）");
  console.log("PASS ② 单平台 feed 被宿主 parseIndex/plan 接受：linux 命中、win32 与 musl 均不命中");

  // ===== ③ 反证：把两个平台塞进同一份索引（同 id 两条）→ 后出现的那条被静默吞掉 =====
  // 专项 V2 结案原文：「若 win32 那条在前，Linux 容器 seen 已占用该 id，
  // 后面的 linux 条目被静默忽略（不报错、不更新）」。这里把两侧都验一遍。
  const base = { ...linuxIndex.plugins[0], sha256: SHA };
  const winEntry = { ...base, platforms: [{ os: "win32", arch: "x64" }], url: "https://github.com/x/releases/download/v0.2.8/pkg-win32-x64.zip" };
  const lnxEntry = { ...base, platforms: [{ os: "linux", arch: "x64", libc: "glibc" }], url: "https://github.com/x/releases/download/v0.2.8/pkg-linux-x64-glibc.zip" };
  assert.equal(winEntry.id, lnxEntry.id, "这条反证的前提是同 id 两条");
  const LINUX = { os: "linux", arch: "x64", libc: "glibc" };
  const WIN = { os: "win32", arch: "x64", libc: undefined };
  const planFor = (list, target) => feed.plan(feed.parseIndex(Buffer.from(JSON.stringify({ schema: 1, plugins: list }))),
    { installed: new Map(), settings: { autoDownload: true }, target });

  // 顺序 A：win32 在前 → linux 容器一条都拿不到（不是拿错包，是根本不更新）
  const aLinux = planFor([winEntry, lnxEntry], LINUX);
  assert.deepEqual(aLinux, [], "win32 在前时，linux 条目被 seen 吞掉 → 容器静默不更新");
  // 顺序 B：linux 在前 → 桌面反过来受害（同一条规则，谁在前谁活）
  const bWin = planFor([lnxEntry, winEntry], WIN);
  assert.deepEqual(bWin, [], "linux 在前时，win32 条目被 seen 吞掉 → 桌面静默不更新");
  // 对照组：分成两份 feed 文件时，两侧各自都能取到自己的包
  const winIndex = { schema: 1, plugins: [winEntry] };
  const lnxIndex = { schema: 1, plugins: [lnxEntry] };
  assert.equal(planFor(winIndex.plugins, WIN).length, 1, "桌面读桌面那份 feed：拿得到");
  assert.equal(planFor(lnxIndex.plugins, LINUX).length, 1, "容器读容器那份 feed：拿得到");
  console.log("PASS ③ 反证成立：同 id 多平台条目 = 排在后面那个平台静默拿不到任何更新（两个方向都验），"
    + "分文件才两侧都能取到 → 禁止同 id 多条目已钉成回归");
  return true;
}

// ===== ④ minimumVersion / minHostVersion 只在显式给出时进索引 =====
function checkVersionGates() {
  const before = { min: process.env.AGENTHUB_PLUGIN_MINIMUM_VERSION, host: process.env.AGENTHUB_PLUGIN_MIN_HOST_VERSION };
  try {
    delete process.env.AGENTHUB_PLUGIN_MINIMUM_VERSION;
    delete process.env.AGENTHUB_PLUGIN_MIN_HOST_VERSION;
    const empty = feedIndexOf(MANIFEST, "pkg.zip", { repo: "r", releaseTag: "v1", sha256: SHA }).plugins[0];
    assert.equal(empty.minimumVersion, "", "默认不强制升级（容器无桌面兜底，强制窗口要保守）");
    assert.equal(empty.minHostVersion, "");
    process.env.AGENTHUB_PLUGIN_MINIMUM_VERSION = "0.2.5";
    process.env.AGENTHUB_PLUGIN_MIN_HOST_VERSION = "2.0.5";
    const set = feedIndexOf(MANIFEST, "pkg.zip", { repo: "r", releaseTag: "v1", sha256: SHA }).plugins[0];
    assert.equal(set.minimumVersion, "0.2.5");
    assert.equal(set.minHostVersion, "2.0.5");
  } finally {
    if (before.min === undefined) delete process.env.AGENTHUB_PLUGIN_MINIMUM_VERSION; else process.env.AGENTHUB_PLUGIN_MINIMUM_VERSION = before.min;
    if (before.host === undefined) delete process.env.AGENTHUB_PLUGIN_MIN_HOST_VERSION; else process.env.AGENTHUB_PLUGIN_MIN_HOST_VERSION = before.host;
  }
  console.log("PASS ④ minimumVersion/minHostVersion 缺省为空，仅由 CI 变量显式注入");
}

// ===== ⑤ 平台裁剪：从 build-package.cjs 里取**原样那段表达式**来跑 =====
// 本机没有 linux（也无 Docker），但这段逻辑是本次唯一「按构建机分支」的地方，
// 不能只靠"逻辑没改"一句话。做法：把源码里的那段 filter 抠出来当函数跑，
// 保证测的是仓库真身，而不是我在测试里重写的一份副本。
function checkPlatformTrim() {
  const src = fs.readFileSync(path.join(__dirname, "..", "tools", "build-package.cjs"), "utf8");
  // 谓词跨两行，正则容易截断 → 按括号配对把 .filter(...) 的实参原样取出来
  const marker = "template.runtime.platforms.filter(";
  const at = src.indexOf(marker);
  assert.ok(at >= 0, "build-package.cjs 里的平台裁剪表达式找不到（改了写法就要同步改这条断言）");
  let depth = 0, end = -1;
  for (let i = at + marker.length - 1; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")") { depth--; if (depth === 0) { end = i; break; } }
  }
  assert.ok(end > 0, "filter 调用的括号没配上");
  const predicate = src.slice(at + marker.length, end);
  const trim = new Function("item", "target", `return (${predicate})(item, target);`);
  const declared = require("../manifest.template.json").runtime.platforms;
  assert.ok(declared.length >= 4, "模板应声明多平台，否则这段裁剪没有意义");
  for (const t of [
    { os: "win32", arch: "x64", name: "win32-x64" },
    { os: "linux", arch: "x64", libc: "glibc", name: "linux-x64-glibc" },
    { os: "linux", arch: "arm64", libc: "glibc", name: "linux-arm64-glibc" },
  ]) {
    const kept = declared.filter(item => trim(item, t));
    assert.equal(kept.length, 1, `${t.os}/${t.arch}${t.libc ? "/" + t.libc : ""} 应只裁出一条平台声明，实际 ${JSON.stringify(kept)}`);
    assert.equal(kept[0].os, t.os);
    assert.equal(kept[0].arch, t.arch);
    // 与 feed 文件名的标签一致：索引里写的平台 = 这个包能装的平台
    assert.equal(`plugin-index-${[t.os, t.arch, t.libc].filter(Boolean).join("-")}.json`, `plugin-index-${t.name}.json`);
  }
  // musl 机器不得吃 glibc 包（build-package 与宿主同一套 libc 口径）
  const glibcItem = declared.find(item => item.os === "linux" && item.arch === "x64" && item.libc === "glibc");
  assert.equal(trim(glibcItem, { os: "linux", arch: "x64", libc: "musl" }), false, "musl 构建机不得保留 glibc 声明");
  console.log("PASS ⑤ 平台裁剪（仓库原样表达式）：win32/x64、linux/x64/glibc、linux/arm64/glibc 各裁出一条；musl 不吃 glibc");
}

function main() {
  checkFileNames();
  checkAgainstHostParser();
  checkVersionGates();
  checkPlatformTrim();
  console.log("PASS packaging feed: 分平台 feed 布局与宿主 plugin-feed 语义一致（V2 结案已钉成回归）");
}
main();
