/**
 * ============================================================
 *  作者：沐晖
 *  日期：2026-11-10
 *  版权声明：本代码归沐晖所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// 豆包工作（www.doubao.com）：**自家协议 + Cookie 登录态**，插件自己做流翻译。
// 依据 Agent2Providers `doubaowork/`（api.rs / prompt.rs / chat.rs / upload.rs 模块头）。
//
// ── 上游形状 ────────────────────────────────────────────────
//   POST /alice/user/launch                       → assistant_bot_id
//   POST /alice/slot/action_bar_v3/brief_list     → 模型菜单
//   POST /alice/resource/prepare_upload           → 图片上传临时凭据
//   POST /chat/completion?<固定查询串>             → SSE
// 查询串必须带 aid / device_platform / pc_version / device_id / fp —— 风控认的是
// 「这个账号在这台受信设备上」，缺 device_id / fp 一定被人机验证拦下。
//
// ── 工具调用 ────────────────────────────────────────────────
// 上游**没有** tools 字段。参考实现用「提示词桥」（prompt.rs 的 ToolBridge）：
// 把 tools 声明与历史一起塞进文本，要求模型只回一个带随机 marker 的 JSON；
// 流末把整段正文当 JSON 解析，命中即转成 tool_calls。
// 因此**有工具时必须缓冲整条流**（不能边流边发），否则会把 JSON 碎片当正文吐给客户端。
//
// ── 图片输入 ────────────────────────────────────────────────
// 客户端给 base64 data URL → 走 imagex 三跳上传（prepare_upload → ApplyImageUpload →
// 上报字节 → CommitImageUpload），拿到的 attachment 放进 content_block 的 10052 块。
// 正文里对应位置换成 `[Attached image N]`（上游按块读图，不读文本）。
"use strict";
const crypto = require("node:crypto");
const { descriptor } = require("../../model-descriptor.cjs");
const { forwardError } = require("../../../sdk/provider-protocol.cjs");

const BASE_URL = "https://www.doubao.com";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";
const DEFAULT_CLIENT_VERSION = "2.33.5";
/** 上游单轮图片上限（upload.rs MAX_IMAGE） */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** 单次最多 10 张（prompt.rs content） */
const MAX_IMAGES = 10;

function encode(value) {
  return String(value).replace(/[^A-Za-z0-9\-._~]/g, (ch) => {
    const bytes = Buffer.from(ch, "utf8");
    let out = "";
    for (const byte of bytes) out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    return out;
  });
}
function queryOf(creds) {
  const clientVersion = String(creds.clientVersion || DEFAULT_CLIENT_VERSION);
  const pairs = [
    ["aid", "1044603"], ["real_aid", "1044603"], ["device_platform", "web"],
    ["version_code", "20800"], ["samantha_web", "1"], ["web_platform", "desktop"],
    ["doubao_device_platform", "desktop"], ["client_platform", "pc_client"],
    ["pkg_type", "release_version"], ["runtime", "web"], ["runtime_version", "3.42.2"],
    ["pc_version", clientVersion], ["doubao_pc_version", clientVersion],
    ["use-olympus-account", "1"], ["language", "zh"], ["region", "CN"], ["sys_region", "CN"],
  ];
  if (creds.deviceId) { pairs.push(["device_id", creds.deviceId]); pairs.push(["fp", `verify_${creds.deviceId}`]); }
  for (const [wire, field] of [["web_id", "webId"], ["chromium_version", "chromiumVersion"], ["channel", "channel"]]) {
    if (creds[field]) pairs.push([wire, creds[field]]);
  }
  return pairs.map(([key, value]) => `${encode(key)}=${encode(value)}`).join("&");
}

