# 变更日志

## 0.4.0 — 2026-10-18

新增 **6 个 Docker / 整机工具**，把「极空间 Docker 运维」并进本插件（原先散落在独立的 `dsh-zspace-docker` 插件里）。**仅服务端工具，无客户端 UI**：不新增面板、不新增设置项，也不改任何既有工具的名字、参数或返回结构；`lib/config.js` 未动（这 6 个工具无配置）。

**为什么加**：这台 NAS 的 containerd 会周期性 wedge（2026-10-16/17/18 三次实测）。那时容器状态仍显示 `running`、文件 API 一切正常，只有容器操作静默失效——而文件类工具**无法诊断也救不回来**。要判断"引擎是不是真的坏了"、并在坏掉时恢复，agent 需要在同一个插件里拿到这几个工具。

新增工具：

| 工具 | 能力 |
|---|---|
| `zspace_docker_list` | 容器列表（name/state/status/id）+ running/count |
| `zspace_docker_inspect` | 单个容器完整配置（镜像/命令/env/挂载/端口/网络/重启策略） |
| `zspace_docker_logs` | 尾部日志（已剥掉多路复用帧头，可直接读） |
| `zspace_docker_op` | start / stop / restart / remove / pause；`remove` 必须 `confirm=true` |
| `zspace_docker_health` | 引擎真健康判据，verdict ∈ `healthy` / `containerd-wedged` / `container-not-running` / `service-off` / `error` |
| `zspace_system_reboot` | 整机重启（`POST /system/reboot`），必须 `confirm=true` |

写进代码注释的四条实测协议事实：

1. **方法不对称**：`/zdocker/container_op` 是 **GET**；`/zdocker/system_restart` 与 `/system/reboot` 是 **POST**。传错方法一律 `404 page not found`（纯文本，不是 JSON）。插件在客户端层固定了方法，模型无需也无法选。
2. **HTTP 200 ≠ 成功**：业务失败时 HTTP 仍是 200，`code` 字段就是错误文本（`Error response from daemon: …`）。所以 `lib/client/docker.js` 自己解包并检查 `code`，不复用文件 API 的 `parse()`（那边的 `code` 是 `N00…` 业务码）。
3. **`/system/reboot` 不在 `/zdocker` 命名空间下**，是整机重启；`system_restart` 只重启 dockerd，containerd wedge 时救不了。
4. **`container_top` 当健康检查有陷阱**：容器没运行时它直接返回 `is not running`、**根本不碰 containerd**，所以"有返回"不能证明引擎健康。只有返回真实 `Processes` 数组才算 `healthy`；报 `dial unix:///run/containerd/containerd.sock: timeout` 才是 wedge。

实现与验证：

- `lib/client/docker.js`：只复用既有 `lib/client/transport.js`（URL 形状 + `client.send`）与 `lib/client/session.js`（`authHeaders`），不重复实现鉴权/超时/重试；整机重启走"零重试"视图，避免超时重发变成连下两次重启命令。
- `lib/tools/docker-{list,inspect,logs,op,health}.js` + `lib/tools/system-reboot.js`：一个文件一个能力，形状与 `lib/tools/stat.js` 一致（普通对象参数、封闭 `outputSchema`、`render`/`execute`）。
- `lib/prompt.js`：新增一小节，讲清"先 health 判引擎、wedge 只能整机重启、container_op 是 GET、remove 要 confirm"。
- 测试：**36 项**（新增 7 项 Docker 用例），覆盖 spec 形状、GET/POST 方法约束、`code` 非 200 的失败路径、404 方法提示、`remove`/`reboot` 缺 `confirm` 拒绝、health 五种 verdict 分支、日志帧头清洗。
- 新增 `scripts/docker-selftest.js`（`npm run selftest:docker`）：**只读**真机冒烟（列表 / 详情 / 日志非空 / 健康判据），实测 8 个容器、`verdict=healthy`、日志 92 行。

## 0.3.3 — 2026-10-11

修 `zspace_write` 的**覆盖语义**（自 0.1.2 起工具描述承诺"默认覆盖"，实际在全网盘根级会失败——NAS 的 `/v2/file/create` 只做新建，同名返回"存在同名文件(夹)，创建失败"）：

- **中转通道**：覆盖前先 `remove`（旧版进 NAS 回收站）再写；
- **WebDAV 直连通道**：PUT 本身就是覆盖语义，**不做**删除（避免把"覆盖"变成永久删除）；
- 目标不存在时不触发任何删除；`overwrite: false` 行为不变（存在即拒绝）；
- 工具 description 同步写清两条通道不同的覆盖语义（按 `dsh-plugin` 的教训：给模型的文案也是对外契约）。
- 验证：37 项单测（新增覆盖三分支：中转先删、WebDAV 不删、新文件不删）+ 真机自检新增「覆盖已有文件」步骤（两版写同一路径，读回第二版）。

## 0.3.2 — 2026-10-11

修正**注入给模型的指南**滞后于工具演进的问题（只影响文档文案，行为不变）：

- `lib/prompt.js`：补 `zspace_write`；说明两条通道与自动选路（并指向 `zspace_status` 的 `transport` / `webdavProbe`）；修正"删除必进回收站"的说法——云中转通道进回收站，**WebDAV 直连通道由 NAS 侧决定**，要确保可找回就先确认通道或临时 `transportMode: relay`。
- `lib/tools/remove.js`：工具描述与渲染同步标注该通道差异。
- 起因：收尾复核时发现系统提示里的工具清单还停在 0.1.x（缺 `zspace_write`、把回收站语义写死），会误导每个新会话。

