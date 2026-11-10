/**
 * ============================================================
 *  作者：UltimateREN
 *  日期：2026-10-22
 *  版权声明：本代码归 UltimateREN 所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// CatPaw 内联图片压缩：把 round 请求体里的超阈值 Base64 大图压成小 JPEG
// （协议依据：官方客户端图片压缩实测）。
//
// 为什么必须有它：CatPaw 上游不拉取 http(s) 图片，图片只能以 data:image/...;base64, 内联；
// 而大图是 round 请求体超限 / 超时的主因（线上问题根因：单张约 176KB 的截图
// 让 round 请求体超过上游约 200KB 的限制直接 504）。
//
// 压缩语义（参数唯一事实来源是官方客户端实现，不改动）：
//   触发按 **base64 文本长度** > 60KB；达标按 **JPEG 二进制长度** ≤ 120KB；
//   最长边 1568（等比不放大）、降尺寸下限 896、质量 80 起步每轮 -15 最低 55、最多编码 4 次。
//   即尺寸序列 1568 → 1568 → 1176(→896) → 896，质量序列 80 → 65 → 55 → 55。
//   两个阈值量纲不同（触发按字符数、达标按字节数）是原实现就有的口径，改口径属于行为变更。
//
// 编码器由独立插件交付sharp，不依赖本体Electron；保持可注入codec验证原决策序列。
//
// 容错：任何一步失败（格式不符、base64 解不开、图解不开、编码失败、压了反而更大）一律原样返回，
// 绝不阻断请求——宁可超重发出去（上游报错可见），也不让一张坏图带走整个请求。
"use strict";

const COMPRESS_THRESHOLD_BASE64 = 60 * 1024;
const TARGET_OUTPUT_BYTES = 120 * 1024;
const MAX_DIMENSION = 1568;
const MIN_DIMENSION = 896;
const JPEG_QUALITY = 80;
const MIN_QUALITY = 55;
const MAX_ATTEMPTS = 4;
const DATA_URL_PREFIX = "data:image/";

/** 默认codec来自插件自有依赖；缺依赖应暴露打包错误，不静默假装图片迁移成功。 */
function standaloneCodec() { return require("./image-codec.cjs").codec; }

let codec = null;
let codecResolved = false;

/** 覆盖 codec（自测用；传 null 恢复默认懒加载） */
function setCodec(next) {
  codec = next;
  codecResolved = true;
}

function activeCodec() {
  if (!codecResolved) {
    codec = standaloneCodec();
    codecResolved = true;
  }
  return codec;
}

/** 取出 `data:image/<subtype>;base64,<body>` 里的 base64 主体（前缀大小写敏感、subtype 与正文均有字符集约束） */
function imageDataUrlBody(dataUrl) {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith(DATA_URL_PREFIX)) return null;
  const rest = dataUrl.slice(DATA_URL_PREFIX.length);
  const separator = rest.indexOf(";");
  if (separator < 0) return null;
  const subtype = rest.slice(0, separator);
  if (!subtype || !/^[A-Za-z0-9.+-]+$/.test(subtype)) return null;
  const tail = rest.slice(separator);
  if (!tail.startsWith(";base64,")) return null;
  const body = tail.slice(";base64,".length);
  if (!body || !/^[A-Za-z0-9+/=\r\n]+$/.test(body)) return null;
  return body;
}

/** 压缩内联图片：超阈值的 data:image/*;base64 压成 JPEG，其余原样返回 */
async function compressIfNeeded(dataUrl) {
  const body = imageDataUrlBody(dataUrl);
  if (!body) return dataUrl;
  if (body.length < COMPRESS_THRESHOLD_BASE64) return dataUrl;
  const impl = activeCodec();
  if (!impl) return dataUrl;
  let input;
  try {
    input = Buffer.from(body.replace(/[\r\n]/g, ""), "base64");
  } catch {
    return dataUrl;
  }
  if (!input.length) return dataUrl;
  let decoded = null;
  try {
    decoded = await impl.decode(input);
  } catch {
    decoded = null;
  }
  if (!decoded) return dataUrl;

  let dimension = MAX_DIMENSION;
  let quality = JPEG_QUALITY;
  let output = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let encoded = null;
    try {
      const scaled = await impl.resize(decoded, dimension);
      if (scaled) encoded = await impl.encodeJpeg(scaled, quality);
    } catch {
      encoded = null;
    }
    if (!encoded) return dataUrl;
    output = encoded;
    if (encoded.length <= TARGET_OUTPUT_BYTES) break;
    quality = Math.max(MIN_QUALITY, quality - 15);
    if (attempt >= 1) dimension = Math.max(MIN_DIMENSION, Math.floor((dimension * 3) / 4));
  }
  if (!output || output.length >= input.length) return dataUrl;
  return `data:image/jpeg;base64,${output.toString("base64")}`;
}

/** 归一化消息里的内联图片批量压缩（prepare 的调用点）：只处理 image_url 块的 data:image/ URL，
 *  压缩产物与原值不同才回写（不复制其它字段，只替换 url） */
async function compressMessages(messages) {
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!block || block.type !== "image_url") continue;
      const url = block.imageUrl && block.imageUrl.url;
      if (typeof url !== "string" || !url.startsWith("data:image/")) continue;
      const next = await compressIfNeeded(url);
      if (next !== url) block.imageUrl.url = next;
    }
  }
  return messages;
}

module.exports = {
  compressIfNeeded,
  compressMessages,
  setCodec,
  __internals: { imageDataUrlBody, COMPRESS_THRESHOLD_BASE64, TARGET_OUTPUT_BYTES, MAX_DIMENSION, MIN_DIMENSION, JPEG_QUALITY, MIN_QUALITY, MAX_ATTEMPTS },
};
