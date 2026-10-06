# lib/ 结构与约定

一句话：**一个文件 = 一个能独立解释的能力**。入口只做接线，协议只管传输，工具一个文件一个。

```
lib/
├── index.js        87 行   插件入口：name / inject / Config 转发 / apply（生命周期 + 注册）
├── config.js      105 行   配置：schemastery 的 Config、代码侧 DEFAULTS、边界校验
├── prompt.js       26 行   系统提示里的用法说明（promptEnabled 开关）
├── auth.js        174 行   从桌面客户端 vuex.json 取登录态（按 mtime 缓存）
├── format.js       91 行   时间/大小/路径小工具（无 host 依赖，纯 Node）
├── client.js      197 行   客户端 facade：持有会话状态，方法薄委托到 client/*
├── client/
│   ├── errors.js     56 行  NAS 业务码 + ZSpaceError（含 hint 提示）
│   ├── transport.js 335 行  URL 形状、表单编码、重试、响应校验、流读取
│   ├── session.js    79 行  Cookie、公共参数、安全身份
│   ├── spaces.js    153 行  代理探活、存储池、个人/公共空间根探测
│   ├── browse.js     64 行  分页列目录、单条元信息
│   ├── mutate.js    102 行  mkdir / rename / move / copy / remove
│   ├── upload.js    129 行  单请求上传 + 分片协议
│   └── download.js  128 行  流式下载、限量读入内存
├── tools.js        66 行   工具注册表：建 ctx、按顺序调用 12 个工厂
└── tools/
    ├── shared.js     52 行  clampInt / entryLine / guarded
    ├── paths.js      84 行  home:/public:/相对/绝对 解析 + 本地路径（含 ~/）
    ├── walk.js      118 行  walkDirectory（ls 递归）、findByName（受限查找）
    └── <工具名>.js  35-116 行  每个工具一个文件：status ls stat find read
                                download upload mkdir rename move copy remove
```

## 依赖方向（严格单向，无环）

```
index.js ──> config.js ──> auth.js
    │            prompt.js
    └──> tools.js ──> tools/<工具>.js ──> tools/{shared,paths,walk}.js
                  └──> client.js ──> client/<能力>.js ──> client/{errors,transport}.js
                                                       └──> format.js / auth.js
```

- `tools/<工具>.js` **互不 import**；公共能力走 `shared/paths/walk`。
- `tools/<工具>.js` 通过工厂参数拿到依赖（`ctx`），不直接摸 client 单例：

  ```js
  export function createLsTool(ctx) {
  	const { clampInt, config, entryLine, getClient, guarded, resolve, walkDirectory } = ctx;
  	return { name: "zspace_ls", description, parameters, outputSchema, render, call, execute };
  }
  ```

- `client/<能力>.js` 导出 `fn(client, ...args)` 纯函数，`client.js` 把方法名绑到同一个 `client` 实例；
  好处是每块能力都能脱离 class 单测，而对外仍然是 `new ZSpaceClient()`。

## 加东西的流程

**加一个工具**（三步）

1. `lib/tools/<名字>.js`：导出 `create<Name>Tool(ctx)`，返回
   `{ name, description, parameters, outputSchema, render, call, execute }`；
2. `lib/tools.js`：`import` 该工厂，并在 `createToolSpecs` 的 `return [...]` 里加一行 —— **顺序即模型看到的工具表顺序**，破坏性写入放后面；
3. `test/tools.test.js`：补一条断言（路径解析/参数护栏/outputSchema 自洽）。

**加一个客户端能力**

1. `lib/client/<能力>.js`：`export async function foo(client, ...)`；
2. `lib/client.js`：`import` 后加一个薄委托方法；
3. `lib/client.d.ts`（对外 API 变了才动）。

## 约定

- 单文件控制在 ~200 行内（`transport.js` 是唯一例外：编码→发送→校验逻辑内聚在一起）；
- 每个文件顶部一句话职责 + `@module dsh-zspace/...`；
- 对外 API 只有 `lib/index.js`（插件）与 `lib/client.js`（`ZSpaceClient` / `ZSpaceError`）两个入口，子模块视为内部结构，不进 `package.json` 的 `exports`；
- 逻辑改动必须让 28 项 mock 测试保持全绿，触及传输/上传时另跑 `node scripts/live-selftest.js` 真机验证。
