# 验证记录 — dsh-zspace@0.1.0

日期：2026-10-05
运行时：DeepSeek Harness Desktop 0.2.0-rc.2（profile=desktop，Node 24.21.0）
NAS：极空间 Z4S（`Z****`，ZOS，存储池 `sata1`），**非局域网环境**，经桌面客户端本地代理 `127.0.0.1:13579` 云中转。

## 0. 协议勘察（写码前）

| 结论 | 证据 |
|---|---|
| 公共参数必须放 **body**，放进 query 会被拒 | 放 query → `N001212 参数有误`；放 body → 正常 |
| 上传小文件用 `/v2/file/create`，目标路径放 **percent-encode 的 `path` 头** | 中文名 `pct-测试.txt` 建文件成功 |
| Node 不能直接发原始 UTF-8 头值（`ERR_INVALID_CHAR`），percent-encode 是可行解 | 本地 echo server + 真机各验证一次 |
| 真实空间根：个人 `/sata1/my/data`、公共 `/sata1/public` | `/zspool/info` + 实际 list |
| NAS 网页层搜索接口**忽略关键字** | `keyword=简历` 与 `keyword=zzzznope-xyz`、`key`/`wd`/`search` 全部返回同一批 100 项 → 放弃该接口，`zspace_find` 改为受限目录遍历 |

## 1. 单元 / 集成测试（mock 代理）

```
node --test test/client.test.js test/tools.test.js test/adaptor.test.js
```

结果：**28/28 通过**（client 13、tools 12、adaptor 3）

覆盖：分页（50/页，120 项 3 次请求）、截断、路径前缀解析、中文名 create 上传、HTTP 413→分片回退与逐片 `seek` 重组、超阈值自动分片、下载/读取截断、增删改复制重命名、业务错误码→`ZSpaceError`+提示、5xx 重试、代理不可达 `EPROXY`、`confirm` 护栏、输出 schema 与规格自检（每个工具的 `outputSchema` 用同一套约束子集校验真实返回值）、适配层挂载 12 个工具 + 指南段 + 局部配置回退。

## 2. 真机端到端自检

```
node scripts/live-selftest.js
```

全部 19 步通过（`EXIT=0`），关键项：

| 步骤 | 结果 |
|---|---|
| 探活 / 存储池 | `sata1` 剩余 13.2 TB / 共 20.0 TB |
| 定位空间根 | home `/sata1/my/data`、public `/sata1/public` |
| 建临时目录 | `/sata1/my/data/dsh-zspace-selftest` |
| 上传（单请求，中文名） | `自检-中文名 空格.txt` → create |
| 上传（1KB 分片，强制 sliced） | `自检-分片.bin` 2.9 KB → 3 片 |
| 详情 / 读取 | 大小 60 B、`zspace_read` 截断正确 |
| 下载 + sha256 校验 | 小文件与分片文件均逐字节一致 |
| 服务端复制 → 重命名 → 遍历查找 → 移动 | 全通过（查找扫 4 项命中 1 项） |
| 删除临时目录 → 确认消失 | 通过（进回收站） |

## 3. 宿主侧加载与组合

```
dsh plugin --profile desktop add <项目>/dsh-zspace-0.1.0.tgz
dsh --profile zsverify --dump-config          # 组合树含 id: zspace / name: dsh-zspace + config
dsh --profile zsverify --dump-config-schema   # $defs/config112 = 本插件 Config，无 zspace 相关诊断
```

- `zsverify` 是 desktop profile 的临时副本（验证后已删除）。
- `--dump-config` 退出码 0、stderr 空——patch 行命中、包名可解析。
- `--dump-config-schema` 中 path `/204` 行 `status: schema`，引用 `config112`，该定义内所有键都带 `default`（说明宿主确实应用了默认值）。
- 安装后 `~/.dsh/profiles/desktop/package.json`：依赖从 10 项变为 11 项（原 10 项全部保留），`dsh.profile.bundles` 自动追加 `dsh-zspace`。

## 4. 在运行中的 DSH 里真调工具（最终形态）

插件安装后宿主已加载：本会话系统提示出现「极空间 NAS（dsh-zspace）」段，12 个 `zspace_*` 工具可直接调用。实测一遍完整链路：

