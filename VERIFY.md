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