function fail(status, code, message, scope = "invocation", retryable = false) {
  return forwardError({
    code, message: String(message || "豆包工作模型执行失败").slice(0, 1024),
    category: code === "AUTH_REQUIRED" ? "auth" : code === "RATE_LIMITED" ? "rate" : "upstream",
    scope, replay: "unknown", retryable,
    status: status >= 400 && status <= 599 ? status : 502,
  });
}
function classify(status, detail) {
  const text = String(detail || "").slice(0, 2048);
  if (status === 401 || status === 403) return fail(401, "AUTH_REQUIRED", "豆包工作 Cookie 已失效，请重新登录", "account");
  if (/人机验证|captcha|verify/i.test(text)) return fail(429, "CAPTCHA_REQUIRED", "豆包工作触发人机验证（device_id / fp 与账号不匹配）", "account", true);
  if (status === 429) return fail(429, "RATE_LIMITED", "豆包工作上游限流", "account", true);
  if (status === 400 || status === 422) return fail(400, "INVALID_REQUEST", "豆包工作拒绝了该请求（参数不合法）");
  return fail(status >= 400 && status <= 599 ? status : 502, "UPSTREAM_FAILED", "豆包工作模型执行失败", "invocation", status >= 500);
}
function unsupported(message) {
  return fail(400, "UNSUPPORTED_PARAMETER", message);
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part && ["text", "input_text"].includes(part.type)).map((part) => String(part.text || "")).join("\n\n");
}

// ── 工具桥（prompt.rs ToolBridge 的逐条移植）─────────────────────
const MARKER_PREFIX = "agent2api_tools";
class ToolBridge {
  constructor(body) {
    const rows = Array.isArray(body?.tools) ? body.tools : body?.tools == null ? [] : null;
    if (rows === null) throw unsupported("tools 必须是数组");
    const names = new Set();
    for (const row of rows) {
      const name = row?.function?.name;
      if (typeof name !== "string" || !name) throw unsupported("工具缺少 function.name");
      if (row.type !== "function" || names.has(name)) throw unsupported("豆包工作只接受名称唯一的 function 工具");
      names.add(name);
    }
    const choice = body?.tool_choice == null ? null : body.tool_choice;
    let forced = false;
    if (choice != null) {
      if (typeof choice === "string") {
        if (choice === "auto") forced = false;
        else if (choice === "none") names.clear();
        else if (choice === "required" && names.size) forced = true;
        else throw unsupported("无效的 tool_choice");
      } else if (typeof choice === "object") {
        const name = String(choice?.function?.name || "");
        if (choice.type !== "function" || !names.has(name)) throw unsupported("tool_choice 必须选择已声明的工具");
        for (const item of [...names]) if (item !== name) names.delete(item);
        forced = true;
      } else throw unsupported("无效的 tool_choice");
    }
    this.names = names;
    this.forced = forced;
    this.parallel = body?.parallel_tool_calls !== false;
    this.declarations = rows;
    this.marker = `${MARKER_PREFIX}_${crypto.randomBytes(16).toString("hex")}`;
  }
  active() { return this.names.size > 0; }
  /** 提示词前缀（逐字对齐参考实现，含 JSON 形态的 allowed names / 工具声明） */
  instruction() {
    if (!this.names.size) return "";
    return `The following JSON conversation contains the complete client history, including tool call IDs and tool results. Follow its system/developer instructions. Client-side tools are available; do not run substitute desktop tools. To request tools, return ONLY a JSON object with key ${JSON.stringify(this.marker)} and an array of objects {"name":"declared name","arguments":{...}}. Allowed names: ${JSON.stringify([...this.names])}. Tool definitions: ${JSON.stringify(this.declarations)}. A tool result is provided in the next request. Otherwise return your answer as text. Tool use is ${this.forced ? "required" : "optional"}. Parallel tool use is ${this.parallel}.\n`;
  }
  /** 正文 → assistant 消息（命中 marker 即 tool_calls；不完整要报错而不是当正文） */
  message(text) {
    const raw = String(text || "").trim();
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { parsed = null; }
    const calls = parsed && typeof parsed === "object" ? parsed[this.marker] : undefined;
    if (calls === undefined && raw.includes(this.marker)) throw fail(502, "INCOMPLETE_TOOL_CALL", "豆包工作返回了不完整的工具调用");
    if (calls !== undefined) {
      if (!Array.isArray(calls) || !calls.length) throw fail(502, "INVALID_TOOL_CALL", "豆包工作返回的工具调用格式无效");
      if (!this.parallel && calls.length > 1) throw fail(502, "INVALID_TOOL_CALL", "豆包工作未遵守 parallel_tool_calls=false");
      const normalized = [];
      for (const call of calls) {
        const name = String(call?.name || "");
        const args = call?.arguments;
        if (!this.names.has(name) || !args || typeof args !== "object" || Array.isArray(args))
          throw fail(502, "INVALID_TOOL_CALL", "豆包工作返回未声明的工具或无效参数");
        normalized.push({
          id: `call_${crypto.randomBytes(12).toString("hex")}`, type: "function",
          function: { name, arguments: JSON.stringify(args) },
        });
      }
      return { role: "assistant", content: null, tool_calls: normalized };
    }
    if (this.forced) throw fail(502, "TOOL_CALL_REQUIRED", "豆包工作未按要求调用工具");
    return { role: "assistant", content: String(text || "") };
  }
}

