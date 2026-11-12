# AgentHub 增强执行插件

[English](./README.en.md) | 中文

AgentHub 本体保留号池管家、本地网关和七项账号管理（登录、凭据解析、续期、余额、签到、领取、客户端切号）。渠道的模型执行搬到这个独立进程里，通过 stdin/stdout JSON-RPC 与宿主通信。

插件继承根目录的 `LICENSE` 及附加条款，再分发必须带上它。使用本插件前请先读 [使用声明](#使用声明) 与 [声明（完整版）](#声明完整版)。

## 边界

- 本体没有安装或没有绑定插件时，只能执行标准自定义供应商。不会退回旧 adapter，也不会读旧管理目录冒充执行来源。
- 插件不解析登录 Cookie、不续期、不查余额、不签到、不切号。这些动作仍由本体完成，插件只拿单次 grant 投影出来的凭据。
- 凭据、上下文、目录都按 grant 作用域读取。`pool.listAccounts` 这类管理入口在插件侧不存在。

## 渠道

`manifest.json` 声明 32 个 provider ID，对应 24 个 provider 实现（渠道家族）。双区/双池的渠道拆成独立 ID：

| 家族 | provider ID | 渠道 | 目录 |
|---|---|---|---|
| Trae | `trae` | trae | 账号 |
| Raccoon | `raccoon` | raccoon | 账号 |
| Accio | `accio` / `accio_cn` | accio / accio_cn | 账号 |
| CodeArts | `codearts` | codearts | 账号 |
| ModelScope | `modelscope` / `modelscope_intl` | 同名 | 账号 |
| Lobster | `lobster` | lobster | 账号 |
| CatPaw | `catpaw` | catpaw | 账号 |
| MonkeyCode | `monkeycode` / `monkeycode_intl` | 同名 | 账号 |
| Kuku | `kuku` | kuku | 账号 |
| Loomy | `loomy` | loomy | 公开 |
| Cline | `cline_free` / `cline_pass` | cline_free / cline_pass | 账号 |
| AutoClaw | `autoclaw` / `autoclaw_intl` | 同名 | 账号 |
| WorkBuddy | `workbuddy` | workbuddy / workbuddy_ai | 账号 |
| Qoder | `qoder` / `qoder_intl` / `qwen_office` | 同名 | 账号 |
| CommandCode | `commandcode` | commandcode | 账号 |
| OfficeAce | `officeace` | officeace | 账号 |
| AtomCode | `atomcode` | atomcode | 账号 |
| OrcaTerm | `orcaterm` | orcaterm | 固定 |
| AStudio | `astudio` | astudio | 账号 |
| DoubaoWork | `doubaowork` | doubaowork | 账号 |
| Kiro | `kiro` | kiro | 固定 |
| Antigravity | `antigravity` | antigravity | 固定 |
| ZCode | `zcode` / `zcode_intl` | 同名 | 固定 |
| MiniMax | `minimax` | minimax | 固定 |

`qwen_office_intl`（千问办公国际版）代码已实现但**未写进 manifest**，宿主侧开关也关着；放量时要连同 `src/main.cjs` 的注册行一起打开——只注册未声明的渠道，宿主会按清单拒收整包。

## 目录与执行

`listModels` 返回的每条模型只带公共字段：`id`、`name`、`rate`、`capabilities`、`contextLength`、`maxOutputTokens`，加上一个 `routing`。

`routing` 是插件自己的数据，宿主只做有界 JSON 校验，不认识里面的键，也不引入任何品牌字段或私有协议解析。目录经宿主缓存、归一化后，`routing` 原样保留。

执行时先读 `routing`，没有则回退到条目顶层的同名键。回退是为了兼容还没刷新过的旧管理快照，等账号都刷过一遍就可以只认 `routing`。

各渠道放在 `routing` 里的键：

- Accio：`upstreamKey`（发给上游的代号）、`protocolKind`（`properties` / `top`，决定思考档位落点）、`reasoningEfforts`
- CatPaw：`modelType`（上游数字 ID）
- AutoClaw：`routeId`（私有路由前缀）
- CodeArts：`source`（`benefit` 时带福利头）
- WorkBuddy：`upstreamModel`（真实发送名）
- MonkeyCode：`upstreamId`、`interfaceType`、`cliName`、`model`

Accio 的对外 `id` 走稳定名：上游把模型名换成不透明代号后，按展示名映射回代号之前的名字，老配置不用改；新模型没有老名字才用代号。执行时同时接受稳定名和代号。

## 固定目录

ZCode、OrcaTerm、Kiro、Antigravity、MiniMax 的目录由客户端决定，声明 `modelRefresh: false`（含 `zcode_intl` 等变体）。手动刷新时宿主直接跳过并提示「固定模型目录，无需远程刷新」，不会发强制目录请求，也不会碰余额、签到、续期或切号。

`modelRefresh` 省略时按可刷处理；显式 `false` 仍允许普通 `listModels` 返回固定目录。

## 发布与自动更新

发布产物按**构建机平台**各出一份，都放在同一个 GitHub Release 里：

- `<id>-<version>-<platform>.zip`：签名后的插件包，`<platform>` 形如 `win32-x64`、`linux-x64-glibc`
- `plugin-index-<platform>.json`：该平台自己的更新清单（url 指向同平台的 zip）
- `plugin-index.json`：不带后缀的那份，**只由 win32/x64 构建写出**，是桌面版内置 feed 的既有地址

为什么要按平台分：打包脚本会把 `node_modules` 里的**原生依赖**（`sharp`、`koffi` 的 `.node`）一起签进包，并把 `manifest.runtime.platforms` 裁成构建机那一个平台。所以 Windows 上构建出来的包在 Linux 容器里过不了宿主的平台校验（`electron/backend/extensions/manifest.cjs:146`），必须在 ubuntu runner 上再构建一次 —— 这是矩阵存在的理由，不是可选优化。

为什么清单也要分文件、而不是「同一个 id 每个平台各写一条」：宿主的 `electron/backend/plugin-feed.cjs:58-62` 在**匹配平台之前**就用 `seen` 去重，同一个 id 只认第一条，排在前面的那条会把后面平台的条目**静默吞掉**（不报错、不更新）。这条约束由 `test/packaging-feed.test.cjs` 钉成回归，两个方向的顺序都验过。

本地打包就是一步（本仓库没有 `build` 脚本，早期文档写错过；且要在目标平台上打，跨平台打出来的包平台声明会不合）：

```bash
AGENTHUB_PLUGIN_SIGNING_KEY=.release/plugin-signing-key.pem npm run package
```

`npm run package` 等于 `node tools/build-package.cjs dist`，需要环境变量 `AGENTHUB_PLUGIN_SIGNING_KEY` 指向 Ed25519 私钥。私钥只放发布机（`.release/` 已被忽略），不入库、不进日志；CI 里从 Secrets 落到 `.release/plugin-signing-key.pem`，**签完立刻 `rm -rf .release`**。

推 `v*` tag 会触发 `.github/workflows/release-plugin.yml`：`windows-latest` 与 `ubuntu-latest` 两条 leg 各自跑测试 + 签名 + 出包，产物汇到 `publish` job 一次性传到同一个 Release（并发直接传同一个 Release 会互相抢）。需要在仓库 Secrets 里配 `AGENTHUB_PLUGIN_SIGNING_KEY`，内容是私钥 PEM 全文。

arm64（群晖 ARM NAS）目前**不出包**：打包脚本按构建机自报的 `process.platform/arch/libc` 裁剪平台声明，所以必须真跑在一台能报出 `linux/arm64` 的 runner 上才作数；本机和 GitHub 托管的 `ubuntu-latest` 都是 x64。将来加一行 matrix（指向 self-hosted 或官方 arm64 runner）即可，脚本无需改动。

清单长这样（每个平台各一份文件，`platforms` 与 `url` 指的是同一个包）：

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

`minimumVersion` 留空表示不强制升级。填了之后，低于它的安装会被主程序列为 required 强制补齐，不受「自动更新插件」开关影响 —— 这是最低版本兜底。

**`minimumVersion` 的发布策略**（容器形态与桌面不同，务必按这条来）：

- 默认**留空**。只有「旧版本会打错上游协议 / 会写坏数据」这类硬不兼容才填，加新渠道、改内部实现都不属于。
- 容器里**没有桌面兜底**：被插件接管的渠道在宿主内没有进程内回退，插件挂了该渠道直接 503。所以强制升级窗口要更保守 —— 宁可在插件页手动升，也不要让一次 feed 改动把无人值守的服务器同时换掉执行引擎。
- 值是 CI 仓库变量 `AGENTHUB_PLUGIN_MINIMUM_VERSION` 注入的（`Settings → Variables`），不改代码、不改 manifest 模板；`AGENTHUB_PLUGIN_MIN_HOST_VERSION` 同理，用于要求主程序版本。
- 与 4C 的交互要知道：容器默认**不跑自动链路**，所以 required 在容器里的实际表现是「更新卡列出这条必须升级」，安装仍要人点（或在 compose 里显式 `AGENTHUB_PLUGIN_AUTO_UPDATE=1` 交给自动流程）。

主程序内置官方公钥（keyId `agenthub-release-2026`），包内 manifest 的签名必须对得上才会装。`sha256` 只保证传输完整，信任判断在签名那一步。

主程序的设置页有两个开关（**桌面形态**）：

- **自动更新插件**：已启用的官方插件有新版本时自动下载、校验、安装
- **自动下载官方插件**：发现未安装的官方插件时自动装；开着的时候手动卸载也会被装回来

两个开关都关掉后，日常更新暂停，但已安装插件低于 `minimumVersion` 时仍会补齐。

**容器（Docker）形态**：这两个开关的默认值是 conservative —— 自动链路（启动 +90s 首查、之后每小时一轮）默认**不跑**，要显式放行就在 compose 里设 `AGENTHUB_PLUGIN_AUTO_UPDATE=1`。手动「检查更新 / 安装」不受这个闸约束，照常可用。配置文件 `config.json` 不会被容器改写（覆盖只活在进程内）。

下载走主程序自己的网络出口，插件不需要任何代理配置。两种形态的出口口径不同（收口在 `electron/backend/proxy/platform/`）：

- 桌面：先直连（认系统代理），失败再依次试环境变量代理与**本机在监听的**常见代理端口（7890 / 7897 / 10809 / 10808 / 8118）
- 容器：只认 `HTTPS_PROXY` / `HTTP_PROXY` 等环境变量，**不探本机端口** —— 容器里的 `127.0.0.1` 是容器自己，探了必然假阴性

容器要换 feed 地址（指到本平台那份索引）有两条路：插件页/`PUT /api/plugins/feed` 写进配置，或在 compose 的 `environment` 里给 `AGENTHUB_PLUGIN_FEED`（例：`https://github.com/UltimateREN/AgentHub_skill/releases/latest/download/plugin-index-linux-x64-glibc.json`）。只接受 `https:`，非 https 会被拒绝并回落内置默认源。

卸载只删插件目录，`plugin-data/<id>` 保留。装回来之后插件自己的配置和缓存还在。

## 提交与推送

这个仓库属于 `UltimateREN`，提交和推送都用这个身份：

```bash
git config user.name "UltimateREN"
git config user.email "354340680+UltimateREN@users.noreply.github.com"
node tools/push.cjs
```

`tools/push.cjs` 只从 gh 里取 UltimateREN 的 token，推完即弃，不写全局配置。

本仓库的凭据与提交记录独立于任何其它项目，不要套用别处的 GCM 凭据。

## 运行

需要 Node 22+。宿主以 stdio JSON-RPC 启动 `main.cjs`，stdout 只输出协议。

私有配置在 `AGENTHUB_PLUGIN_DATA_DIR/settings.json`，只放本插件的执行设置，不放号池镜像或主加密密钥。没配置时用渠道默认域名。

SDK 由主工程的 `tools/provider-sdk.cjs` 受控导出，运行时不依赖主工程。开发用 `--write`，验收和打包前用 `--check` 核对 `sdk/source-lock.json` 与文件哈希。

协商特征：`attempt-reservation@1`、`execution-facts@1`、`explicit-retry-policy@1`、`state-scope@1`、`request-headers@1`、`account-execution-epoch@1`。缺必需特征时在读取凭据前就拒绝。

## 测试

`npm test` 顺序跑 26 个脚本：

```
node test/network.test.cjs && node test/accio.test.cjs && node test/trae.test.cjs && ...
```

覆盖各渠道目录与执行、状态隔离、内容补救、工具与 usage、错误分类、图片编码和取消。全部使用临时目录、合成凭据和本地 HTTP，不连真实账号。

宿主侧另有几条回环测试（在 AgentHub 根目录跑）：`test-gateway-extension-execution.cjs` 用临时签名包走完安装、授权、原 SQLite 号池和正式 HTTP；`test-model-catalog.cjs` 覆盖目录缓存、账号隔离、TTL 和手动刷新；`test-extension-pool-broker.cjs` 覆盖 grant 作用域与实时目录注入。

## 诊断日志

插件进程的 stdout 是 JSON-RPC 协议通道，不能打日志；宿主也只统计 stderr 字节数、不落库
（原始诊断可能含上游正文与标识）。于是失败排障需要一份插件自己的记录：

- 位置：`$AGENTHUB_PLUGIN_DATA_DIR/logs/plugin.log`（主程序里就是 `plugin-data/<id>/logs/`）
- 内容：**只记元数据** —— provider / channel / 错误码 / 类别 / 作用域 / 上游状态码 / 已耗时
- 不记：prompt、正文、token、Cookie、URL
- 滚动：单文件 2 MiB，超了改名 `.1`（只留一代）
- 写盘失败全路径 try/catch，绝不影响模型调用

只在 `invoke` 的失败路径写一条，正常调用零开销。宿主日志里的 `UPSTREAM_FAILED` 是脱敏后的
笼统码，具体是哪家、什么状态码靠这条对。

## 还没做的

- 真实账号和真实上游的全渠道验收，目前只有合成回环。
- 五分钟以上的长流、跨平台原生依赖（CatPaw 的 sharp）在目标平台的实测。
- 生产签名、安装包纯净度和正式发布工具链。
- 插件进程重启后的有状态任务恢复。

---

## 使用声明

> 请在使用本插件前完整阅读本节。**下载、安装、启用、调用或以任何方式使用本插件，即视为你已阅读、理解并全部接受以下条款。**

### 一、仅供学习与交流

本插件是一个用于学习 **独立插件进程与宿主的 stdio JSON-RPC 协议协商、按单次 grant 作用域投影的上游凭据使用、多上游渠道的协议适配与流式（SSE / event stream）透传、OpenAI / Anthropic 兼容协议下的模型目录归一化、跨工具模型目录与账号作用域管理、Ed25519 签名包与按平台矩阵的自动更新清单、Node 原生依赖（`sharp` / `koffi`）跨平台打包** 等技术主题的实践项目，仅供个人学习与研究使用。

它不是任何公司的官方产品，是宿主 AgentHub（号池管家 / 本地网关）的第三方执行侧插件，与下列公司及其产品**均无任何关联**，未获得其授权、认可、赞助或背书：

腾讯及 WorkBuddy / CodeBuddy / Orcaterm，字节跳动及 Trae / TRAE SOLO / 豆包（Doubao），商汤科技及小浣熊（Raccoon），智谱及 ZCode / AutoClaw / AutoGLM（`z.ai` / `bigmodel.cn`），美团及 CatPaw，阿里巴巴及 Qoder / 千问办公（Qwen Work）/ ModelScope（魔搭）/ Accio，华为云及 CodeArts，科大讯飞及 Loomy / Astron Studio，网易有道及 LobsterAI，百度及 Kuku，MiniMax，AWS 及 Kiro，Google 及 Antigravity，Cline，GitCode 及 AtomCode，CommandCode，MonkeyCode，OfficeAce，DeepSeek 及 DeepSeek Harness，OpenAI 及 Codex，以及其他在文档、代码或界面中提及的服务提供方（含按自定义基址接入的渠道）。

目录与请求中出现的模型名称（Anthropic Claude、OpenAI GPT、Google Gemini、智谱 GLM、通义千问 Qwen、月之暗面 Kimi、DeepSeek、MiniMax、豆包 Doubao 等）同样归其各自所有者。本插件**不包含、不重新分发、也不托管任何模型**，只把请求转发到使用者自己账号对应的上游。

文中出现的所有产品名、商标、服务名、协议名均归其各自所有者，仅用于标识与说明用途，不构成任何形式的关联或授权。

### 二、关于凭据与转发行为

本插件**不能独立使用**：登录、凭据解析、续期、余额查询、签到、领取、客户端切号这七项动作全部由宿主 AgentHub（号池管家）完成，插件不解析登录 Cookie，插件侧也不存在 `pool.listAccounts` 这类账号管理入口。

插件只拿到宿主按**单次 grant** 投影出来的凭据（权限 `pool.forward-scoped`），凭据、上下文与目录都按该 grant 的作用域读取，用完即止，用于把这一次请求转发到对应上游。出网只走上游（`network.outbound`）；插件本身**不监听任何端口、不对外提供 API**——把上游以 OpenAI / Anthropic 兼容协议暴露在 `127.0.0.1` 是宿主本地网关的行为，上游凭据不出本机进程。

为使转发在协议层面与官方客户端等价，个别渠道会读取并透传少量请求头（`request.headers.read`，如 `x-session-id`、`x-autoclaw-*`、`x-claude-code-session-id`）。

它**不破解、不绕过任何付费或权限校验**，使用的额度始终来自你自己账号本就拥有的配额。但需要明确的是，这种「以非官方客户端形态复用登录态」的转发方式，**可能不符合上游服务的用户协议或使用条款**；是否使用、以及由此产生的一切后果（包括但不限于账号被限流、被风控、被降权、被冻结或封禁，订阅被终止，积分/额度被清零），**均由使用者自行承担，作者不承担任何责任**。

作者**未逐家取回并核对各平台的条款原文**，本节关于「是否符合平台规则」的表述均为基于行为形态的推断，**不构成法律意见**；请在使用前自行阅读并遵守你所用服务的条款。

### 三、禁止用途

禁止将本插件用于：

- 任何商业用途、二次分发牟利、以本插件为载体售卖账号或额度
- 打包售卖、付费镜像、**把更新 feed 指到自建镜像站冒充官方源**、以本插件换取赞助、广告或流量分成
- 批量账号注册、买卖、租借、代刷、代领、养号
- 绕过上游计费、配额、风控或权限限制
- 攻击、爬取、扫描或干扰任何服务的正常运行
- 其他违反使用者所在地法律法规或上游服务条款的活动

上述禁止事项同时写入 [LICENSE](./LICENSE) 第二部分的「附加使用条款」，构成本插件授权与使用约定的一部分，**不是仅作呼吁**。

如需在生产环境或商业场景中调用相关模型服务，请使用**官方渠道与官方 API**；商业使用须事先取得作者书面授权。

### 四、凭证与数据风险

- 私有配置 `AGENTHUB_PLUGIN_DATA_DIR/settings.json` 只放本插件的执行设置（渠道域名、基址等），不放号池镜像，也不放主程序加密密钥；但它仍在你本机磁盘上明文可读，请勿提交到公开仓库或分享。
- 诊断日志 `logs/plugin.log` **只记元数据**（provider / channel / 错误码 / 类别 / 作用域 / 上游状态码 / 耗时），不记 prompt、正文、token、Cookie、URL；仍不建议把日志目录原样外传。
- 卸载**只删插件目录**，`plugin-data/<id>` 会保留。换机、转交他人或公开机器前，请自行删除该目录。
- 插件包经 Ed25519 签名校验（内置公钥 keyId `agenthub-release-2026`）才会安装；`sha256` 只保证传输完整，信任判断在签名那一步。不要把 feed 指向不可信来源。
- 容器形态下被插件接管的渠道**没有进程内回退**：插件不可用时该渠道直接 503。无人值守服务器请谨慎对待强制升级窗口（详见[发布与自动更新](#发布与自动更新)）。
- 因凭据泄露、设备被他人使用、配置不当或误操作造成的任何损失，**由使用者自行承担，作者不承担任何责任**。

### 五、无担保与权利通知

本插件按「现状」（AS IS）提供，作者**不对其可用性、稳定性、安全性、合法性、准确性或对特定用途的适用性作任何明示或默示的承诺与保证**。

- 上游接口、鉴权方式、协议字段随时可能变更；宿主插件 API（`host.api: >=1.0.0 <2.0.0`）同样可能演进。本插件可能随时失效且不再维护，作者无更新、修复或答疑的义务
- 使用本插件造成的任何直接或间接损失（包括但不限于账号损失、额度损失、数据丢失、业务中断、第三方索赔、监管处罚），**作者一概不承担任何责任**
- 本插件中的接口形态、协议字段等信息来自对各官方客户端**公开网络通信的观察与整理**，仅用于学习研究；相关商标与服务的权利归其各自所有者
- 若权利方认为本插件存在不当之处，请联系作者，将及时调整或删除

**完整条款见 [LICENSE](./LICENSE)。** 若你不同意本节任何一条，请立即停止使用并删除本插件及其相关数据。

## 作者

**UltimateREN**（GitHub: [@UltimateREN](https://github.com/UltimateREN)）

## License

本插件采用 **[MIT License](./LICENSE) + 附加使用条款** 的**复合授权**，**不是纯粹的 MIT 项目**：

| 部分 | 内容 |
| --- | --- |
| 第一部分 · MIT License | 授予软件层面的使用、复制、修改、合并、发布、分发、再许可与销售权利 |
| 第二部分 · 附加使用条款 | 对使用场景作进一步限制：禁止商业用途、禁止二次分发牟利、禁止批量账号运营、禁止绕过上游计费与配额、禁止攻击与干扰、禁止违法用途 |

两部分**不可分割**，共同构成本插件完整的授权与使用约定；仅接受其中一部分者，不得以任何形式使用、复制、修改或分发本插件。附加条款与上文[使用声明](#使用声明)第三节「禁止用途」一致，如表述有出入以 [LICENSE](./LICENSE) 为准。

再分发（含打包进其它发行版、自建更新源）必须原样携带 [LICENSE](./LICENSE) 与本节声明。商业场景使用须事先联系作者另行取得书面授权。

Copyright (c) 2026 UltimateREN

---

## 声明（完整版）

> 本节是使用本插件的完整声明，与上文[《使用声明》](#使用声明)一致；**如有出入，以 [LICENSE](./LICENSE) 为准**。

### 仅供学习与交流

本插件是一个用于学习 **独立插件进程与宿主的 stdio JSON-RPC 协议协商、按单次 grant 作用域投影的上游凭据使用、多上游渠道的协议适配与流式透传、OpenAI / Anthropic 兼容协议下的模型目录归一化、跨工具模型目录管理、Ed25519 签名包与按平台矩阵的自动更新清单、Node 原生依赖跨平台打包** 等技术主题的实践项目，仅供个人学习与研究使用。

它不是官方产品，也不能脱离宿主单独运行——账号管理与登录态始终在宿主 AgentHub 一侧。本插件与下列公司及其产品**均无任何关联**，未获得其授权、认可或赞助：

腾讯及 WorkBuddy / CodeBuddy / Orcaterm，字节跳动及 Trae / TRAE SOLO / 豆包（Doubao），商汤科技及小浣熊（Raccoon），智谱及 ZCode / AutoClaw / AutoGLM，美团及 CatPaw，阿里巴巴及 Qoder / 千问办公（Qwen Work）/ ModelScope（魔搭）/ Accio，华为云及 CodeArts，科大讯飞及 Loomy / Astron Studio，网易有道及 LobsterAI，百度及 Kuku，MiniMax，AWS 及 Kiro，Google 及 Antigravity，Cline，GitCode 及 AtomCode，CommandCode，MonkeyCode，OfficeAce，DeepSeek 及 DeepSeek Harness，OpenAI 及 Codex，以及其他在文档、代码或界面中提及的服务提供方。

文中出现的所有产品名、商标、服务名、协议名均归其各自所有者，仅用于标识与说明用途。目录与请求中出现的模型名称（Claude / GPT / Gemini / GLM / Qwen / Kimi / DeepSeek / MiniMax / 豆包 等）亦归其各自所有者：本插件不包含、不重新分发、也不托管任何模型。

### 关于凭据与转发行为

「号池管家」在你自己的机器上复用**你自己账号**的登录态，用于余额查询、签到与账号管理——这部分能力在宿主 AgentHub 内，本插件不参与：它不解析登录 Cookie、不续期、不查余额、不签到、不切号，插件侧也没有账号管理入口。

本插件只做一件事：取宿主按**单次 grant** 投影下来的凭据（`pool.forward-scoped`），在 grant 作用域内把请求转发到对应上游，并把响应流式回传。它不监听任何端口、不对外提供 API；「本地网关」把上游以 **OpenAI / Anthropic 兼容协议**暴露在 `127.0.0.1`（默认不自启、默认只听回环、上游凭据不出本机进程）是宿主的行为。个别渠道为对齐官方客户端行为，会读取并透传少量请求头（`request.headers.read`）。

它不破解、不绕过任何付费或权限校验，使用的额度始终来自你自己账号本就拥有的配额。但需要明确的是，这种「以非官方客户端形态复用登录态」的转发方式，**可能不符合上游服务的用户协议或使用条款**；是否使用、由此产生的一切后果（包括但不限于账号被限流、被风控、被降权、被冻结或封禁，订阅被终止，积分/额度被清零），**均由使用者自行承担，作者不承担任何责任**。

作者未逐家核对各平台条款原文，上述表述为基于行为形态的推断，不构成法律意见。

### 禁止用途

禁止将本插件用于任何商业用途、二次分发牟利、以本插件为载体售卖账号或额度、打包售卖与付费镜像、把更新 feed 指向自建镜像站冒充官方源、以本插件换取赞助或广告与流量分成、批量账号运营、代刷代领、养号、绕过上游计费或配额限制、攻击或干扰任何服务的正常运行，以及其他违反当地法律法规或上游服务条款的活动。

如需在生产环境或商业场景中调用相关模型服务，请使用**官方渠道与官方 API**；商业使用须事先取得作者书面授权。

### 凭证与数据风险

本插件在本机留存私有配置与诊断日志：`settings.json` 只放本插件的执行设置（不含号池镜像与主加密密钥），`logs/plugin.log` 只记元数据、不记 prompt / 正文 / token / Cookie / URL。卸载只删除插件目录，`plugin-data/<id>` 会保留你的配置与缓存——转交他人或公开机器前请自行删除。

插件包必须通过宿主内置公钥的 Ed25519 签名校验才会安装，`sha256` 仅保证传输完整；请勿把更新源指向不可信地址。因凭据或配置泄露、设备被他人使用、误操作或不可信更新源造成的任何损失，**由使用者自行承担，作者不承担任何责任**。

### 无担保与权利通知

本插件按「现状」（AS IS）提供，作者不对其可用性、稳定性、安全性或对特定用途的适用性作任何承诺。上游接口与宿主插件协议随时可能变更，本插件可能随时失效而不再维护，作者无更新、修复或答疑的义务。

本插件中的接口形态、协议字段等信息来自对各官方客户端**公开网络通信的观察与整理**，仅用于学习与研究；相关商标与服务的权利归其各自所有者。若权利方认为本插件存在不当之处，请联系作者，将及时调整或删除。

**完整条款见 [LICENSE](./LICENSE)。** 若你不同意本节任何一条，请立即停止使用并删除本插件及其相关数据。
