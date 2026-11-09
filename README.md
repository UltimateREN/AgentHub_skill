# AgentHub 反代执行插件

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

发布产物有两个文件，都放在同一个 GitHub Release 里：

- `<id>-<version>-<platform>.zip`：签名后的插件包
- `plugin-index.json`：主程序用来判断版本、平台和下载地址的清单

`npm run build` 之后跑 `tools/build-package.cjs`，需要环境变量 `AGENTHUB_PLUGIN_SIGNING_KEY` 指向 Ed25519 私钥。私钥只放发布机（`.release/` 已被忽略），不入库。

推 `v*` tag 会触发 `.github/workflows/release-plugin.yml`：跑测试、签名、把 zip 和 `plugin-index.json` 传到同一个 Release。需要在仓库 Secrets 里配 `AGENTHUB_PLUGIN_SIGNING_KEY`，内容是私钥 PEM 全文。

清单长这样：

```json
{
  "schema": 1,
  "plugins": [{
    "id": "com.agenthub.forwarding-suite",
    "version": "1.0.0",
    "minimumVersion": "",
    "minHostVersion": "",
    "platforms": [{ "os": "win32", "arch": "x64" }],
    "url": "https://github.com/UltimateREN/AgentHub_skill/releases/download/v1.0.0/....zip",
    "sha256": "..."
  }]
}
```

`minimumVersion` 留空表示不强制升级。填了之后，低于它的安装会被主程序强制补齐，不受「自动更新插件」开关影响 —— 这是最低版本兜底。

主程序内置官方公钥（keyId `agenthub-release-2026`），包内 manifest 的签名必须对得上才会装。`sha256` 只保证传输完整，信任判断在签名那一步。

主程序的设置页有两个开关：

- **自动更新插件**：已启用的官方插件有新版本时自动下载、校验、安装
- **自动下载官方插件**：发现未安装的官方插件时自动装；开着的时候手动卸载也会被装回来

两个开关都关掉后，日常更新暂停，但已安装插件低于 `minimumVersion` 时仍会补齐。

下载走主程序自己的代理回退（先直连，失败再试本机常见代理端口），不需要插件额外配置。

卸载只删插件目录，`plugin-data/<id>` 保留。装回来之后插件自己的配置和缓存还在。

## 提交与推送

这个仓库属于 `UltimateREN`，提交和推送都用这个身份：

```bash
git config user.name "UltimateREN"
git config user.email "354340680+UltimateREN@users.noreply.github.com"
node tools/push.cjs
```

`tools/push.cjs` 只从 gh 里取 UltimateREN 的 token，推完即弃，不写全局配置。

主程序 `AgentHub` 用的是另一个账号（HUIdada1），两边的凭据和提交记录互不影响。不要把主程序的 GCM 凭据套到这里，也不要用 HUIdada1 提交这个仓库。

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

## 还没做的

- 真实账号和真实上游的全渠道验收，目前只有合成回环。
- 五分钟以上的长流、跨平台原生依赖（CatPaw 的 sharp）在目标平台的实测。
- 生产签名、安装包纯净度和正式发布工具链。
- 插件进程重启后的有状态任务恢复。