| 调用 | 结果 |
|---|---|
| `zspace_status` | 在线，个人空间 17 项、公共空间 2 项、池剩余 13.2 TB |
| `zspace_mkdir home:dsh-zspace-toolcheck` | 创建成功 |
| `zspace_upload`（README.md → `自检-工具通道.md`） | 5.5 KB，单请求 |
| `zspace_ls home:dsh-zspace-toolcheck` | 1 项，5.5 KB，时间正确 |
| `zspace_read`（前 200 字节） | 内容正确、截断标记正确 |
| `zspace_remove confirm=true` | 删除成功 |

## 5. 已知边界（如实记录）

- 相对本地路径按 **DSH 宿主进程目录**解析（实测报错落在 `~/.dsh/profiles/desktop/`），已改为支持 `~/` 并在参数说明与报错里写清。
- 极空间无官方 API，接口随客户端版本可能变化；分片上传上限 2 MB/片、列表 50 条/页。
- `zspace_find` 是受限遍历（默认 depth 4 / scanLimit 2000），结果会报告扫描范围，不是 NAS 全盘索引。

## 6. 发布记录（2026-10-06）

### GitHub

| 项 | 值 |
|---|---|
| 仓库 | https://github.com/439436269-ctrl/dsh-zspace （public） |
| 分支/提交 | `main` @ `b518225`（首个提交 `d605c90`） |
| topics | `dsh-plugin` `deepseek-harness` `dsh` `cordis` `zspace` `nas` `webdav-alternative` |
| CI | `.github/workflows/ci.yml`：Node 22 / 24 跑 28 项 mock 测试（真机自检不进 CI） |
| 备注 | topic 不允许中文（`极空间` 提交会 422）；仓库本机 git 身份为 repo-local（全局没配 user.name/email） |

### npm

| 项 | 值 |
|---|---|
| 包 | https://www.npmjs.com/package/dsh-zspace |
| 版本 | `0.1.0`（`dist-tags.latest = 0.1.0`），发布者 `vfvrpq`，2026-10-05T21:48:12Z |
| shasum | `4d2e5e08b5d1a86582c6b447c45d9c4c7548e57f` |
| integrity | `sha512-M8mt27BcV465eQJEh8LU/9qkGpLrzFw0NR+/Sv9vxPW4IqeD1f9lw/Segx8b6xRqOGpg+R4EvQshbaxyJtC6ig==` |
| 文件数 / 解包 | 11 / 93988 B |
| 发布命令 | `pnpm publish`（用临时 npmrc 承载 Automation token，发完即删） |

校验结果：

1. registry 回读 `dist-tags.latest = 0.1.0`，`GET /dsh-zspace/-/dsh-zspace-0.1.0.tgz` 200，下载体积与本地 tgz 一致；
2. 下载产物的 sha1 与 `dist.shasum` 相符，且**与本地 `dsh-zspace-0.1.0.tgz` 逐字节相同**；
3. 解包后逐文件 sha256 与仓库工作树一致（`package.json` 仅键序/缩进差异，JSON 语义 diff 为空）；
4. 干净 profile 里 `dsh plugin --profile zsverify add dsh-zspace@0.1.0` 安装成功 → `dsh --profile zsverify --dump-config` 退出码 0、stderr 空，`id: zspace` 行配置完整（验证 profile 已删除）。

两个发布期的坑，记下来：

- **新包会自带一个 `0.0.0-stage` 占位版本**（version 对象里带 `stub` 字段，tarball 只有 README+package.json）。它是命名占位，不影响使用；`dist-tags.latest` 仍指向 `0.1.0`。若用 `curl` 读到旧缓存元数据会误以为发布失败。
- **24h 观察期**：显式 `dsh plugin add dsh-zspace@0.1.0` 时 pnpm 会自动把该版本写进 profile 的 `minimumReleaseAgeExclude`（`pnpm-workspace.yaml`），所以安装不会被挡；但 `update ...@latest` 这类隐式取新版本仍会等到发布满 24h。

### 本机安装形态

desktop profile 目前仍用仓库里的本地包（保留快速改代码的循环）：

```
"dsh-zspace": "file:~/Documents/lcj/codes/dsh-zspace/dsh-zspace-0.1.0.tgz"
```

