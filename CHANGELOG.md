# 变更日志

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
