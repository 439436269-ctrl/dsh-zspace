# dsh-zspace

[![npm](https://img.shields.io/npm/v/dsh-zspace.svg)](https://www.npmjs.com/package/dsh-zspace)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![dsh-plugin](https://img.shields.io/badge/awesome-dsh--plugin-listed-8a2be2.svg)](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)

极空间（ZSpace）NAS 的 **DeepSeek Harness 插件**：把 NAS 变成 agent 的原生工具 —— **跨网络可用**，不需要同一局域网、不需要 WebDAV、不需要 SSH、不需要 Python。

```
DSH 插件  →  http://127.0.0.1:13579  →  极空间桌面客户端（已登录）  →  极空间云中转 / P2P  →  NAS
```

认证直接复用桌面客户端自己的登录态（`vuex.json`），所以**换任何网络都能用**：只要跑 DSH 的这台机器上极空间桌面客户端在线即可。这正好补上 `dsh-webdav` 那类"必须同网段"方案的短板。

## 安装

```sh
# 从 npm 安装（推荐）
dsh plugin --profile desktop add dsh-zspace@latest

# 或用仓库里的本地包
dsh plugin --profile desktop add /绝对路径/dsh-zspace-0.1.0.tgz
```

装完**重启 DSH**（或在插件市场点「一键重启」）即可在会话里看到 `zspace_*` 工具。

前置条件：

1. 极空间桌面客户端已安装、**已登录并正在运行**（跨网络访问靠它做云中转）；
2. 该账号对目标空间有权限（个人空间 / 公共空间）；
3. 不需要给 NAS 开任何端口，也不需要 DDNS。

## 双通道：同网络直连 WebDAV，跨网络走云中转

插件对同一套工具**自动选路**，判断依据是**可达性**而不是 IP 网段（本机在 `192.168.31.x` 也能直连 `<nas-ip>` 的 NAS）：

| 情况 | 通道 | 条件 |
|---|---|---|
| 能直连 NAS（同网络） | **WebDAV 直连** | 配了 `webdavUrl` + 环境变量 `ZS_WEBDAV_PASSWORD`；1.5s PROPFIND 探测通过即启用 |
| 跨网络 / WebDAV 不可达 | 桌面客户端云中转（默认） | 桌面客户端已登录并在运行 |

- WebDAV 通道的好处：延迟更低、不依赖桌面客户端在线、目录列表一次 `PROPFIND` 拿全（没有中转的 50 行分页）。
- 运行中 WebDAV 掉了（换网、NAS 重启）会**自动回退到中转并在同一次调用内重试**，只损失一点延迟，不会让工具调用失败；30s 后重新探测。
- `transportMode`：`auto`（默认）/ `webdav`（强制，失败直接报错）/ `relay`（保持旧行为）。
- 路径映射：NAS 的 `/sata1/my/data/...` ↔ WebDAV 的 `<webdavHomePath>/...`（默认根 `/`）；公共空间由 `webdavPublicPath` 指定（默认空＝不在 WebDAV 暴露，相关路径自动回到中转）。
- 极空间要在「系统设置 → 文件服务」里开启 WebDAV（默认端口 `5005`，本机实测可用；`5006` 是自签 HTTPS，证书校验会失败）。
- **零 patch 配置**：三个环境变量就能启用直连，不需要改任何 patch 文件（避开"同 id 插两次导致挂载两次"的坑）：
  `ZS_WEBDAV_URL`（如 `http://<nas-ip>:5005/`）、`ZS_WEBDAV_USER`（NAS 账号）、`ZS_WEBDAV_PASSWORD`。
  插件跑在 DSH Desktop 进程里，所以要让**桌面端**能看到这些变量（macOS）：
  ```sh
  launchctl setenv ZS_WEBDAV_URL 'http://<nas-ip>:5005/'
  launchctl setenv ZS_WEBDAV_USER '<NAS账号>'
  launchctl setenv ZS_WEBDAV_PASSWORD '<密码>'
  # 然后 Cmd+Q 完全退出 DSH Desktop 再重新打开（launchctl setenv 只影响之后启动的进程）
  ```
  想改回只走中转：`launchctl unsetenv ZS_WEBDAV_URL`（或设 `transportMode: relay`）。
- 密码不写进 patch 文件——patch 是明文，会被备份/截图带走。
- `zspace_remove` 在 WebDAV 通道下是 NAS 侧的删除语义（是否进回收站由 NAS 决定）；要确保进回收站请用 `transportMode: relay`。

## 工具

| 工具 | 作用 |
|---|---|
| `zspace_status` | 探活：**当前通道**（WebDAV 直连 / 云中转）、代理、账号、NAS、存储池余量、个人/公共空间根路径与条目数。其它工具报错时先跑它 |
| `zspace_ls` | 列目录，支持 `depth` 递归与 `limit` 预算；自动分页（NAS 单页 50 条） |
| `zspace_stat` | 单个文件/目录的元信息（大小、修改/创建时间） |
| `zspace_find` | 按名称在目录树里查找（大小写不敏感子串），会报告扫描了多少条目、是否提前停止 |
| `zspace_read` | 把小文本文件读进上下文（默认上限 256 KB，二进制自动识别） |
| `zspace_download` | 从 NAS 下载到本机（默认落到 `~/Downloads/zspace`） |
| `zspace_upload` | 上传本地文件，**大文件自动走分片协议**，中文文件名可用 |
| `zspace_write` | 把文本**直接写到 NAS**（省掉本地临时文件），默认覆盖、可传 `overwrite: false` 拒绝覆盖 |
| `zspace_mkdir` | 建目录 |
| `zspace_rename` | 就地重命名 |
| `zspace_move` | 移动到另一个目录（服务端操作，不下载） |
| `zspace_copy` | 服务端复制 |
| `zspace_remove` | 删除（NAS 侧进回收站）；**必须显式传 `confirm: true`** |

### 路径写法

| 写法 | 含义 |
|---|---|
| 省略 / `""` | 个人空间根（形如 `/<pool>/my/data`，实际值由插件探测） |
| `home:相册` | 个人空间下的 `相册` |
| `public:公共分组/skills` | 公共空间下的路径（形如 `/<pool>/public/...`） |
| `docs/2026` | 相对个人空间根 |
| `/<pool>/my/data/x.txt` | NAS 绝对路径，原样使用 |

两个根路径由插件按存储池自动探测（`/<pool>/my/data`、`/<pool>/public`），也可在配置里写死。

### 本地路径

`zspace_upload` 的 `localPath`、`zspace_download` 的 `dir` 建议传**绝对路径**或 `~/…`：插件跑在 DSH 宿主进程里，普通相对路径是按**宿主进程的工作目录**解析的（不是会话工作区）。找不到文件时的报错会把解析后的绝对路径打出来。

## 配置

写在 profile 的补丁层（`~/.dsh/profiles/<profile>/cordis.patch.yml`）里 `id: zspace` 那一条的 `config` 下，改完热加载：

| 配置项 | 默认 | 说明 |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:13579` | 桌面客户端本地代理（可用 `ZS_BASE_URL` 覆盖） |
| `configDir` | 自动探测 | `vuex.json` 所在目录（可用 `ZS_CONFIG_DIR` 覆盖） |
| `apiVersion` | `2.3.2026042401` | NAS Web API 版本号参数 |
| `homePath` / `publicPath` | 空＝自动探测 | 写死个人/公共空间根 |
| `downloadDir` | 空＝`~/Downloads/zspace` | 默认下载目录 |
| `transportMode` | `auto` | 通道：`auto` / `webdav` / `relay` |
| `webdavUrl` | 空＝关闭 | WebDAV 地址，如 `http://<nas-ip>:5005/` |
| `webdavUser` | 空 | WebDAV 账号（NAS 账号）；密码走 `ZS_WEBDAV_PASSWORD` |
| `webdavPassword` | 空 | 密码兜底项，建议留空改用环境变量 |
| `webdavHomePath` / `webdavPublicPath` | `/` / 空 | 个人/公共空间在 WebDAV 里的路径（空＝公共空间不暴露） |
| `webdavProbeTimeoutMs` | `1500` | 直连探测超时 |
| `readMaxBytes` | `262144` | `zspace_read` 上限 |
| `writeMaxBytes` | `5242880` | `zspace_write` 单次写入上限（更大的内容用 `zspace_upload`） |
| `listMaxEntries` | `2000` | 单次列目录/树的上限 |
| `timeoutMs` / `maxRetries` | `60000` / `2` | 请求超时与瞬时失败重试 |
| `smallUploadMaxBytes` | `8388608` | 超过就用分片上传 |
| `sliceSize` | `2097152` | 分片大小（远端模式上限 2 MB） |
| `promptEnabled` / `promptOrder` | `true` / `60` | 是否向系统提示注入使用说明 |

## 安全与边界

- **只读别人的东西是不可能的**：插件不存任何凭据，每次调用从桌面客户端的 `vuex.json` 现读 token（按 mtime 缓存），客户端退出登录即失效。
- **删除是两段式的**：`zspace_remove` 必须 `confirm: true`，且 NAS 侧进回收站，不是硬删。
- **不做端口暴露**：所有流量经本机代理走极空间云通道，NAS 不需要公网入口。
- 已知限制：
  - 极空间**没有官方公开 API**，本插件走的是社区整理的桌面客户端接口，客户端大版本更新可能改动；
  - NAS 网页层的 `/file_search/file_search` 在当前固件上**忽略关键字**（换任何关键词都返回同一批 100 项），所以 `zspace_find` 用的是**受限目录遍历**而不是该接口，结果会明确报告扫描范围；
  - 单次 list 最多 50 条（插件已自动分页）；远端模式分片上限 2 MB/片。

## 代码结构

按「**一个文件 = 一个能独立解释的能力**」组织，完整职责表与扩展步骤见 [lib/README.md](lib/README.md)：

```
lib/index.js      插件接线（name/inject 转发 Config + apply）    lib/client/  协议按能力拆分
lib/config.js     配置 schema、默认值、边界校验                  transport  URL/编码/重试/校验
lib/prompt.js     系统提示里的用法说明                            spaces     探活、存储池、空间根
lib/tools.js      工具注册表（只做注册）                          browse/mutate  列表 / 增删改
lib/tools/*.js    12 个工具，各一个文件                            upload/download  分片上传 / 流式下载
```

依赖是严格单向无环：`index → tools → client → {errors,transport} → format/auth`。加一个工具 = 新建 `lib/tools/<名字>.js` + 在 `lib/tools.js` 注册一行。

## 测试

```sh
node --test test/client.test.js test/tools.test.js test/adaptor.test.js   # 28 项单测/集成（mock 代理）
node scripts/live-selftest.js                                            # 真机端到端自检（会创建并清理临时目录）
```

`live-selftest.js` 覆盖：探活 → 存储池 → 定位个人/公共空间 → 建目录 → 中文名单请求上传 → 强制多分片上传 → 详情 → 读取 → 下载并校验 sha256 → 服务端复制 → 重命名 → 遍历查找 → 移动 → 删除 → 确认消失。

## 与已有极空间 skill 的关系

本机的 `zspace-nas` / `zspace-public-access` 等 skill 依赖 `zspace-cli`（Python）或独立 Node 脚本；本插件把同一套协议**内置进 DSH**，不依赖 Python、不依赖额外命令，并且带输出 schema、错误提示与安全护栏。两者可以共存。

## 许可

MIT
