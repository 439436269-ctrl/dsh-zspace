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

## 工具

| 工具 | 作用 |
|---|---|
| `zspace_status` | 探活：代理、账号、NAS、存储池余量、个人/公共空间根路径与条目数。其它工具报错时先跑它 |
| `zspace_ls` | 列目录，支持 `depth` 递归与 `limit` 预算；自动分页（NAS 单页 50 条） |
| `zspace_stat` | 单个文件/目录的元信息（大小、修改/创建时间） |
| `zspace_find` | 按名称在目录树里查找（大小写不敏感子串），会报告扫描了多少条目、是否提前停止 |
| `zspace_read` | 把小文本文件读进上下文（默认上限 256 KB，二进制自动识别） |
| `zspace_download` | 从 NAS 下载到本机（默认落到 `~/Downloads/zspace`） |
| `zspace_upload` | 上传本地文件，**大文件自动走分片协议**，中文文件名可用 |
| `zspace_mkdir` | 建目录 |
| `zspace_rename` | 就地重命名 |
| `zspace_move` | 移动到另一个目录（服务端操作，不下载） |
| `zspace_copy` | 服务端复制 |
| `zspace_remove` | 删除（NAS 侧进回收站）；**必须显式传 `confirm: true`** |

### 路径写法

| 写法 | 含义 |
|---|---|
| 省略 / `""` | 个人空间根（本机实测 `/sata1/my/data`） |
| `home:相册` | 个人空间下的 `相册` |
| `public:公共分组/skills` | 公共空间下的路径（本机 `/sata1/public/...`） |
| `docs/2026` | 相对个人空间根 |
| `/sata1/my/data/x.txt` | NAS 绝对路径，原样使用 |

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
| `readMaxBytes` | `262144` | `zspace_read` 上限 |
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
