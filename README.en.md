# AgentHub Enhanced Execution Plugin

English | [中文](./README.md)

AgentHub itself keeps the account-pool manager, the local gateway and the seven account operations (login, credential resolution, renewal, balance, check-in, claim, client account switching). Model execution for the channels lives in this separate process, talking to the host over stdin/stdout JSON-RPC.

The plugin inherits the repository-root `LICENSE` and its Additional Terms; any redistribution must carry them along. Before using this plugin, read the [Usage Statement](#usage-statement) and the [Statement (Full Version)](#statement-full-version).

English README of the same repository; [README.md](./README.md) is the authoritative Chinese version. Where the two differ, the Chinese text and `LICENSE` prevail.

## Boundaries

- If the host has no plugin installed, or the plugin is not bound, only standard custom providers can execute. There is no fallback to a legacy adapter, and no stale management catalog is ever presented as an execution source.
- The plugin does not parse login cookies, renew tokens, query balances, check in, or switch accounts. Those actions stay in the host; the plugin only receives credentials projected by a single grant.
- Credentials, context and catalogs are all read within the scope of that grant. Management entry points such as `pool.listAccounts` do not exist on the plugin side.

## Channels

`manifest.json` declares 32 provider IDs across 24 provider implementations (channel families). Dual-region / dual-pool channels are split into separate IDs:

| Family | provider ID | Channel | Catalog |
|---|---|---|---|
| Trae | `trae` | trae | account |
| Raccoon | `raccoon` | raccoon | account |
| Accio | `accio` / `accio_cn` | accio / accio_cn | account |
| CodeArts | `codearts` | codearts | account |
| ModelScope | `modelscope` / `modelscope_intl` | same | account |
| Lobster | `lobster` | lobster | account |
| CatPaw | `catpaw` | catpaw | account |
| MonkeyCode | `monkeycode` / `monkeycode_intl` | same | account |
| Kuku | `kuku` | kuku | account |
| Loomy | `loomy` | loomy | public |
| Cline | `cline_free` / `cline_pass` | cline_free / cline_pass | account |
| AutoClaw | `autoclaw` / `autoclaw_intl` | same | account |
| WorkBuddy | `workbuddy` | workbuddy / workbuddy_ai | account |
| Qoder | `qoder` / `qoder_intl` / `qwen_office` | same | account |
| CommandCode | `commandcode` | commandcode | account |
| OfficeAce | `officeace` | officeace | account |
| AtomCode | `atomcode` | atomcode | account |
| OrcaTerm | `orcaterm` | orcaterm | fixed |
| AStudio | `astudio` | astudio | account |
| DoubaoWork | `doubaowork` | doubaowork | account |
| Kiro | `kiro` | kiro | fixed |
| Antigravity | `antigravity` | antigravity | fixed |
| ZCode | `zcode` / `zcode_intl` | same | fixed |
| MiniMax | `minimax` | minimax | fixed |

`qwen_office_intl` (Qwen Work international) is implemented in code but **not declared in the manifest**, and the host-side switch is off as well. When it ships, the registration line in `src/main.cjs` has to be enabled together with the manifest entry — registering a channel that is not declared makes the host reject the whole package against its manifest.

## Catalog and execution

Each model entry returned by `listModels` carries only public fields: `id`, `name`, `rate`, `capabilities`, `contextLength`, `maxOutputTokens`, plus one `routing` object.

`routing` is the plugin's own data. The host performs bounded JSON validation only: it does not know the keys inside, and no brand-specific field or private protocol parsing is introduced into the host. After the host caches and normalizes the catalog, `routing` is preserved verbatim.

At execution time `routing` is read first, falling back to top-level keys of the same name on the entry. The fallback exists only for management snapshots that have not been refreshed yet; once every account has been refreshed once, `routing` alone is authoritative.

Keys each channel puts into `routing`:

- Accio: `upstreamKey` (the alias sent upstream), `protocolKind` (`properties` / `top`, decides where reasoning effort lands), `reasoningEfforts`
- CatPaw: `modelType` (numeric upstream ID)
- AutoClaw: `routeId` (private routing prefix)
- CodeArts: `source` (a benefit header is attached when it is `benefit`)
- WorkBuddy: `upstreamModel` (the name actually sent)
- MonkeyCode: `upstreamId`, `interfaceType`, `cliName`, `model`

Accio's outward-facing `id` uses stable names: when the upstream renames a model to an opaque alias, the display name is mapped back to the pre-alias name, so existing configurations need no change; only genuinely new models without an old name keep the alias. At execution time both the stable name and the alias are accepted.

## Fixed catalog

The ZCode, OrcaTerm, Kiro, Antigravity and MiniMax catalogs are decided by their clients, so they declare `modelRefresh: false` (including variants such as `zcode_intl`). On a manual refresh the host skips the call outright and reports "fixed model catalog, no remote refresh needed": it sends no forced catalog request, and it never touches balance, check-in, renewal or account switching.

When `modelRefresh` is omitted the catalog is treated as refreshable; an explicit `false` still allows a normal `listModels` call to return the fixed catalog.

## Release and auto-update

Release artifacts are built **per build-host platform**, all published into the same GitHub Release:

- `<id>-<version>-<platform>.zip`: the signed plugin package, where `<platform>` looks like `win32-x64` or `linux-x64-glibc`
- `plugin-index-<platform>.json`: the update manifest for that platform alone (its `url` points at the same-platform zip)
- `plugin-index.json`: the unsuffixed one, **written only by the win32/x64 build**, which is the existing address of the desktop built-in feed

Why split by platform: the packaging script signs the **native dependencies** from `node_modules` (`sharp`, `koffi`'s `.node` binaries) into the package and trims `manifest.runtime.platforms` down to the build host's single platform. A package built on Windows therefore fails the host's platform validation inside a Linux container (`electron/backend/extensions/manifest.cjs:146`) — building once more on an ubuntu runner is the reason the matrix exists, not an optional optimization.

Why the manifest is also split into separate files instead of "one entry per platform under the same id": the host's `electron/backend/plugin-feed.cjs:58-62` de-duplicates by `seen` **before** matching platforms, so only the first entry of a given id is honoured and any later entry for another platform is **silently swallowed** (no error, no update). This constraint is pinned as a regression by `test/packaging-feed.test.cjs`, which checks ordering in both directions.

Local packaging is a single step (this repository has no `build` script — earlier documentation got that wrong; and packaging must happen on the target platform, since a cross-built package carries a mismatched platform declaration):

```bash
AGENTHUB_PLUGIN_SIGNING_KEY=.release/plugin-signing-key.pem npm run package
```

`npm run package` equals `node tools/build-package.cjs dist` and requires the environment variable `AGENTHUB_PLUGIN_SIGNING_KEY` to point at an Ed25519 private key. The private key lives only on the release machine (`.release/` is git-ignored): it is never committed and never logged. In CI it is written from Secrets to `.release/plugin-signing-key.pem` and **`rm -rf .release` runs immediately after signing**.

Pushing a `v*` tag triggers `.github/workflows/release-plugin.yml`: the `windows-latest` and `ubuntu-latest` legs each run tests, signing and packaging, and the artifacts converge on a `publish` job that uploads them to one Release in a single pass (two concurrent uploads to the same Release would fight each other). The repository Secret `AGENTHUB_PLUGIN_SIGNING_KEY` must contain the full private key PEM.

arm64 (Synology ARM NAS) is deliberately **not packaged** today: the packaging script derives the platform declaration from the build host's own `process.platform/arch/libc`, so it only counts when it truly runs on a runner reporting `linux/arm64`, and both this machine and GitHub-hosted `ubuntu-latest` are x64. Adding one matrix line (pointing at a self-hosted or official arm64 runner) is all it will take; the script needs no change.

The manifest looks like this (one file per platform, with `platforms` and `url` referring to the same package):

```json
{
  "schema": 1,
  "plugins": [{
    "id": "com.agenthub.forwarding-suite",
    "version": "0.2.8",
    "minimumVersion": "",
    "minHostVersion": "",
    "platforms": [{ "os": "linux", "arch": "x64", "libc": "glibc" }],
    "url": "https://github.com/UltimateREN/AgentHub_skill/releases/download/v0.2.8/com.agenthub.forwarding-suite-0.2.8-linux-x64-glibc.zip",
    "sha256": "..."
  }]
}
```

An empty `minimumVersion` means no forced upgrade. Once set, installations below it are listed by the main program as required and get force-installed regardless of the "auto-update plugins" switch — that is the floor guarantee.

**`minimumVersion` release policy** (the container form differs from desktop, follow this exactly):

- Leave it **empty** by default. Only genuine hard incompatibilities qualify — "an older version would speak the wrong upstream protocol / would corrupt data". Adding channels or changing internals does not.
- The container has **no desktop-style fallback**: channels taken over by the plugin have no in-process fallback in the host, so if the plugin is down those channels return 503 outright. Force-upgrade windows must therefore be more conservative — prefer a manual upgrade on the plugins page over letting one feed change swap the execution engine of an unattended server.
- The value is injected from the CI repository variable `AGENTHUB_PLUGIN_MINIMUM_VERSION` (`Settings → Variables`), so neither code nor the manifest template changes. `AGENTHUB_PLUGIN_MIN_HOST_VERSION` works the same way to require a main-program version.
- Note the interaction with 4C: the container does **not run the automatic path by default**, so in a container "required" actually surfaces as "the updater lists this as must-upgrade", while installation still needs a human click (or `AGENTHUB_PLUGIN_AUTO_UPDATE=1` in compose to hand it to the automatic flow).

The main program ships an official public key (keyId `agenthub-release-2026`); the signature over the in-package manifest must verify before installation. `sha256` only guarantees transport integrity — the trust decision happens at the signature step.

The main program's settings page has two switches (**desktop form**):

- **Auto-update plugins**: when an enabled official plugin has a newer version, download, verify and install it automatically
- **Auto-download official plugins**: when an uninstalled official plugin is discovered, install it automatically; while this is on, a manual uninstall gets reverted by a re-install

With both switches off, routine updates pause, but an installed plugin below `minimumVersion` is still brought up to the floor.

**Container (Docker) form**: the defaults for these two switches are conservative — the automatic path (first check at startup +90 s, then one round per hour) does **not run** by default; to allow it explicitly, set `AGENTHUB_PLUGIN_AUTO_UPDATE=1` in compose. Manual "check for updates / install" is not gated by this and works as usual. The configuration file `config.json` is never rewritten by the container (overrides live in-process only).

Downloads go through the main program's own network egress; the plugin needs no proxy configuration of its kind. The egress semantics differ between the two forms (consolidated in `electron/backend/proxy/platform/`):

- Desktop: direct connection first (honouring the system proxy); on failure, environment-variable proxies are tried, then **locally listening** common proxy ports (7890 / 7897 / 10809 / 10808 / 8118)
- Container: only `HTTPS_PROXY` / `HTTP_PROXY` and friends are honoured, **no local port probing** — inside a container `127.0.0.1` is the container itself, so probing would be a guaranteed false negative

To point the container at a different feed address (at that platform's index file) there are two routes: write it from the plugins page / `PUT /api/plugins/feed` into the configuration, or set `AGENTHUB_PLUGIN_FEED` in compose's `environment` (example: `https://github.com/UltimateREN/AgentHub_skill/releases/latest/download/plugin-index-linux-x64-glibc.json`). Only `https:` is accepted; anything else is rejected and the built-in default feed is used instead.

Uninstallation removes only the plugin directory; `plugin-data/<id>` is kept. After a re-install, the plugin's own configuration and cache are still there.

## Commits and pushing

This repository belongs to `UltimateREN`; commits and pushes use that identity:

```bash
git config user.name "UltimateREN"
git config user.email "354340680+UltimateREN@users.noreply.github.com"
node tools/push.cjs
```

`tools/push.cjs` takes the UltimateREN token from `gh` and discards it after the push; it writes no global configuration.

This repository's credentials and commit history are independent of any other project — do not reuse credentials from elsewhere (e.g. GCM).

## Running

Node 22+ is required. The host launches `main.cjs` over stdio JSON-RPC; stdout carries the protocol only.

Private configuration lives in `AGENTHUB_PLUGIN_DATA_DIR/settings.json` and holds this plugin's execution settings only — no account-pool mirror, no master encryption key. With nothing configured, each channel's default domain is used.

The SDK is exported under control by the main project's `tools/provider-sdk.cjs`; at runtime there is no dependency on the main project. Use `--write` during development, and `--check` before acceptance and packaging to verify `sdk/source-lock.json` against file hashes.

Negotiated capabilities: `attempt-reservation@1`, `execution-facts@1`, `explicit-retry-policy@1`, `state-scope@1`, `request-headers@1`, `account-execution-epoch@1`. When a required capability is missing, the request is refused before any credential is read.

## Tests

`npm test` runs 26 scripts in sequence:

```
node test/network.test.cjs && node test/accio.test.cjs && node test/trae.test.cjs && ...
```

They cover per-channel catalog and execution, state isolation, content remediation, tools and usage, error classification, image encoding and cancellation. All of them use temporary directories, synthetic credentials and local HTTP — no real account is contacted.

The host side has its own loopback tests (run from the AgentHub root): `test-gateway-extension-execution.cjs` walks installation, authorization, the original SQLite account pool and real HTTP using a temporary signed package; `test-model-catalog.cjs` covers catalog caching, account isolation, TTL and manual refresh; `test-extension-pool-broker.cjs` covers grant scoping and live catalog injection.

## Diagnostic log

The plugin process's stdout is the JSON-RPC protocol channel and cannot carry logs; the host only counts stderr bytes and does not persist them (raw diagnostics may contain upstream bodies and identifiers). Failure triage therefore needs a record of the plugin's own:

- Location: `$AGENTHUB_PLUGIN_DATA_DIR/logs/plugin.log` (under the main program that is `plugin-data/<id>/logs/`)
- Content: **metadata only** — provider / channel / error code / category / scope / upstream status code / elapsed time
- Never recorded: prompts, bodies, tokens, cookies, URLs
- Rotation: 2 MiB per file, renamed to `.1` on overflow (one generation kept)
- Every write path is wrapped in try/catch; a failed write can never affect a model call

Exactly one line is written on the `invoke` failure path; successful calls pay nothing. The host log's `UPSTREAM_FAILED` is a desensitized generic code — which channel and which status code is settled by this line.

## Not done yet

- Acceptance against real accounts and real upstreams across all channels; only synthetic loopback coverage exists today.
- Long streams beyond five minutes, and cross-platform native dependencies (`sharp` for CatPaw) measured on the target platforms.
- Production signing, package hygiene and a proper release toolchain.
- Recovery of stateful tasks after a plugin process restart.

---

## Usage Statement

> Read this section in full before using the plugin. **By downloading, installing, enabling, invoking or otherwise using this plugin you are deemed to have read, understood and fully accepted the following terms.**

### 1. Study and exchange only

This plugin is a practice project for learning about **stdio JSON-RPC protocol negotiation between a separate plugin process and its host, use of upstream credentials projected through a single scoped grant, protocol adaptation and streaming (SSE / event stream) pass-through across many upstream channels, model-catalog normalization under OpenAI / Anthropic compatible protocols, cross-tool model catalog and account-scope management, Ed25519-signed packages with per-platform update manifests, and cross-platform packaging of native Node dependencies (`sharp` / `koffi`)**. It is intended for personal study and research only.

It is not an official product of anyone, and it is a third-party execution-side plugin for the host AgentHub (account-pool manager / local gateway). It has **no affiliation whatsoever** with the following companies and their products, and has received no authorization, endorsement, sponsorship or approval from them:

Tencent and WorkBuddy / CodeBuddy / Orcaterm, ByteDance and Trae / TRAE SOLO / Doubao, SenseTime and Raccoon (小浣熊), Zhipu and ZCode / AutoClaw / AutoGLM (`z.ai` / `bigmodel.cn`), Meituan and CatPaw, Alibaba and Qoder / Qwen Work / ModelScope / Accio, Huawei Cloud and CodeArts, iFlytek and Loomy / Astron Studio, NetEase Youdao and LobsterAI, Baidu and Kuku, MiniMax, AWS and Kiro, Google and Antigravity, Cline, GitCode and AtomCode, CommandCode, MonkeyCode, OfficeAce, DeepSeek and DeepSeek Harness, OpenAI and Codex, as well as any other service provider mentioned in the documentation, code or interface (including channels reached through a user-configured base URL).

Model names that appear in catalogs and requests (Anthropic Claude, OpenAI GPT, Google Gemini, Zhipu GLM, Qwen, Kimi / Moonshot, DeepSeek, MiniMax, Doubao and so on) likewise belong to their respective owners. This plugin **does not contain, redistribute or host any model**; it only forwards requests to the upstream tied to your own account.

All product names, trademarks, service names and protocol names appearing here belong to their respective owners and are used for identification and description only; nothing here implies any affiliation or authorization.

### 2. About credential handling and forwarding

This plugin **cannot be used on its own**: the seven actions — login, credential resolution, renewal, balance query, check-in, claim, and client account switching — are all performed by the host AgentHub (the account-pool manager). The plugin does not parse login cookies, and no management entry point such as `pool.listAccounts` exists on the plugin side.

The plugin only receives credentials projected by the host through a **single grant** (permission `pool.forward-scoped`) and reads credentials, context and catalogs strictly within that grant's scope, for the duration of one request, in order to forward that request to the corresponding upstream. Outbound traffic goes to the upstream only (`network.outbound`); the plugin **listens on no port and exposes no API of its own** — the OpenAI / Anthropic compatible endpoint on `127.0.0.1` belongs to the host's local gateway, and upstream credentials never leave the local process.

To make the forwarding protocol-equivalent to the official clients, a few channels read and pass through a small set of request headers (`request.headers.read`, e.g. `x-session-id`, `x-autoclaw-*`, `x-claude-code-session-id`).

It **does not crack or bypass any paid or permission check**, and the quota it spends is always the quota your own account already holds. It must be said clearly, however, that this style of forwarding — reusing a login session in the shape of a non-official client — **may be contrary to the terms of service or usage policies of the upstream services**. Whether to use it, and every consequence that follows (including but not limited to accounts being rate-limited, risk-flagged, deprioritized, frozen or banned, subscriptions being terminated, and credits or quota being zeroed), is **borne entirely by the user; the author accepts no liability whatsoever**.

The author has **not retrieved and checked the terms of each platform one by one**. Every statement here about "whether this complies with a platform's rules" is an inference from the shape of the behaviour and **does not constitute legal advice**; read and follow the terms of the services you use before you use this plugin.

### 3. Prohibited uses

This plugin may not be used for:

- any commercial purpose, redistribution for profit, or selling accounts or quota by means of this plugin
- bundling and selling, paid mirrors, **pointing the update feed at your own mirror so it poses as the official source**, or trading this plugin for sponsorship, advertising or traffic revenue
- bulk account registration, trading, renting, brushing, claim-on-behalf, or account farming
- bypassing upstream billing, quota, risk control or permission limits
- attacking, scraping, scanning or otherwise disrupting the normal operation of any service
- any other activity that violates the laws of your jurisdiction or the terms of the upstream services

These prohibitions are also written into Part Two of [LICENSE](./LICENSE) (Additional Terms). They form part of the license and usage agreement for this plugin; **they are not merely a request**.

To call the relevant model services in production or in a commercial setting, use the **official channels and official APIs**. Commercial use requires prior written authorization from the author.

### 4. Credential and data risk

- The private configuration `AGENTHUB_PLUGIN_DATA_DIR/settings.json` holds this plugin's execution settings only (channel domains, base URLs, and the like): no account-pool mirror and no master encryption key. It is still readable plaintext on your own disk — never commit it to a public repository or share it.
- The diagnostic log `logs/plugin.log` records **metadata only** (provider / channel / error code / category / scope / upstream status code / elapsed time), never prompts, bodies, tokens, cookies or URLs. Sharing a log directory verbatim is still not advisable.
- Uninstalling **removes the plugin directory only**; `plugin-data/<id>` is retained. Delete that directory yourself before handing over a machine or publishing it.
- Packages install only after their Ed25519 signature verifies against the public key built into the host (keyId `agenthub-release-2026`); `sha256` guarantees transport integrity only — trust is decided at the signature step. Never point the feed at an untrusted source.
- In the container form, channels taken over by the plugin have **no in-process fallback**: if the plugin is unavailable those channels return 503 outright. Treat force-upgrade windows with care on unattended servers (see [Release and auto-update](#release-and-auto-update)).
- Any loss caused by credential exposure, a device used by someone else, misconfiguration or operator error is **borne by the user; the author accepts no liability whatsoever**.

### 5. No warranty and notice of rights

This plugin is provided "AS IS". The author makes **no express or implied commitment or warranty about its availability, stability, security, legality, accuracy or fitness for a particular purpose**.

- Upstream interfaces, authentication schemes and protocol fields may change at any time, and the host plugin API (`host.api: >=1.0.0 <2.0.0`) may evolve as well. This plugin may stop working at any time and may never be maintained again; the author owes no updates, fixes or answers.
- For any direct or indirect loss caused by using this plugin (including but not limited to account loss, quota loss, data loss, business interruption, third-party claims and regulatory penalties), **the author accepts no liability whatsoever**.
- The interface shapes, protocol fields and similar information in this plugin were obtained by **observing and organizing the public network traffic of the official clients**, for study and research only; the trademarks and services involved belong to their respective owners.
- If a rights holder finds anything improper in this plugin, please contact the author and it will be adjusted or removed promptly.

**The full terms are in [LICENSE](./LICENSE).** If you disagree with any item in this section, stop using this plugin immediately and delete it along with its data.

## Author

**UltimateREN** (GitHub: [@UltimateREN](https://github.com/UltimateREN))

## License

This plugin is distributed under a **composite license: [MIT License](./LICENSE) + Additional Terms**. It is **not a plain MIT project**:

| Part | Content |
| --- | --- |
| Part One · MIT License | Grants the rights to use, copy, modify, merge, publish, distribute, sublicense and sell the software |
| Part Two · Additional Terms | Further restricts the usage context: no commercial use, no redistribution for profit, no bulk account operations, no bypassing upstream billing or quota, no attacking or disrupting, no unlawful use |

The two parts are **inseparable** and together form the complete license and usage agreement for this plugin. Anyone accepting only one part may not use, copy, modify or distribute this plugin in any form. The Additional Terms are consistent with section 3 ("Prohibited uses") of the [Usage Statement](#usage-statement) above; where the wording differs, [LICENSE](./LICENSE) prevails.

Redistribution (including bundling into another distribution or running your own update source) must carry [LICENSE](./LICENSE) and this statement unchanged. Commercial use requires prior written authorization from the author.

Copyright (c) 2026 UltimateREN

---

## Statement (Full Version)

> This section is the complete statement for the use of this plugin, consistent with the [Usage Statement](#usage-statement) above; **where the two differ, [LICENSE](./LICENSE) prevails**.

### Study and exchange only

This plugin is a practice project for learning about **stdio JSON-RPC protocol negotiation between a separate plugin process and its host, use of upstream credentials projected through a single scoped grant, protocol adaptation and streaming pass-through across many upstream channels, model-catalog normalization under OpenAI / Anthropic compatible protocols, cross-tool model catalog management, Ed25519-signed packages with per-platform update manifests, and cross-platform packaging of native Node dependencies**. It is intended for personal study and research only.

It is not an official product, and it cannot run apart from its host — account management and login sessions always stay on the AgentHub side. It has **no affiliation whatsoever** with the following companies and their products, and has received no authorization, endorsement or sponsorship:

Tencent and WorkBuddy / CodeBuddy / Orcaterm, ByteDance and Trae / TRAE SOLO / Doubao, SenseTime and Raccoon, Zhipu and ZCode / AutoClaw / AutoGLM, Meituan and CatPaw, Alibaba and Qoder / Qwen Work / ModelScope / Accio, Huawei Cloud and CodeArts, iFlytek and Loomy / Astron Studio, NetEase Youdao and LobsterAI, Baidu and Kuku, MiniMax, AWS and Kiro, Google and Antigravity, Cline, GitCode and AtomCode, CommandCode, MonkeyCode, OfficeAce, DeepSeek and DeepSeek Harness, OpenAI and Codex, as well as any other service provider mentioned in the documentation, code or interface.

All product names, trademarks, service names and protocol names appearing here belong to their respective owners and are used for identification and description only. Model names appearing in catalogs and requests (Claude / GPT / Gemini / GLM / Qwen / Kimi / DeepSeek / MiniMax / Doubao and so on) also belong to their respective owners: this plugin does not contain, redistribute or host any model.

### About credential handling and forwarding

The account-pool manager reuses the login session of **your own account** on your own machine, for balance queries, check-in and account management — that capability lives inside the host AgentHub, and this plugin takes no part in it: it does not parse login cookies, does not renew tokens, does not query balances, does not check in, does not switch accounts, and offers no account-management entry point.

This plugin does one thing: it takes the credentials projected by the host through a single grant (`pool.forward-scoped`) and forwards each request to the corresponding upstream within that grant's scope, streaming the response back. It listens on no port and exposes no API. Exposing the upstreams you configured yourself over the **OpenAI / Anthropic compatible protocol** on `127.0.0.1` (no auto-start by default, loopback-only by default, upstream credentials never leaving the local process) is the host's local gateway. A few channels read and pass through a small set of request headers in order to match official client behaviour (`request.headers.read`).

It does not crack or bypass any paid or permission check, and the quota spent always comes from what your own account already holds. It must be said clearly, though, that this style of forwarding — reusing a login session in the shape of a non-official client — **may be contrary to the terms of service or usage policies of the upstream services**; whether to use it, and every consequence that follows (including but not limited to accounts being rate-limited, risk-flagged, deprioritized, frozen or banned, subscriptions terminated, and credits or quota zeroed), is **borne entirely by the user, with no liability on the author**.

The author has not checked each platform's terms one by one; the statements above are inferences from the shape of the behaviour and do not constitute legal advice.

### Prohibited uses

This plugin may not be used for any commercial purpose, redistribution for profit, selling accounts or quota by means of this plugin, bundling and selling, paid mirrors, pointing the update feed at a self-hosted mirror so it poses as the official source, trading this plugin for sponsorship, advertising or traffic revenue, bulk account operations, brushing or claim-on-behalf, account farming, bypassing upstream billing or quota limits, attacking or disrupting the normal operation of any service, or any other activity that violates local law or the terms of the upstream services.

To call the relevant model services in production or in a commercial setting, use the **official channels and official APIs**; commercial use requires prior written authorization from the author.

### Credential and data risk

This plugin keeps a private configuration file and a diagnostic log on your machine: `settings.json` holds this plugin's execution settings only (no account-pool mirror, no master encryption key), and `logs/plugin.log` records metadata only — never prompts, bodies, tokens, cookies or URLs. Uninstalling removes the plugin directory while `plugin-data/<id>` retains your configuration and cache; delete it yourself before handing a machine to someone else or publishing it.

Packages install only after their Ed25519 signature verifies against the host's built-in public key; `sha256` guarantees transport integrity alone, so never point the update source at an untrusted address. Any loss caused by exposed credentials or configuration, a device used by someone else, operator error, or an untrusted update source is **borne by the user; the author accepts no liability whatsoever**.

### No warranty and notice of rights

This plugin is provided "AS IS", and the author makes no commitment about its availability, stability, security or fitness for a particular purpose. Upstream interfaces and the host's plugin protocol may change at any time; this plugin may stop working at any time and may never be maintained again, and the author owes no updates, fixes or answers.

The interface shapes, protocol fields and similar information in this plugin were obtained by **observing and organizing the public network traffic of the official clients**, for study and research only; the trademarks and services involved belong to their respective owners. If a rights holder finds anything improper in this plugin, please contact the author and it will be adjusted or removed promptly.

**The full terms are in [LICENSE](./LICENSE).** If you disagree with any item in this section, stop using this plugin immediately and delete it along with its related data.
