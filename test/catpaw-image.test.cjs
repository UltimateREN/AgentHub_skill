"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const sharp = require("sharp");
const runtime = require("../src/providers/catpaw/runtime-context.cjs");
const { codec, stats } = require("../src/providers/catpaw/image-codec.cjs");
const { compressIfNeeded, setCodec } = require("../src/providers/catpaw/imageCompress.cjs");
async function main() {
  const pixels = crypto.randomBytes(2000 * 1400 * 3);
  const input = await sharp(pixels, { raw: { width: 2000, height: 1400, channels: 3 } })
    .jpeg({ quality: 95 }).withMetadata({ orientation: 6 }).toBuffer();
  const signal = new AbortController().signal;
  await runtime.run({ signal }, async () => {
    const decoded = await codec.decode(input);
    assert.deepEqual([decoded.width, decoded.height], [1400, 2000], "EXIF orientation interpreted before resize");
    const small = codec.resize({ ...decoded, width: 100, height: 80 }, 1568);
    assert.deepEqual([small.width, small.height], [100, 80], "never enlarge");
    const original = "data:image/jpeg;base64," + input.toString("base64");
    const encoded = await compressIfNeeded(original);
    assert.notEqual(encoded, original); assert.match(encoded, /^data:image\/jpeg;base64,/);
    const output = Buffer.from(encoded.split(",")[1], "base64"), meta = await sharp(output).metadata();
    assert.ok(output.length < input.length);
    assert.ok(meta.height > meta.width); assert.ok(Math.max(meta.width, meta.height) <= 1568);
    assert.equal(await compressIfNeeded("data:image/png;base64,YQ=="), "data:image/png;base64,YQ==");
    await assert.rejects(codec.decode(Buffer.alloc(32 * 1024 * 1024 + 1)), /limit/);
    await assert.rejects(codec.decode(Buffer.from("invalid")));
    const oversized = await sharp({ create: { width: 4100, height: 4100, channels: 3, background: "white" } }).png().toBuffer();
    await assert.rejects(codec.decode(oversized), /pixel limit/);
  });
  const controller = new AbortController();
  const tasks = runtime.run({ signal: controller.signal }, () => Array.from({ length: 40 }, () => codec.decode(input)));
  // Attach handlers before abort, including queue overflow rejections.
  const settled = Promise.allSettled(tasks);
  assert.ok(stats().waiting <= 32); controller.abort(new Error("cancel-image"));
  assert.ok((await settled).every(result => result.status === "rejected"));
  const until = Date.now() + 3000;
  while (stats().active && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(stats(), { active: 0, waiting: 0 });
  const decisions = [];
  const original = "data:image/png;base64," + Buffer.alloc(300000).toString("base64");
  setCodec({
    decode: async () => ({ width: 2000, height: 1400 }),
    resize: async (handle, dimension) => { decisions.push(dimension); return handle; },
    encodeJpeg: async (_handle, quality) => { decisions.push(quality); return Buffer.alloc(200000); }
  });
  const result = await compressIfNeeded(original);
  assert.deepEqual(decisions, [1568, 80, 1568, 65, 1176, 55, 896, 55]);
  assert.notEqual(result, original);
  setCodec({ decode: () => { throw new Error("bad-image"); } });
  assert.equal(await compressIfNeeded(original), original, "original failure fallback preserved");
  setCodec(codec);
  console.log("PASS CatPaw independent sharp codec: native load/encoding, EXIF/no enlargement, pixel/input budgets, queue and cancellation, original quality/size loop and fallback");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
