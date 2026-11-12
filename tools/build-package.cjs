"use strict";
// Build a signed AgentHub schema-2 package. The private key is supplied by the
// release environment; it is never committed to this repository.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { createRequire } = require("node:module");

const root = path.resolve(__dirname, "..");
const out = path.resolve(process.argv[2] || path.join(root, "dist"));
const keyId = process.env.AGENTHUB_PLUGIN_KEY_ID || "agenthub-release-2026";
// 私钥**不在顶层加载**：一来缺 key 时命令行仍在做任何事之前失败（原来也是这个顺序，只是挪进 main），
// 二来 feed/签名的纯函数要能被测试 require 到（test/packaging-feed.test.cjs）。
function loadPrivateKey() {
  const keyFile = process.env.AGENTHUB_PLUGIN_SIGNING_KEY || process.argv[3];
  if (!keyFile) throw new Error("Set AGENTHUB_PLUGIN_SIGNING_KEY to an Ed25519 PEM private key");
  const privateKey = crypto.createPrivateKey(fs.readFileSync(path.resolve(keyFile)));
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("Signing key must be Ed25519");
  return privateKey;
}

function json(value, depth = 0) {
  if (depth > 32) throw new Error("manifest too deep");
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number") { if (!Number.isFinite(value)) throw new Error("non-finite manifest number"); return; }
  if (!Array.isArray(value) && typeof value !== "object") throw new Error("invalid manifest value");
  for (const [k, v] of Object.entries(value)) { if (["__proto__", "constructor", "prototype"].includes(k)) throw new Error("unsafe manifest key"); json(v, depth + 1); }
}
function canonical(value) {
  json(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
function signingPayload(manifest) {
  const unsigned = { ...manifest }; delete unsigned.signature;
  return Buffer.from("AgentHub plugin package\0schema2\0sorted-json-v1\0" + canonical(unsigned));
}
function files(dir, prefix = "", includeRuntimeDependencies = false) {
  const result = [];
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (item.name === "dist" || item.name === ".git" || item.name === ".release" || item.name === "manifest.json"
      || item.name === "manifest.template.json" || item.name === "test" || item.name === "tools"
      || item.name === "package-lock.json" || item.name === "package.json") continue;
    // 符号链接不进包：7za 会把链接目标打进去，但这里按文件系统枚举不到，清单和包就会对不上
    if (item.isSymbolicLink()) continue;
    if (item.name === "node_modules" && !includeRuntimeDependencies) continue;
    const abs = path.join(dir, item.name), rel = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) result.push(...files(abs, rel, includeRuntimeDependencies));
    else if (item.isFile()) result.push([rel, abs]);
  }
  return result;
}
function copyTree(stage) {
  try { fs.rmSync(stage, { recursive: true, force: true }); }
  catch { console.warn(`清理 ${stage} 失败，继续覆盖写入`); }
  fs.mkdirSync(stage, { recursive: true });
  // 运行时依赖也在同一份清单里枚举，避免「复制一份、打包另一份」对不上
  for (const [rel, abs] of files(root, "", true)) {
    const dest = path.join(stage, ...rel.split("/"));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(abs, dest);
  }
}
function run(exe, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { stdio: "inherit", windowsHide: true, ...options });
    child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(new Error(`${exe} exited ${code}`)));
  });
}

/** 构建机的平台标签：win32-x64 / linux-x64-glibc / linux-arm64-musl … */
function platformTagOf(target) {
  return [target.os, target.arch, target.libc].filter(Boolean).join("-");
}

/**
 * 本次构建该写出哪些 feed 文件名。
 *
 * 为什么分平台出文件、而不是「同一个 id 每个平台各出一条」：
 * 宿主 electron/backend/plugin-feed.cjs:58-62 的 plan() 在**平台匹配之前**就用 seen 去重，
 * 而 schema:1 的条目只有一个 url —— 同 id 多条时，排在前面的那条会把后面的静默吃掉
 * （Linux 容器会拿到 win32 的 url，或反之），且不会报错。这是专项 §四 S6.2 的 V2 结案。
 *
 * 因此：
 *   · 每个平台各写一份 `plugin-index-<平台标签>.json`（url 指向本平台自己的 zip）；
 *   · 桌面 DEFAULT_FEED 用的**不带后缀**的 `plugin-index.json` 只由 win32/x64 构建写出，
 *     linux 构建绝不覆盖它 → 桌面自动更新链路零影响（专项 §六 验收 6）。
 * 容器侧用 `PUT /api/plugins/feed` 指向 `plugin-index-linux-x64-glibc.json` 即可。
 */
