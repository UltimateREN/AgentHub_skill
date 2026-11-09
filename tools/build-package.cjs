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
const keyFile = process.env.AGENTHUB_PLUGIN_SIGNING_KEY || process.argv[3];
const keyId = process.env.AGENTHUB_PLUGIN_KEY_ID || "agenthub-release-2026";
if (!keyFile) throw new Error("Set AGENTHUB_PLUGIN_SIGNING_KEY to an Ed25519 PEM private key");
const privateKey = crypto.createPrivateKey(fs.readFileSync(path.resolve(keyFile)));
if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("Signing key must be Ed25519");

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

async function main() {
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
  const platformTag = [target.os, target.arch, target.libc].filter(Boolean).join("-");
  const archive = path.join(out, `${manifest.id}-${manifest.version}-${platformTag}.zip`);
  fs.rmSync(archive, { force: true });
  const seven = process.env.AGENTHUB_7ZA || path.resolve(root, "..", "AgentHub", "node_modules/7zip-bin/win/x64/7za.exe");
  await run(seven, ["a", "-tzip", "-mx=9", archive, "."], { cwd: stage });
  try { fs.rmSync(stage, { recursive: true, force: true }); }
  catch { console.warn(`临时目录 ${stage} 未清理，下次构建前可手动删除`); }
  fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

  // 官方更新清单：主程序按它判断版本、平台和下载地址。
  // minimumVersion 留空表示不强制升级；填了之后低于它的安装会被强制补齐，不受自动更新开关影响。
  const repo = process.env.AGENTHUB_RELEASE_REPO || "UltimateREN/AgentHub_skill";
  const releaseTag = process.env.AGENTHUB_RELEASE_TAG || `v${manifest.version}`;
  const assetName = path.basename(archive);
  const index = {
    schema: 1,
    plugins: [{
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      minimumVersion: process.env.AGENTHUB_PLUGIN_MINIMUM_VERSION || "",
      minHostVersion: process.env.AGENTHUB_PLUGIN_MIN_HOST_VERSION || "",
      platforms: manifest.runtime.platforms,
      url: `https://github.com/${repo}/releases/download/${releaseTag}/${assetName}`,
      sha256: crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex"),
    }],
  };
  fs.writeFileSync(path.join(out, "plugin-index.json"), JSON.stringify(index, null, 2) + "\n");
  console.log(`Wrote ${archive}`);
  console.log(`Wrote ${path.join(out, "plugin-index.json")}`);
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
