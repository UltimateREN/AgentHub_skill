/**
 * ============================================================
 *  作者：UltimateREN
 *  日期：2026-10-21
 *  版权声明：本代码归 UltimateREN 所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 增强网关 · Accio 地区与端点常量：两个地区共用一套网关，只有登录站点不同
//
// 上游长什么样（逆向自 Accio Work 桌面端安装包 app.asar）：
//   业务网关（国际 / 国内同一个）  https://phoenix-gw.alibaba.com
//     /api/oauth/token                 授权码 → accessToken / refreshToken
//     /api/auth/refresh_token          续期（body 带 accessToken + refreshToken）
//     /api/auth/userinfo               用户资料（GET，accessToken 走 query）
//     /api/entitlement/quota           额度用量百分比 + 重置倒计时
//     /api/entitlement/currentSubscription  订阅详情
//     /api/llm/config                  模型目录（POST，body {token}）—— 用它（v1）
//     /api/llm/config/v2               精简目录（v1 失败时回落一次）
//   推理网关（ADK）  {gw}/api/adk/llm/generateContent?sg_k=<md5(requestId)>  SSE，Gemini 风格信封
//   登录站点  国际版 www.accio.com（GLOBAL）/ 国内版 www.accio-ai.com（CN）
//
// 三个决定性事实（实测/读码）：
//   1. 网关是同一个 —— 两地区打同一 host，差别只在 x-package-region 与登录站点；
//   2. client_id 两地逐字相同（accio-work）；
//   3. token 不走 Authorization 头：业务接口 GET 把 accessToken 拼进 query、POST 放进 JSON body、
//      推理接口把 token 放进 body。这一点与其它家都不同。
//
// 为什么地区是一等公民而不是「一家上的一个字段」：与 qoder/autoclaw 双区同一思路 ——
// 地区做成账号字段会让界面与选路分不清「哪条账号走哪个站点」。两个地区 = 两个渠道 id（accio / accio_cn）。
"use strict";

const DEFAULT_GATEWAY_BASE = "https://phoenix-gw.alibaba.com";
const ADK_LLM_PATH = "/api/adk/llm";
const OAUTH_TOKEN_PATH = "/api/oauth/token";
const REFRESH_TOKEN_PATH = "/api/auth/refresh_token";
const USER_INFO_PATH = "/api/auth/userinfo";
const QUOTA_PATH = "/api/entitlement/quota";
const SUBSCRIPTION_PATH = "/api/entitlement/currentSubscription";
const MODEL_CONFIG_PATH = "/api/llm/config";
const MODEL_CONFIG_PATH_V2 = "/api/llm/config/v2";

const CLIENT_ID = "accio-work";
const DEFAULT_TENANT = "accio-agent";
const DEFAULT_IAI_TAG = "phoenix-desktop";
const DEFAULT_APP_VERSION = "0.32.6";
// 推理请求头 appKey（必填，实测）：不带它打 generateContent，上游不报错而是回一段普通文本
// 「Your app version is no longer supported…」——HTTP 200、data: 帧，形态与正常回答完全一样，
// 会被当成模型输出吐给下游。带上任意非空取值即恢复（上游只校验「有没有」）。
const DEFAULT_APP_KEY = "35298846";
const ACCEPT_LANGUAGE = "en";

function envText(key) {
  const v = String(process.env[key] || "").trim();
  return v || null;
}
function gatewayBase() {
  return (envText("ACCIO_GATEWAY_BASE") || DEFAULT_GATEWAY_BASE).replace(/\/+$/, "");
}

// 地区：GLOBAL（国际版，登录站点 www.accio.com）/ CN（国内版，www.accio-ai.com）
const REGIONS = {
  accio: { id: "accio", label: "国际版", edition: "intl", packageRegion: "GLOBAL", loginBase: "https://www.accio.com" },
  accio_cn: { id: "accio_cn", label: "国内版", edition: "cn", packageRegion: "CN", loginBase: "https://www.accio-ai.com" },
};
function regionOf(channel) {
  return REGIONS[channel] || REGIONS.accio;
}

// 业务接口通用请求头（桌面端拦截器统一加的那组里认得全的部分）。
// 刻意不带 Authorization：桌面端一个请求都不带它，鉴权全靠 body/query 里的 accessToken。
// appKey 只用于推理接口（业务接口带不带都一样，多带徒增风控面）。
function apiHeaders(region) {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    "Accept-Language": ACCEPT_LANGUAGE,
    "x-language": ACCEPT_LANGUAGE,
    "x-platform": "desktop",
    "x-os": process.platform,
    "x-app-version": envText("ACCIO_APP_VERSION") || DEFAULT_APP_VERSION,
    "x-package-region": region.packageRegion,
  };
}

module.exports = {
  DEFAULT_APP_VERSION, DEFAULT_TENANT, DEFAULT_IAI_TAG, ACCEPT_LANGUAGE,
  gatewayBase, llmBase: () => `${gatewayBase()}${ADK_LLM_PATH}`,
  OAUTH_TOKEN_PATH, REFRESH_TOKEN_PATH, USER_INFO_PATH, QUOTA_PATH, SUBSCRIPTION_PATH,
  MODEL_CONFIG_PATH, MODEL_CONFIG_PATH_V2,
  CLIENT_ID,
  appKey: () => envText("ACCIO_APP_KEY") || DEFAULT_APP_KEY,
  regionOf, apiHeaders,
};