/** 历史 → 单条文本（参考 content()：整段 JSON 历史 + 提示词前缀；图片抽出来单独上传） */
function buildPrompt(messages, bridge) {
  const list = Array.isArray(messages) ? messages : [];
  if (!list.length) throw unsupported("messages 必须包含消息");
  const images = [];
  const history = [];
  for (const source of list) {
    if (!source || typeof source !== "object") continue;
    const role = String(source.role || "");
    if (!["system", "developer", "user", "assistant", "tool"].includes(role)) throw unsupported("豆包工作不支持该消息角色");
    const message = { ...source };
    if (Array.isArray(message.content)) {
      const parts = [];
      for (const part of message.content) {
        if (!part || typeof part !== "object") continue;
        if (part.type === "text" && typeof part.text === "string") { parts.push(part); continue; }
        if (part.type === "image_url") {
          const url = String(part?.image_url?.url || "");
          if (!url.startsWith("data:image/")) throw unsupported("豆包工作对话图片输入仅接受 base64 data URL");
          if (images.length >= MAX_IMAGES) throw unsupported(`豆包工作单次最多输入 ${MAX_IMAGES} 张图片`);
          images.push(url);
          parts.push({ type: "text", text: `[Attached image ${images.length}]` });
          continue;
        }
        throw unsupported("豆包工作不支持该消息内容块");
      }
      message.content = parts;
    } else if (typeof message.content !== "string" && message.content != null) {
      throw unsupported("豆包工作消息内容格式无效");
    }
    history.push(message);
  }
  return { prompt: `${bridge.instruction()}${JSON.stringify(history)}`, images };
}

/** 旧的纯文本路径（无工具时保持原样：单条 user 文本更适合上游的多轮压缩） */
function buildPlainPrompt(messages) {
  const items = Array.isArray(messages) ? messages.filter((m) => m && textOf(m.content).trim()) : [];
  if (!items.length) return "你好";
  if (items.length === 1) return textOf(items[0].content) || "你好";
  const lines = ["[以下是本轮之前的对话记录，供你了解上下文]"];
  for (const message of items) {
    const role = String(message.role || "user");
    const text = textOf(message.content);
    if (!text) continue;
    if (role === "system" || role === "developer") lines.push(`[系统指令] ${text}`);
    else if (role === "assistant") lines.push(`[助手] ${text}`);
    else lines.push(`[用户] ${text}`);
  }
  return lines.join("\n");
}

// ── 图片上传（upload.rs 的三跳 + SigV4）────────────────────────
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value;
  }
  return table;
})();
function crc32(bytes) {
  let crc = -1;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}
function hex(buffer) { return Buffer.from(buffer).toString("hex"); }
function hmac(key, value) { return crypto.createHmac("sha256", key).update(value).digest(); }
function sha256Hex(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function amzDate() { return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, ""); }

function imageSign(auth, method, host, query, body, region, time) {
  const access = String(auth?.access_key || "");
  const secret = String(auth?.secret_key || "");
  const token = String(auth?.session_token || "");
  if (!access || !secret || !token) throw fail(502, "UPLOAD_AUTH_MISSING", "豆包工作图片上传缺少临时凭据");
  const date = time.slice(0, 8);
  const canonicalQuery = Object.keys(query).map((key) => `${encode(key)}=${encode(query[key])}`).join("&");
  const headers = `host:${host}\nx-amz-date:${time}\nx-amz-security-token:${token}\n`;
  const names = "host;x-amz-date;x-amz-security-token";
  const canonical = `${method}\n/\n${canonicalQuery}\n${headers}\n${names}\n${sha256Hex(body)}`;
  const scope = `${date}/${region}/imagex/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${time}\n${scope}\n${sha256Hex(canonical)}`;
  const key = hmac(hmac(hmac(hmac(`AWS4${secret}`, date), region), "imagex"), "aws4_request");
  return {
    query: canonicalQuery,
    authorization: `AWS4-HMAC-SHA256 Credential=${access}/${scope}, SignedHeaders=${names}, Signature=${hex(hmac(key, stringToSign))}`,
    token,
  };
}

