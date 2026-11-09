"use strict";
// Explicit external integration: temporary signed, self-contained native package,
// original management/SQLite and actual gateway. No real account or upstream.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const http = require("node:http");
const core = fs.realpathSync(path.resolve(process.argv[2] || (() => { throw new Error("Explicit core project required for integration test"); })()));
const project = path.resolve(__dirname, "..");
const relative = path.relative(core, project);
assert.ok(relative && (relative.startsWith(".." + path.sep) || path.isAbsolute(relative)));
const hostRequire = require("node:module").createRequire(path.join(core, "package.json"));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ah-catpaw-formal-"));
process.env.AGENTHUB_DATA_DIR = path.join(temporary, "data");
process.env.AGENTHUB_PLUGIN_DIR = path.join(temporary, "plugins");
const { zip } = hostRequire("./scripts/test-extension-package.cjs");
const { signingPayload } = hostRequire("./electron/backend/extensions/manifest.cjs");
const { exportSdk } = hostRequire("./tools/provider-sdk.cjs");
const store = hostRequire("./electron/backend/proxy/store.cjs");
const pool = hostRequire("./electron/backend/proxy/pool.cjs");
const config = hostRequire("./electron/backend/config.cjs");
const settings = hostRequire("./electron/backend/localgw/config.cjs");
const services = hostRequire("./electron/backend/localgw/services.cjs");
const host = hostRequire("./electron/backend/plugin-host.cjs");
const scoped = hostRequire("./electron/backend/extensions/pool-runtime.cjs").getPoolRuntime(host);
const { createExtensionExecutor } = hostRequire("./electron/backend/localgw/extension-executor.cjs");
const forwarder = hostRequire("./electron/backend/localgw/forwarder.cjs");
const gateway = hostRequire("./electron/backend/localgw/server.cjs");
const keys = hostRequire("./electron/backend/localgw/keys-store.cjs");
const rules = hostRequire("./electron/backend/proxy/rules.cjs");
const oplog = hostRequire("./electron/backend/localgw/oplog.cjs");
let selections = 0, reads = 0;
const originalPick = pool.pickAccount, originalSecrets = store.accountSecrets;
pool.pickAccount = (...args) => { selections++; return originalPick(...args); };
store.accountSecrets = (...args) => { reads++; return originalSecrets(...args); };
const sends = [];
const upstream = http.createServer(async (req, res) => {
  let raw = ""; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  sends.push({ url: req.url, headers: req.headers, body });
  if (!req.url.endsWith("/turn")) { res.setHeader("content-type", "application/json"); res.end('{"code":0,"data":{}}'); return; }
  res.setHeader("content-type", "text/event-stream");
  res.end("data: " + JSON.stringify({ code: 0, data: { conversationId: body.conversationId,
    message: { type: "assistant", messageId: "formal", content: [{ type: "text", text: "CATPAW-PLUGIN" }], finished: true },
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } } }) + "\n");
});
function filesUnder(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(item => {
    const filename = path.join(directory, item.name);
    assert.ok(!fs.lstatSync(filename).isSymbolicLink(), "self-contained resources cannot be links");
    return item.isDirectory() ? filesUnder(filename) : [filename];
  });
}
async function main() {
  exportSdk(project, { check: true });
  services.configure({ host, poolService: scoped, executor: createExtensionExecutor({ pool, poolService: scoped,
    onSuccess: pool.noteSuccess, onFailure: forwarder.applyExtensionFailure }) });
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const template = JSON.parse(fs.readFileSync(path.join(project, "manifest.json")));
  const id = template.id, channel = "catpaw";
  host.init({ app: { getVersion: () => "1.99.0" }, bindExtensionSession: scoped.bindSession,
    extensionPolicy: { trustStore: new Map([["fixture-root", { publisher: template.publisher, pluginIds: [id], publicKey }]]) } });
  store.addAccount({ channel, uid: "paired-uid", token: "paired-catpaw-token", refreshToken: "private-refresh", source: "paste" });
  const account = store.listAccounts(channel)[0];
  pool.updateStatus(account.id, { status: "online", coolUntil: 0, coolReason: "" });
  fs.writeFileSync(path.join(rules.rulesDir(), "catalog.json"), JSON.stringify({
    catpaw: { models: [{ id: "formal-remote", name: "Formal Remote", modelType: 177 }] }
  }));
  rules.reload("catalog.json");
  const current = config.loadConfig();
  current.localgw = settings.normalize({ ...current.localgw, port: 19651, portCandidates: [19651, 19652, 19653],
    injectPrompt: false, requestTimeoutMs: 10000, routing: { failover: false, maxRetriesPerRequest: 1 },
    models: { custom: { "catpaw-view": { channel, real_model: "Formal Remote" } } } });
  config.saveConfig(current);
  const started = await gateway.start(); assert.equal(started.ok, true, started.message);
  const key = keys.create({ scopes: ["*"] });
  async function call(extra = {}) {
    const response = await fetch("http://127.0.0.1:" + started.port + "/v1/chat/completions", { method: "POST",
      headers: { authorization: "Bearer " + key.rawKey, "content-type": "application/json", "x-session-id": "formal-session" },
      body: JSON.stringify({ model: "catpaw-view", messages: [{ role: "user", content: "fixture" }], ...extra }) });
    return { status: response.status, text: await response.text() };
  }
  const before = { reads, selections };
  assert.equal((await call()).status, 503); assert.deepEqual({ reads, selections }, before);
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  // Native codec and its exact installed transitive dependencies are resources,
  // covered by the same signed hash manifest as src/sdk.
  const files = Object.fromEntries(["src", "sdk", "node_modules"].flatMap(name => filesUnder(path.join(project, name)))
    .map(filename => [path.relative(project, filename).replace(/\\/g, "/"), fs.readFileSync(filename)]));
  assert.ok(Object.keys(files).some(name => name.endsWith(".node")));
  const manifest = { ...template, runtime: { ...template.runtime, node: ">=22", platforms: [{ os: process.platform, arch: process.arch,
    ...(process.platform === "linux" ? { libc: "glibc" } : {}) }] }, dataSchema: 1,
    files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, crypto.createHash("sha256").update(bytes).digest("hex")])) };
  manifest.signature = { algorithm: "ed25519", keyId: "fixture-root", value: crypto.sign(null, signingPayload(manifest), privateKey).toString("base64") };
  const archive = path.join(temporary, "suite.zip");
  fs.writeFileSync(archive, zip([{ name: "manifest.json", data: JSON.stringify(manifest) },
    ...Object.entries(files).map(([name, data]) => ({ name, data, deflate: true }))]));
  const installed = await host.install(archive); assert.equal(installed.ok, true, installed.message);
  fs.mkdirSync(host.dataDir(id), { recursive: true });
  fs.writeFileSync(path.join(host.dataDir(id), "settings.json"), JSON.stringify({ catpaw: { baseUrl: "http://127.0.0.1:" + upstream.address().port } }));
  assert.equal((await host.authorize(id, { permissions: ["pool.forward-scoped", "network.outbound", "request.headers.read"], channels: [channel] })).ok, true);
  assert.equal((await host.toggle(id, true)).ok, true);
  assert.equal((await call()).status, 503); assert.deepEqual({ reads, selections }, before, "READY is not binding");
  services.setBinding(channel, { kind: "extension", pluginId: id, publisherId: template.publisher, providerId: channel, channel });
  // Generate a genuine noisy image. Its compressed upstream bytes demonstrate
  // that the installed child loaded its own native codec, not a fake test codec.
  const sharp = require(path.join(project, "node_modules/sharp"));
  const image = await sharp(crypto.randomBytes(1200 * 800 * 3), { raw: { width: 1200, height: 800, channels: 3 } }).png().toBuffer();
  const originalUrl = "data:image/png;base64," + image.toString("base64");
  const result = await call({ messages: [{ role: "user", content: [{ type: "text", text: "fixture" }, { type: "image_url", image_url: { url: originalUrl } }] }] });
  assert.equal(result.status, 200, result.text);
  assert.equal(JSON.parse(result.text).choices[0].message.content, "CATPAW-PLUGIN");
  assert.equal(JSON.parse(result.text).model, "catpaw-view");
  const round = sends.find(row => row.url.endsWith("/round"));
  assert.equal(round.body.modelType, 177); assert.equal(round.headers.cookie, "X-Passport-Token=paired-catpaw-token");
  assert.equal(round.headers["user-uid"], "paired-uid");
  assert.equal("authorization" in round.headers, false); assert.equal("x-api-key" in round.headers, false);
  const block = round.body.messages.flatMap(message => message.content).find(block => block.type === "image_url");
  assert.ok(block); assert.match(block.imageUrl.url, /^data:image\/jpeg;base64,/); assert.notEqual(block.imageUrl.url, originalUrl);
  const encoded = Buffer.from(block.imageUrl.url.split(",")[1], "base64"), metadata = await sharp(encoded).metadata();
  assert.ok(encoded.length < image.length); assert.ok(Math.max(metadata.width, metadata.height) <= 1568);
  assert.equal(sends.at(-1).body.data.status, "completed");
  const row = oplog.list({ limit: 100 }).rows.find(row => row.status === "success");
  assert.ok(row, "formal request logged");
  assert.equal(row.attempts[0].executionFacts[0].actualModel, "177");
  assert.doesNotMatch(JSON.stringify(row), /paired-catpaw-token|private-refresh|formal-session|data:image/);
  assert.equal(pool.inFlightCount(account.id), 0);
  const secrets = originalSecrets(store.getAccount(account.id));
  assert.equal(secrets.token, "paired-catpaw-token"); assert.equal(secrets.refreshToken, "private-refresh");
  assert.equal((await host.toggle(id, false)).ok, true);
  const stopped = { reads, selections, sends: sends.length };
  assert.equal((await call()).status, 503); assert.deepEqual({ reads, selections, sends: sends.length }, stopped);
  assert.equal((await host.uninstall(id)).ok, true); assert.equal((await call()).status, 503);
  assert.deepEqual({ reads, selections, sends: sends.length }, stopped);
  assert.equal(store.listAccounts(channel).length, 1);
  assert.equal(scoped.activeGrants, 0); assert.equal(scoped.activeRequests, 0);
  console.log("PASS CatPaw actual signed native package/install/authorization/binding/HTTP: numeric facts, original paired credentials, real image transcoding in installed child, terminal/logs, no account access on absent/unbound/stopped/uninstalled plugin");
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await gateway.stop(); scoped.close(); host.killAll();
  if (upstream.listening) { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); }
  hostRequire("./electron/backend/proxy/netproxy.cjs").closeAll();
  pool.pickAccount = originalPick; store.accountSecrets = originalSecrets;
  store.close(); fs.rmSync(temporary, { recursive: true, force: true });
});
