# 变更日志

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
