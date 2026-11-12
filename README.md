# AgentHub 增强执行插件

AgentHub 本体保留号池管家、本地网关和七项账号管理（登录、凭据解析、续期、余额、签到、领取、客户端切号）。渠道的模型执行搬到这个独立进程里，通过 stdin/stdout JSON-RPC 与宿主通信。

插件继承根目录的 `LICENSE` 及附加条款，再分发必须带上它。

## 边界

- 本体没有安装或没有绑定插件时，只能执行标准自定义供应商。不会退回旧 adapter，也不会读旧管理目录冒充执行来源。
- 插件不解析登录 Cookie、不续期、不查余额、不签到、不切号。这些动作仍由本体完成，插件只拿单次 grant 投影出来的凭据。
- 凭据、上下文、目录都按 grant 作用域读取。`pool.listAccounts` 这类管理入口在插件侧不存在。

## 渠道

`manifest.json` 声明 20 个 provider ID，对应 15 个渠道家族。双区/双池的渠道拆成独立 ID：

| 家族 | provider ID | 渠道 | 目录 |
|---|---|---|---|
| Trae | `trae` | trae | 账号 |
| Raccoon | `raccoon` | raccoon | 账号 |
| Accio | `accio` / `accio_cn` | accio / accio_cn | 账号 |
| CodeArts | `codearts` | codearts | 账号 |
| ModelScope | `modelscope` | modelscope | 账号 |
| Lobster | `lobster` | lobster | 账号 |
| CatPaw | `catpaw` | catpaw | 账号 |
| MonkeyCode | `monkeycode` / `monkeycode_intl` | 同名 | 账号 |
| Kuku | `kuku` | kuku | 账号 |
| Loomy | `loomy` | loomy | 公开 |
| Cline | `cline_free` / `cline_pass` | cline_free / cline_pass | 账号 |
| AutoClaw | `autoclaw` / `autoclaw_intl` | 同名 | 账号 |
| WorkBuddy | `workbuddy` | workbuddy / workbuddy_ai | 账号 |
| Qoder | `qoder` / `qoder_intl` | 同名 | 账号 |
| ZCode | `zcode` | zcode | 固定 |

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

ZCode 的目录由客户端决定，声明 `modelRefresh: false`。手动刷新时宿主直接跳过并提示「固定模型目录，无需远程刷新」，不会发强制目录请求，也不会碰余额、签到、续期或切号。

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

`npm test` 顺序跑 20 个脚本：

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