## 0.3.1 — 2026-10-07

- WebDAV 地址也支持环境变量 `ZS_WEBDAV_URL`：**三个环境变量即可启用直连，零 patch 改动**（避开 profile 层同 id 插两次导致挂载两次的坑）；`zspace_status` 报告统一走同一取值。
- 测试 36 → 37（新增"仅靠环境变量也能启用直连"用例）。
- README 补 macOS 上给 GUI 进程注入环境变量的做法（`launchctl setenv` + 完全重启桌面端）。

## 0.3.0 — 2026-10-07

**双通道**：同一网络时直连 NAS 的 WebDAV，跨网络继续走桌面客户端云中转，插件自动选路。工具名与参数**完全不变**（仍是 13 个），既有配置继续可用。

- 新增 `lib/client/webdav.js`：WebDAV 传输层（PROPFIND 列目录/取元信息、MKCOL、PUT、GET（含 Range）、MOVE、COPY、DELETE、Basic 鉴权、namespace 无关的 multistatus 解析、NAS 路径 ↔ DAV 路径双向映射）。
- 新增 `lib/client/router.js`：选路与回退。`auto`（默认）按**可达性**探测（1.5s PROPFIND，结果缓存 60s）；**运行中** WebDAV 失败（超时/拒绝连接/5xx）会标记下线 30s 并在**同一次调用内**改用中转重试，业务错误（401/403/404/405/409、`N00…`）不触发回退。
- 新增配置：`transportMode`(auto/webdav/relay)、`webdavUrl`、`webdavUser`、`webdavPassword`、`webdavHomePath`、`webdavPublicPath`、`webdavProbeTimeoutMs`。**密码建议只放环境变量 `ZS_WEBDAV_PASSWORD`（可选 `ZS_WEBDAV_USER`），不要写进 patch**。
- `zspace_status` 增加 `transport` / `webdavUrl` / `webdavProbe` 字段，并说明当前在用哪条通道、不可用时两边的原因。
- WebDAV 通道的收益：直连低延迟、不依赖桌面客户端在线、目录列表一次 `PROPFIND` 拿全（没有中转 50 行分页）。注意 `zspace_remove` 在直连通道下是 NAS 侧删除语义（是否进回收站由 NAS 决定）。
- 验证：**36 项测试**（新增 `test/webdav.test.js` 7 项，含真 socket 的 mock WebDAV 服务器、鉴权失败/不可达探测、auto 选路、运行期回退、强制模式不回退）；真机自检新增通道诊断步骤（配了密码时还会跑一遍 WebDAV 直连写→读往返）。

## 0.1.2 — 2026-10-06

新增一个写入类工具 + 一个配置项，并把文档里的真实池名换成占位符（**无破坏性变更**，工具表新增一行）：

- 新增 `zspace_write`：把文本直接写到 NAS，省掉"先生成本地临时文件再上传"这一步。默认覆盖同名文件，`overwrite: false` 时先探测存在性并拒绝；体积受 `writeMaxBytes` 约束；底层复用同一条上传路径（自动决定单请求/分片），临时文件无论成败都会清理。
- 新增配置项 `writeMaxBytes`（默认 5 MB），四处同步：Config schema、DEFAULTS、加载期校验、`cordis.patch.yml`。
- 文档与工具描述里的示例路径由真实的 `/<具体池>/...` 泛化为 `/<pool>/...`（探测候选路径代码保留，那是发现算法的一部分）。
- 清掉 0.1.1 拆分脚本引入的 19 处重复 JSDoc。
- 验证：29 项 mock 测试（新增 zspace_write 的 4 类断言）+ 真机 21 步自检（新增"直写文本→读回内容比对"）。

## 0.1.1 — 2026-10-06

纯内部重构，**对外行为与 API 不变**（`ZSpaceClient` / `ZSpaceError` / `createToolSpecs` / 12 个工具名与参数完全保持）：

- `lib/client.js` 857 → 197 行，按能力拆到 `lib/client/`：`errors` / `transport` / `session` / `spaces` / `browse` / `mutate` / `upload` / `download`；
- `lib/tools.js` 805 → 66 行：12 个工具各自成文件（`lib/tools/<工具名>.js`），公共能力抽成 `shared` / `paths` / `walk`；
- `lib/index.js` 206 → 87 行，配置抽到 `lib/config.js`、系统提示文案抽到 `lib/prompt.js`；
- 新增 `lib/README.md`：目录职责表 + 依赖方向 + 「加一个工具/加一个客户端能力」的步骤；
- 测试仍为 28 项 mock 用例，拆分前后全绿；真机自检脚本未改。

## 0.1.0 — 2026-10-05

首个版本：

- 跨网络通道：桌面客户端本地代理 `127.0.0.1:13579` → 极空间云中转 → NAS，无需同一局域网 / WebDAV / SSH / Python；
- 12 个工具：`zspace_status` `ls` `stat` `find` `read` `download` `upload` `mkdir` `rename` `move` `copy` `remove`；
- 路径约定：`home:` / `public:` / 相对个人空间 / NAS 绝对路径，空间根按存储池自动探测；
- 上传：≤8 MB 走 `/v2/file/create`，更大或遇 HTTP 413 自动回退桌面客户端分片协议（2 MB/片），中文文件名可用；
- 安全：凭据实时读桌面端 `vuex.json`（不落库）；`zspace_remove` 强制 `confirm: true` 且 NAS 侧进回收站；错误码映射为可执行提示。
