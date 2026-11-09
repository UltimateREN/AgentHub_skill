"use strict";
// 用 UltimateREN 的身份推送本仓库。
//
// 主程序的 HUIdada1 凭据不参与这里：脚本只从 gh 里读 UltimateREN 的 token，
// 拼成一次性 URL 推完就丢。两边账号互不影响，也不需要改全局 git 配置。
//
// 用法：node tools/push.cjs [branch] [--tags]
const { execFileSync, spawnSync } = require("node:child_process");
const path = require("node:path");

const REPO = "UltimateREN/AgentHub_skill";
const root = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const branch = args.find(item => !item.startsWith("--")) || "main";
const withTags = args.includes("--tags");

function readToken() {
  // 清掉环境里的 GH_TOKEN：那是主程序账号的，不能让它盖过 --user
  const env = { ...process.env };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  try {
    return execFileSync("gh", ["auth", "token", "--user", "UltimateREN"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env,
    }).trim();
  } catch { return ""; }
}

function mask(text) {
  return String(text || "").replace(/x-access-token:[^@\s]*@/g, "x-access-token:***@");
}

const token = readToken();
if (!token) {
  console.error("找不到 UltimateREN 的 gh 凭据。先在 UltimateREN 账号下跑一次 gh auth login。");
  process.exit(1);
}

const url = `https://x-access-token:${token}@github.com/${REPO}.git`;
const refs = [`HEAD:${branch}`, ...(withTags ? ["--tags"] : [])];
const result = spawnSync("git", ["push", url, ...refs], { cwd: root, encoding: "utf8" });
process.stdout.write(mask(result.stdout));
process.stderr.write(mask(result.stderr));
if (result.status !== 0) {
  console.error(`推送失败。确认 UltimateREN 对 ${REPO} 有写权限。`);
  process.exit(result.status || 1);
}
