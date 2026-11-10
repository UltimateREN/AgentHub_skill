/**
 * ============================================================
 *  作者：UltimateREN
 *  日期：2026-11-10
 *  版权声明：本代码归 UltimateREN 所有。
 *    · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
 *    · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
 *    此注释为版权与授权声明，禁止删除。
 * ============================================================
 */
// Kiro 大图适配：上游 Base64 上限 5 MiB，超了要缩。
//
// 依据 Agent2Providers `kiro/image.rs`：解码 → 长边缩到 2000 → 先试 PNG，不行再试 JPEG。
// 本仓没有原生图像依赖，所以**只做 PNG**（截图类输入基本都是 PNG）：
//   解码（zlib inflate + 逐行反滤波）→ 2×2 盒式降采样 → 重编码（filter 0 + deflate）。
// JPEG 无法用纯 JS 重编码（要整套 DCT 编码器），保持「跳过不发」；
// 任何一步失败都返回 null —— 调用方据此不发图，绝不因为缩图失败打断对话。
"use strict";
const zlib = require("node:zlib");

/** 上游 Base64 字符数上限（与参考实现 IMAGE_LIMIT 同口径） */
const LIMIT = 5 * 1024 * 1024;
/** 参考实现的缩小长边 */
const EDGE = 2000;
/** 防图片炸弹：超过这个像素数直接放弃 */
const MAX_PIXELS = 50_000_000;

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
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(String(type), 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** PNG 解码：只支持 8 位、非隔行、colorType 0/2/4/6（覆盖截图与常见照片） */
function decodePng(bytes) {
  if (bytes.length < 8 || bytes.readUInt32BE(0) !== 0x89504e47) return null;
  let offset = 8;
  let header = null;
  const idat = [];
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (data.length !== length) return null;
    if (type === "IHDR") header = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  if (!header || !idat.length) return null;
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const depth = header[8];
  const colorType = header[9];
  const interlace = header[12];
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (depth !== 8 || !channels || interlace !== 0) return null;
  if (!width || !height || width * height > MAX_PIXELS) return null;
  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(idat)); } catch { return null; }
  const rowLength = width * channels;
  if (raw.length < height * (rowLength + 1)) return null;
  const out = Buffer.alloc(height * rowLength);
  let at = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[at++];
    const row = raw.subarray(at, at + rowLength);
    at += rowLength;
    const target = out.subarray(y * rowLength, (y + 1) * rowLength);
    const previous = y ? out.subarray((y - 1) * rowLength, y * rowLength) : null;
    for (let x = 0; x < rowLength; x++) {
      const left = x >= channels ? target[x - channels] : 0;
      const up = previous ? previous[x] : 0;
      const upLeft = previous && x >= channels ? previous[x - channels] : 0;
      let value = row[x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft);
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      target[x] = value & 0xff;
    }
  }
  return { width, height, channels, pixels: out };
}

/** 2×2 盒式降采样（奇数边按 1 像素平均） */
function halve(image) {
  const { width, height, channels, pixels } = image;
  const nextWidth = Math.max(1, Math.floor(width / 2));
  const nextHeight = Math.max(1, Math.floor(height / 2));
  const out = Buffer.alloc(nextWidth * nextHeight * channels);
  for (let y = 0; y < nextHeight; y++) {
    for (let x = 0; x < nextWidth; x++) {
      const x0 = x * 2, y0 = y * 2;
      const x1 = Math.min(x0 + 1, width - 1), y1 = Math.min(y0 + 1, height - 1);
      for (let c = 0; c < channels; c++) {
        const a = pixels[(y0 * width + x0) * channels + c];
        const b = pixels[(y0 * width + x1) * channels + c];
        const d = pixels[(y1 * width + x0) * channels + c];
        const e = pixels[(y1 * width + x1) * channels + c];
        out[(y * nextWidth + x) * channels + c] = (a + b + d + e) >> 2;
      }
    }
  }
  return { width: nextWidth, height: nextHeight, channels, pixels: out };
}

function encodePng(image) {
  const { width, height, channels, pixels } = image;
  const colorType = { 1: 0, 3: 2, 2: 4, 4: 6 }[channels];
  if (colorType === undefined) return null;
  const rowLength = width * channels;
  const raw = Buffer.alloc(height * (rowLength + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (rowLength + 1)] = 0;
    pixels.copy(raw, y * (rowLength + 1) + 1, y * rowLength, (y + 1) * rowLength);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = colorType;
  let compressed;
  try { compressed = zlib.deflateSync(raw, { level: 9 }); } catch { return null; }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header), chunk("IDAT", compressed), chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * 把一张图压到上限以内。
 * @param {{format:string, bytes:string}} image bytes 是 base64（**不含** data URL 前缀）
 * @returns {{format:string, bytes:string}|null} null = 放弃发送
 */
function fitImage(image) {
  try {
    const format = String(image?.format || "");
    const text = String(image?.bytes || "");
    if (!text) return null;
    if (text.length <= LIMIT) return { format, bytes: text };
    if (format !== "png") return null;
    let decoded = decodePng(Buffer.from(text, "base64"));
    if (!decoded) return null;
    // 先按参考实现把长边压到 2000，再按 2 的幂继续缩到体积达标
    while (Math.max(decoded.width, decoded.height) > EDGE) decoded = halve(decoded);
    let encoded = encodePng(decoded);
    while (encoded && encoded.toString("base64").length > LIMIT && decoded.width > 1 && decoded.height > 1) {
      decoded = halve(decoded);
      encoded = encodePng(decoded);
    }
    if (!encoded) return null;
    const bytes = encoded.toString("base64");
    return bytes.length <= LIMIT ? { format: "png", bytes } : null;
  } catch {
    return null;
  }
}

module.exports = { fitImage, decodePng, encodePng, halve, LIMIT, EDGE };