/** 只允许官方图床域名（upload.rs upload_base 的白名单） */
function uploadBase(host) {
  const allowed = [".bytedanceapi.com", ".bytevcloudapi.com", ".volcengineapi.com", ".byteimg.com", ".ibyteimg.com", ".ibytedtos.com", ".imagex.cn", ".douyinpic.com"];
  const value = String(host || "").trim();
  if (!value || /[/\\?#@\s]/.test(value) || !allowed.some((suffix) => value.endsWith(suffix)))
    throw fail(502, "UPLOAD_HOST_INVALID", "豆包工作返回了非官方图片上传域名");
  return `https://${value}`;
}

/** 图片格式与尺寸：只做识别，不做解码（参考实现也只用来校验与填 width/height） */
function imageInfo(bytes) {
  if (bytes.length > MAX_IMAGE_BYTES) throw unsupported("输入图片超过 20 MiB");
  if (bytes.length > 8 && bytes.readUInt32BE(0) === 0x89504e47) {
    const width = bytes.length >= 24 ? bytes.readUInt32BE(16) : 0;
    const height = bytes.length >= 24 ? bytes.readUInt32BE(20) : 0;
    return { extension: ".png", width, height };
  }
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset++; continue; }
      const marker = bytes[offset + 1];
      const length = bytes.readUInt16BE(offset + 2);
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        return { extension: ".jpg", width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) };
      }
      offset += 2 + length;
    }
    return { extension: ".jpg", width: 0, height: 0 };
  }
  if (bytes.length > 16 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    const chunk = bytes.toString("ascii", 12, 16);
    if (chunk === "VP8X" && bytes.length >= 30) {
      return { extension: ".webp", width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
    }
    if (chunk === "VP8 " && bytes.length >= 30) {
      return { extension: ".webp", width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    }
    return { extension: ".webp", width: 0, height: 0 };
  }
  throw unsupported("豆包工作图片输入仅支持 PNG、JPEG 和 WebP");
}

/** data URL → attachment 对象（upload.rs image() 的落库形状） */
async function uploadImage(ctx, post, request, dataUrl) {
  const comma = String(dataUrl).indexOf(",");
  if (comma < 0) throw unsupported("无效的图片 data URL");
  const prefix = String(dataUrl).slice(0, comma);
  const encoded = String(dataUrl).slice(comma + 1);
  if (!prefix.startsWith("data:image/") || !prefix.endsWith(";base64")) throw unsupported("图片 data URL 格式无效或超过 20 MiB");
  if (encoded.length > Math.floor(MAX_IMAGE_BYTES * 4 / 3) + 4) throw unsupported("图片 data URL 格式无效或超过 20 MiB");
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length) throw unsupported("无效的图片 base64");
  const info = imageInfo(bytes);

  const prepared = await post("/alice/resource/prepare_upload", { tenant_id: "5", scene_id: "4", resource_type: 2 });
  const prep = prepared && prepared.data;
  if (!prep) throw fail(502, "UPLOAD_PREPARE_FAILED", "豆包工作未返回图片上传凭据");
  const host = String(prep.upload_host || "");
  const endpoint = uploadBase(host);
  const service = String(prep.service_id || "");
  if (!service) throw fail(502, "UPLOAD_PREPARE_FAILED", "豆包工作未返回图片上传服务号");
  const region = String(prep.region || "cn-north-1");
  const auth = prep.upload_auth_token || {};

  let time = amzDate();
  let signed = imageSign(auth, "GET", host, { Action: "ApplyImageUpload", Version: "2018-08-01", ServiceId: service, FileSize: String(bytes.length), FileExtension: info.extension }, "", region, time);
  const applyResponse = await ctx.pool.network().fetch(`${endpoint}/?${signed.query}`, {
    method: "GET", redirect: "error", signal: ctx.signal,
    headers: { "x-amz-date": time, "x-amz-security-token": signed.token, Authorization: signed.authorization, accept: "application/json" },
  });
  const applied = await applyResponse.json().catch(() => null);
  if (!applyResponse.ok || !applied) throw fail(502, "UPLOAD_APPLY_FAILED", `豆包工作图片上传申请失败 HTTP ${applyResponse.status}`);
  const address = applied?.Result?.UploadAddress || {};
  const store = Array.isArray(address.StoreInfos) ? address.StoreInfos[0] : null;
  const uploadHost = Array.isArray(address.UploadHosts) ? String(address.UploadHosts[0] || "") : "";
  const uri = String(store?.StoreUri || "");
  if (!store || !uploadHost || !uri || uri.startsWith("/") || /[?#\\]/.test(uri) || uri.split("/").some((s) => s === ".." || s === "."))
    throw fail(502, "UPLOAD_ADDRESS_INVALID", "豆包工作返回的图片上传地址无效");

  const pushed = await ctx.pool.network().fetch(`${uploadBase(uploadHost)}/upload/v1/${uri}`, {
    method: "POST", redirect: "error", signal: ctx.signal,
    headers: {
      Authorization: String(store.Auth || ""),
      "Content-CRC32": crc32(bytes).toString(16).padStart(8, "0"),
      "Content-Type": "application/octet-stream",
    },
    body: bytes,
  });
  const pushedBody = await pushed.json().catch(() => null);
  if (!pushed.ok || Number(pushedBody?.code) !== 2000) throw fail(502, "UPLOAD_FAILED", `豆包工作图片上传失败 HTTP ${pushed.status}`);

  const session = String(address.SessionKey || "");
  if (!session) throw fail(502, "UPLOAD_COMMIT_FAILED", "豆包工作未返回图片上传会话");
  time = amzDate();
  const body = JSON.stringify({ SessionKey: session });
  signed = imageSign(auth, "POST", host, { Action: "CommitImageUpload", Version: "2018-08-01", ServiceId: service }, body, region, time);
  const commitResponse = await ctx.pool.network().fetch(`${endpoint}/?${signed.query}`, {
    method: "POST", redirect: "error", signal: ctx.signal,
    headers: {
      "x-amz-date": time, "x-amz-security-token": signed.token, Authorization: signed.authorization,
      "Content-Type": "application/json", accept: "application/json",
    },
    body,
  });
  const committed = await commitResponse.json().catch(() => null);
  const result = committed?.Result?.Results?.[0];
  if (!commitResponse.ok || Number(result?.UriStatus) !== 2000) throw fail(502, "UPLOAD_COMMIT_FAILED", "豆包工作未确认图片上传完成");
  const finalUri = String(result?.Uri || "");
  if (!finalUri) throw fail(502, "UPLOAD_COMMIT_FAILED", "豆包工作未返回图片地址");

  return {
    type: 1, identifier: crypto.randomUUID(),
    image: { name: `image${info.extension}`, uri: finalUri, image_ori: { url: "", width: info.width, height: info.height, format: "", url_formats: {} } },
    parse_state: 0, review_state: 1, upload_status: 1, progress: 100, src: "",
  };
}

/** 请求体（prompt.rs payload；attachment 块恒在正文块之前） */
function buildPayload(bot, modelId, prompt, attachments) {
  const uuid = () => crypto.randomUUID();
  const now = Date.now();
  const digits = uuid().replace(/[^0-9a-f]/g, "").split("").map((d) => parseInt(d, 16) % 10).slice(0, 16).join("");
  const blocks = [];
  if (attachments.length) {
    blocks.push({ block_type: 10052, content: { attachment_block: { attachments }, pc_event_block: "" }, block_id: uuid(), parent_id: "", meta_info: [], append_fields: [] });
  }
  blocks.push({ block_type: 10000, content: { text_block: { text: prompt } }, block_id: uuid(), parent_id: "", meta_info: [], append_fields: [] });
  return {
    client_meta: {
      local_conversation_id: `local_${digits}`, conversation_id: "", bot_id: bot,
      last_section_id: "", last_message_index: null,
    },
    messages: [{ local_message_id: uuid(), content_block: blocks, message_status: 0 }],
    option: {
      create_time_ms: now,
      need_create_conversation: true,
      conversation_init_option: { need_ack_conversation: true },
      need_deep_think: false,
      is_audio: false, answer_with_suggest: false, tts_switch: false,
      is_regen: false, is_replace: false,
      unique_key: uuid(), start_seq: 0,
      sse_recv_event_options: { support_chunk_delta: true },
      recovery_option: { is_recovery: false, req_create_time_sec: Math.floor(now / 1000), append_sse_event_scene: 0 },
      message_storage_type: 0,
    },
    user_context: [],
    ext: { use_deep_think: "false", sub_conv_firstmet_type: "1", commerce_credit_config_enable: "0" },
  };
}

function createDoubaoWork(settings = {}) {
  const base = String(settings.baseUrl || BASE_URL).replace(/\/+$/, "");
  const ua = String(settings.userAgent || USER_AGENT);
  return {
    id: "doubaowork", channels: ["doubaowork"], requiredFeatures: ["execution-facts@1"],
    async listModels(request, ctx) {
      if (!request.grantId) return [];
      const context = await ctx.pool.context();
      return (context.models || []).map(descriptor);
    },
    async *invoke(request, ctx) {
      const credentials = await ctx.pool.credentials();
      const cookie = String(credentials?.token || "").trim();
      if (!cookie) throw fail(401, "AUTH_REQUIRED", "豆包工作 Cookie 缺失", "account");
      const creds = {
        cookie, deviceId: String(credentials?.deviceId || ""), clientVersion: String(credentials?.clientVersion || ""),
        webId: String(credentials?.webId || ""), chromiumVersion: String(credentials?.chromiumVersion || ""), channel: String(credentials?.channel || ""),
      };
      const headers = { cookie, origin: base, referer: `${base}/chat/`, "user-agent": ua, "content-type": "application/json", "Agw-Js-Conv": "str", accept: "text/event-stream" };
      const query = queryOf(creds);
      const post = async (path, body, accept = "application/json") => {
        const response = await ctx.pool.network().fetch(`${base}${path}?${query}`, {
          method: "POST", redirect: "error", signal: ctx.signal,
          headers: { ...headers, accept }, body: JSON.stringify(body || {}),
        });
        if (!response.ok) {
          const text = await response.text().catch(() => "");
          throw classify(response.status, text);
        }
        const text = await response.text().catch(() => "");
        try { return JSON.parse(text); } catch { throw fail(502, "INVALID_UPSTREAM_JSON", "豆包工作返回了非 JSON 响应"); }
      };
      // bot_id：优先账号 meta（登录/目录刷新时写入），否则现场 launch
      let bot = String(credentials?.botId || "").trim();
      if (!bot) {
        const launch = await post("/alice/user/launch", {});
        bot = String(launch?.data?.assistant_bot_id || launch?.assistant_bot_id || "").trim();
        if (!bot) throw fail(502, "MISSING_BOT_ID", "豆包工作未返回助手 ID（请先刷新模型目录）");
      }
      const input = request.input || {};
      const bridge = new ToolBridge(input);
      const toolMode = bridge.active();
      let prompt;
      let images = [];
      if (toolMode) {
        const built = buildPrompt(input.messages, bridge);
        prompt = built.prompt;
        images = built.images;
      } else {
        prompt = buildPlainPrompt(input.messages);
        for (const message of Array.isArray(input.messages) ? input.messages : []) {
          for (const part of Array.isArray(message?.content) ? message.content : []) {
            if (part?.type === "image_url" && String(part?.image_url?.url || "").startsWith("data:image/")) {
              if (images.length >= MAX_IMAGES) throw unsupported(`豆包工作单次最多输入 ${MAX_IMAGES} 张图片`);
              images.push(String(part.image_url.url));
              prompt += `\n[Attached image ${images.length}]`;
            }
          }
        }
      }
      const attachments = [];
      for (const image of images) attachments.push(await uploadImage(ctx, post, request, image));
      const payload = buildPayload(bot, String(request.model || ""), prompt, attachments);
      let response;
      try {
        await ctx.attempts?.report({ state: "planned", actualModel: String(request.model || "") });
        response = await ctx.pool.network().fetch(`${base}/chat/completion?${query}`, {
          method: "POST", redirect: "error", signal: ctx.signal,
          headers: { ...headers, accept: "text/event-stream" }, body: JSON.stringify(payload),
        });
        await ctx.attempts?.report({ state: "responded", actualModel: String(request.model || "") });
      } catch (error) {
        if (ctx.signal?.aborted) throw fail(504, "UPSTREAM_TIMEOUT", "豆包工作请求已取消或超时");
        throw classify(502, error?.message);
      }
      const contentType = String(response.headers?.get?.("content-type") || "");
      if (!response.ok || !contentType.startsWith("text/event-stream")) {
        const text = await response.text().catch(() => "");
        throw classify(response.status, text);
      }
      let contentSeen = false;
      let reasoning = "";
      let collected = "";
      const imageLinks = [];
      try {
        // 豆包用**命名事件**（STREAM_MSG_NOTIFY / CHUNK_DELTA / FULL_MSG_NOTIFY /
        // STREAM_MSG_PATCH），而通用的 sse() 只交 data、丢掉 event 名 —— 这里自己解析，
        // 否则会把「全量消息」当增量重复下发。
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let eventName = "";
        const handle = (name, dataText) => {
          if (!dataText) return [];
          let value;
          try { value = JSON.parse(dataText); } catch { return []; }
          const out = [];
          if (name === "CHUNK_DELTA" && typeof value.text === "string") {
            out.push({ text: value.text, reasoning: false });
            return out;
          }
          const blocks = name === "FULL_MSG_NOTIFY"
            ? value?.message?.content_block
            : (name === "STREAM_MSG_NOTIFY" ? value?.content?.content_block : (value?.content?.content_block || value?.message?.content_block));
          if (Array.isArray(blocks)) {
            for (const block of blocks) {
              const text = block?.content?.text_block?.text;
              if (typeof text !== "string" || !text) continue;
              // text_block 里带 reasoning 标记的块是思考增量
              out.push({ text, reasoning: block?.content?.text_block?.reasoning === true });
            }
            // 出图：图片块（10052 之外的 image block）里的链接在流末才齐，先攒着
            for (const block of blocks) {
              const url = block?.content?.image_block?.image?.image_ori?.url
                || block?.content?.image_block?.image?.url
                || block?.content?.image_block?.url;
              if (typeof url === "string" && /^https?:\/\//.test(url) && !imageLinks.includes(url)) imageLinks.push(url);
            }
          }
          return out;
        };
        while (true) {
          if (ctx.signal?.aborted) break;
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let index;
          while ((index = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, index).replace(/\r$/, "");
            buffer = buffer.slice(index + 1);
            if (line.startsWith("event:")) { eventName = line.slice(6).trim(); continue; }
            if (!line.startsWith("data:")) { if (!line.trim()) eventName = ""; continue; }
            const dataText = line.slice(5).trim();
            if (!dataText || dataText === "[DONE]") continue;
            for (const delta of handle(eventName, dataText)) {
              if (delta.reasoning) {
                reasoning += delta.text;
                // 有工具时整条流要缓冲：思考增量也先攒，最后一次性发（保持顺序）
                if (!toolMode) yield { type: "delta", delta: { reasoning_content: delta.text } };
                continue;
              }
              contentSeen = true;
              if (toolMode) { collected += delta.text; continue; }
              yield { type: "delta", delta: { content: delta.text } };
            }
          }
        }
        try { await reader.cancel(); } catch { /* 已关闭 */ }
      } finally {
        try { await response.body?.cancel(); } catch { /* 已关闭 */ }
      }
      // 出图链接排在正文之后（上游的原图比预览晚到）
      const markdown = imageLinks.map((url) => `\n\n![image](${url})`).join("");
      if (toolMode) {
        if (!contentSeen && !markdown) throw fail(502, "EMPTY_UPSTREAM_RESPONSE", "豆包工作没有返回回答");
        const message = bridge.message(collected);
        if (markdown) {
          if (!Array.isArray(message.tool_calls)) message.content = `${message.content || ""}${markdown}`;
        }
        if (reasoning) message.reasoning_content = reasoning;
        if (Array.isArray(message.tool_calls)) {
          yield { type: "delta", delta: { tool_calls: message.tool_calls.map((call, index) => ({ ...call, index })) } };
          yield { type: "finish", reason: "tool_calls" };
        } else {
          yield { type: "delta", delta: { content: message.content || "" } };
          yield { type: "finish", reason: "stop" };
        }
        return;
      }
      if (!contentSeen && !markdown) throw fail(502, "EMPTY_UPSTREAM_RESPONSE", "豆包工作没有返回回答");
      if (markdown) yield { type: "delta", delta: { content: markdown } };
      yield { type: "finish", reason: "stop" };
    },
  };
}

module.exports = {
  createDoubaoWork, buildPlainPrompt, buildPrompt, buildPayload, queryOf, classify,
  ToolBridge, uploadImage, imageInfo, crc32, BASE_URL, USER_AGENT,
};