要切成 npm 源（给别的机器/别人用同一条命令）：

```sh
dsh plugin --profile desktop add dsh-zspace@0.1.0
```

## 7. 内部重构（0.1.1，2026-10-06）

触发：`client.js` 857 行、`tools.js` 805 行过长，改为「一个文件一个能力」。**对外行为与 API 不变**。

| 项 | 重构前 | 重构后 |
|---|---|---|
| `lib/client.js` | 857 行单体 | 197 行 facade + `lib/client/` 8 个能力文件（最大 transport 335 行） |
| `lib/tools.js` | 805 行单体 | 66 行注册表 + `lib/tools/` 15 个文件（shared/paths/walk + 12 个工具，最大 walk 118 行） |
| `lib/index.js` | 206 行 | 87 行接线 + `config.js` 105 行 + `prompt.js` 26 行 |
| 打包 | — | 0.1.1 tgz 共 37 个文件，`lib/client/*` 8 个、`lib/tools/*` 15 个都在包内 |

验证方式：

1. 搬迁是**逐字**的（脚本按块抽取方法/对象，只做去一层缩进与 `this.` → `client.`），无逻辑改写；
2. 每个阶段跑 28 项 mock 测试全绿（client 拆分 → tools 拆分 → 入口拆分，各自一个提交）；
3. 重装 `0.1.1` 后真机自检全绿（19 步：中文名单请求上传、1 KB 分片上传、sha256 往返、复制/重命名/遍历查找/移动/删除/清理）；
4. 顺手把自检脚本打印的账号与 NAS 序列号做了脱敏（`***1997` / `***RRKU`），避免输出被贴出去时泄露身份。

拆分过程中踩到的坑（都已在生成脚本里修正，留档备查）：JSDoc 首行被当成函数签名替换掉、子模块自己 import 自己、`errors.js` 的切片越界把 transport 的辅助函数卷了进去、委托调用把默认值写进实参（`readFile(this, p, options = {})` 会用 `{}` 覆盖调用方的 options）、ctx 与 import 同名遮蔽（`humanSize`）。

## 8. 0.1.2：按编排 skill 跑一遍小需求（2026-10-06）

需求：新增 `zspace_write`（文本直写 NAS）+ `writeMaxBytes` 配置 + 路径示例泛化。**用 `dsh-plugin-ship` 的九阶段门跑完整流程**，作为编排 skill 的实证。

| 阶段 | 产出 | 验收证据 |
|---|---|---|
| P0 方案 | 一个新工具 + 一个新配置项 + 文档泛化（无破坏性变更） | 工具表由 12 → 13 |
| P2 实现 | `lib/tools/write.js`、`tools.js` 注册、`config.js` 三处同步、`cordis.patch.yml` | 临时目录 staging + 复用上传路径，成功与否都清理 |
| P3 验证 | mock 29 项（+write 的 4 类断言）、真机 21 步（+直写→读回内容比对） | 29/29 通过；真机 exit 0 且清理干净 |
| P4 安装 | 打包 0.1.2（`lib/tools` 17 个文件）→ remove/add | 装好版本 0.1.2，`write.js` 在包内 |
| P5 隐私门 | `privacy_scan.py . --history` | 零命中；新包内无身份串 |
| P6 建仓 | 提交 `7a27cca` → 推送 | 远端 main = 7a27cca；CI #3 success |
| P7 发布 | `dsh-zspace@0.1.2` | `dist-tags.latest = 0.1.2`；sha1 `7b6ae15d…` == `dist.shasum`；与本地 tgz 逐字节一致；逐文件 38 一致 |
| P8 回写 | 本节 + CHANGELOG + 两个 skill 修订 | — |

本轮由编排暴露并修正的两个认知错误：

1. **`pnpm publish` 是分段发布**：0.1.2 发完 10 分钟内 `dist-tags` 仍是 0.1.1、版本端点 404、重发报 `409 Cannot publish over previously staged version`。这不是失败，是暂存窗口（实测约 6～12 分钟自动 promote）。已把这个真相写回 `dsh-plugin-publish-npm` skill（此前解释为"新包占位/缓存"，不准确）。
2. **校验脚本要吃 CDN 传播延迟**：`dist.shasum` 已经指向本地包、但 tarball URL 仍 404 数次。已给 `verify_npm_artifact.py` 加退避重试（404/429/5xx，15s 起阶梯），避免把"传播慢"误判成"产物不对"。