function feedFileNamesOf(target) {
  const names = [`plugin-index-${platformTagOf(target)}.json`];
  if (target.os === "win32" && target.arch === "x64") names.push("plugin-index.json");
  return names;
}

/** 一份 schema:1 索引（单条目 = 本构建产物）。sha256 由调用方在 zip 落盘后算。 */
function feedIndexOf(manifest, assetName, { repo, releaseTag, sha256 }) {
  return {
    schema: 1,
    plugins: [{
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      // minimumVersion 留空表示不强制升级；填了之后低于它的安装会被强制补齐，不受自动更新开关影响。
      minimumVersion: process.env.AGENTHUB_PLUGIN_MINIMUM_VERSION || "",
      minHostVersion: process.env.AGENTHUB_PLUGIN_MIN_HOST_VERSION || "",
      platforms: manifest.runtime.platforms,
      url: `https://github.com/${repo}/releases/download/${releaseTag}/${assetName}`,
      sha256,
    }],
  };
}

async function main() {
  const privateKey = loadPrivateKey();   // 缺 key / 非 Ed25519 时在做任何工作之前失败
  const stage = path.join(out, "stage");
  copyTree(stage);
  const template = JSON.parse(fs.readFileSync(path.join(root, "manifest.template.json"), "utf8"));
  // 原生依赖是签名运行时闭包的一部分，插件装好后不能依赖 AgentHub 的 node_modules。
  // copyTree 已把 node_modules 一起复制（跳过符号链接），这里只做一次加载自检。
  const stagedRequire = createRequire(path.join(stage, "src", "main.cjs"));
  for (const dependency of Object.keys(require(path.join(root, "package.json")).dependencies || {})) stagedRequire(dependency);
  const target = { os: process.platform, arch: process.arch };
  if (target.os === "linux") target.libc = process.report.getReport().header.glibcVersionRuntime ? "glibc" : "musl";
  template.runtime.platforms = template.runtime.platforms.filter(item => item.os === target.os && item.arch === target.arch
    && (item.libc === undefined || item.libc === target.libc));
  if (!template.runtime.platforms.length) throw new Error(`No manifest runtime target for ${target.os}/${target.arch}`);
  const packageFiles = files(stage, "", true).sort(([a], [b]) => a.localeCompare(b));
  const manifest = { ...template, files: Object.fromEntries(packageFiles.map(([rel, abs]) => [rel, crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex")])) };
  manifest.signature = { algorithm: "ed25519", keyId, value: crypto.sign(null, signingPayload(manifest), privateKey).toString("base64") };
  fs.writeFileSync(path.join(stage, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  fs.mkdirSync(out, { recursive: true });
  const platformTag = platformTagOf(target);
  const archive = path.join(out, `${manifest.id}-${manifest.version}-${platformTag}.zip`);
  fs.rmSync(archive, { force: true });
  const seven = process.env.AGENTHUB_7ZA || path.resolve(root, "..", "AgentHub", "node_modules/7zip-bin/win/x64/7za.exe");
  await run(seven, ["a", "-tzip", "-mx=9", archive, "."], { cwd: stage });
  try { fs.rmSync(stage, { recursive: true, force: true }); }
  catch { console.warn(`临时目录 ${stage} 未清理，下次构建前可手动删除`); }
  fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  // 官方更新清单：主程序按它判断版本、平台和下载地址（写出哪几份见 feedFileNamesOf 的说明）。
  const repo = process.env.AGENTHUB_RELEASE_REPO || "UltimateREN/AgentHub_skill";
  const releaseTag = process.env.AGENTHUB_RELEASE_TAG || `v${manifest.version}`;
  const index = feedIndexOf(manifest, path.basename(archive), {
    repo, releaseTag,
    sha256: crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex"),
  });
  json(index, 0);
  for (const name of feedFileNamesOf(target)) {
    fs.writeFileSync(path.join(out, name), JSON.stringify(index, null, 2) + "\n");
    console.log(`Wrote ${path.join(out, name)}`);
  }
  console.log(`Wrote ${archive}`);
}

if (require.main === module) main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });

module.exports = { platformTagOf, feedFileNamesOf, feedIndexOf, signingPayload, canonical };
