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