## 9. 0.3.0：双通道（同网络直连 WebDAV / 跨网络走云中转）

| 阶段 | 产出 | 验收证据 |
|---|---|---|
| P0 方案 | 新增 WebDAV 传输 + 自动选路，工具名/参数不变 | 确认门：地址 `http://<nas-ip>:5005/`、密码走 `ZS_WEBDAV_PASSWORD`、策略 auto |
| P2 实现 | `lib/client/webdav.js`、`lib/client/relay.js`、`lib/client/router.js`、facade 改分发、config +7 键、patch、status 增字段 | 中转路径零改动（旧 29 项测试继续绿） |
| P3 验证 | mock WebDAV 服务器（真 socket）+ 中转 stub，7 项新测试 | **36/36 通过**：PROPFIND 解析、路径双向映射、全能力往返、鉴权失败/不可达探测、auto 选路、**运行期失败回退**、强制模式不回退 |
| P4 安装 | 打包 0.3.0 → remove/add | profile 已装 0.3.0，`lib/client/webdav.js` 在包内 |
| P5 隐私门 | `privacy_scan.py . --history` | 零命中；真实 NAS 地址已泛化为 `<nas-ip>` |
| P6 建仓 | 远端 main `8f24fcf`（CI #5 success） | `github.com:443` 与隧道 IP 全部超时 → 走 **api.github.com Git Data API 推送**，断言服务端 tree `bfefe9c` == 本地 `HEAD^{tree}` |
| P7 发布 | `dsh-zspace@0.3.0` | `dist-tags.latest = 0.3.0`；sha1 `a43d5114…` == `dist.shasum`；与本地 tgz 逐字节一致；逐文件 41 一致 |
| P8 回写 | 本节 + CHANGELOG + skill 补 4b 节 | — |

### 选路实测（真机，本机网络当天从 192.168.31.163 变到 192.168.1.12）

| 配置 | 结果 |
|---|---|
| 无 `ZS_WEBDAV_PASSWORD` | 通道 = relay；探测 = 缺少凭据 ✓（不报错、不影响使用） |
| 密码错误 | 通道 = relay；探测 = 超时/不可达；中转探活仍 true ✓ |
| 密码错误 + `transportMode: webdav` | 通道 = webdav（强制），失败按要求暴露 ✓ |

**未完成项（需要在真正的同网环境由使用者本人验证）**：本次跑测期间 NAS 的 TCP 端口（5005/5006/5055）从当前网络不可达（ICMP 通、桌面客户端云中转正常），因此**没有跑通一次真实 WebDAV 往返**；直连往返由 mock WebDAV 的 7 项测试覆盖。验证命令：

```sh
export ZS_WEBDAV_URL=http://<nas-ip>:5005/ ZS_WEBDAV_USER=<NAS账号> ZS_WEBDAV_PASSWORD=<密码>
node -e 'import("./lib/client.js").then(async m=>{const c=new m.ZSpaceClient({webdavUrl:process.env.ZS_WEBDAV_URL,webdavUser:process.env.ZS_WEBDAV_USER,homePath:"/sata1/my/data",publicPath:"/sata1/public"});console.log(await c.transportReport())})'
ZS_WEBDAV_URL=... ZS_WEBDAV_USER=... ZS_WEBDAV_PASSWORD=... node scripts/live-selftest.js   # 会多跑「通道诊断」与「WebDAV 直连写→读」
```

### 本轮另外两条结论

1. **git 推送的备胎通道**：`github.com:443` 与全部隧道 IP 都失效时，用 `api.github.com` 的 Git Data API 推送（新建 blob→tree→commit→更新 ref）。**服务端 commit SHA 与本地不同**（账号身份/时间/消息差异），但脚本会断言 **tree sha 与本地 `HEAD^{tree}` 一致**，内容等价、CI 照常绿。已沉淀为 `dsh-plugin-publish-repo/scripts/gh_api_push.py` 与 skill 第 4b 节。
2. **npm 分段发布**：0.3.0 这次发布到 promote 约 10 分钟；期间 `latest` 仍是 0.1.2，属正常窗口。
