/**
 * Tool-layer tests: path resolution, argument guards, output shape and
 * rendering — all against a fake client, so no NAS and no host packages are
 * involved.
 *
 * The output-shape check re-implements the enforced JSON Schema subset the DSH
 * tool runtime validates against (property-level `required`, `type`,
 * `additionalProperties: false`, `items`), so a typo in an `outputSchema` fails
 * here instead of at the first real tool call.
 *
 * Run with: node --test test/
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { ZSpaceError } from "../lib/client.js";
import { createToolSpecs, normalizeRemote } from "../lib/tools.js";

const HOME = "/sata1/my/data";
const PUBLIC = "/sata1/public";

/** Temp directories removed when the suite ends. @type {string[]} */
const temporaryDirs = [];
after(() => {
	for (const dir of temporaryDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Build a fake client with a tiny in-memory tree.
 *
 * @param {object} [overrides] - method overrides.
 * @returns {Record<string, any>} fake client.
 */
function fakeClient(overrides = {}) {
	const client = {
		baseUrl: "http://127.0.0.1:13579",
		identity: { username: "tester", nasId: "ZTEST", deviceId: "dev", vuexPath: "/tmp/vuex.json" },
		check: async () => true,
		pools: async () => [{ name: "sata1", status: "ok", totalSize: 22002093703168, freeSize: 14480136368128 }],
		homePath: async () => HOME,
		publicPath: async () => PUBLIC,
		isDirectory: async () => true,
		list: async (dir) => ({
			entries: [
				{ name: "docs", path: `${dir}/docs`, dir: true, size: 0, modified: "2026-10-05 10:00", created: "", ext: "" },
				{ name: "note.txt", path: `${dir}/note.txt`, dir: false, size: 12, modified: "2026-10-05 10:01", created: "", ext: "txt" },
			],
			truncated: false,
		}),
		transportReport: async () => ({ transport: "relay", configured: false, probe: null }),
		info: async (target) => ({ name: path.posix.basename(target), path: target, dir: false, size: 12, modified: "2026-10-05 10:01", created: "2026-10-05 09:00", ext: "txt" }),
		readFile: async () => ({ buffer: Buffer.from("hello 极空间"), truncated: false, bytes: 14 }),
		download: async (remote, localDir) => ({ localPath: path.join(localDir, path.posix.basename(remote)), bytes: 14 }),
		upload: async () => ({ remotePath: `${HOME}/note.txt`, bytes: 14, method: "create" }),
		mkdir: async () => ({ name: "新目录", path: `${HOME}/新目录`, dir: true, size: 0, modified: "", created: "", ext: "" }),
		rename: async () => ({ name: "新名字.txt", path: `${HOME}/新名字.txt`, dir: false, size: 0, modified: "", created: "", ext: "" }),
		move: async () => {},
		copy: async () => {},
		remove: async () => {},
		...overrides,
	};
	return client;
}

/**
 * Build a client stub that answers Docker-namespace calls **at the wire
 * boundary** (`client.send`), because the Docker capability deliberately reuses
 * the real URL shaping and auth from `lib/client/`. Recording every request is
 * what lets these tests pin the protocol facts: `container_op` is GET,
 * `/system/reboot` is POST, and a non-`200` `code` beats an HTTP 200.
 *
 * @param {object} [options] - canned answers.
 * @param {Array<Record<string, any>>} [options.containers] - raw `container_list` rows.
 * @param {Record<string, any>} [options.inspect] - raw `container_info` payload.
 * @param {string} [options.logs] - raw `container_logs` text.
 * @param {Record<string, any>} [options.top] - raw `container_top` payload.
 * @param {string} [options.topStderr] - daemon error text for `container_top`.
 * @param {string} [options.listError] - daemon error text for `container_list`.
 * @param {string} [options.service] - `system_status` value.
 * @returns {{client: Record<string, any>, calls: Array<Record<string, any>>}} stub and its call log.
 */
function dockerClient(options = {}) {
	/** @type {Array<Record<string, any>>} */
	const calls = [];
	const ok = data => ({ status: 200, headers: {}, text: JSON.stringify({ code: "200", data }) });
	const fail = code => ({ status: 200, headers: {}, text: JSON.stringify({ code }) });
	const containers = options.containers ?? [
		{ Names: "/appstore_openclaw", State: "running", Status: "Up 3 days", Id: "a".repeat(64) },
		{ Names: "/appstore_ollama", State: "exited", Status: "Exited (137) 2 days ago", Id: "b".repeat(64) },
	];
	const inspect = options.inspect ?? {
		Name: "/appstore_openclaw",
		Id: "a".repeat(64),
		Created: "2026-10-01T10:00:00Z",
		State: { Status: "running" },
		Config: { Image: "openclaw:latest", Cmd: ["bash", "/entry.sh"], Entrypoint: ["/init"], Env: ["TZ=Asia/Shanghai"] },
		HostConfig: { NetworkMode: "host", RestartPolicy: { Name: "always" }, PortBindings: { "19388/tcp": [{ HostPort: "19388" }] } },
		Mounts: [{ Destination: "/dsh", Source: "/sata1/my/data/dsh", Type: "bind" }],
	};

	const client = {
		baseUrl: "http://127.0.0.1:13579",
		credentials: { token: "tok", nasId: "ZTEST", deviceId: "dev" },
		maxRetries: 2,
		send: async request => {
			calls.push(request);
			switch (request.endpoint) {
				case "/zdocker/system_status":
					return ok({ status: options.service ?? "on" });
				case "/zdocker/container_list":
					return options.listError ? fail(options.listError) : ok(containers);
				case "/zdocker/container_info":
					return ok(inspect);
				case "/zdocker/container_logs":
					return ok(options.logs ?? "line one\nline two");
				case "/zdocker/container_op":
					return ok(null);
				case "/zdocker/container_top":
					return options.topStderr ? fail(options.topStderr) : ok(options.top ?? { Processes: [["root", "1"], ["root", "2"], ["root", "3"]] });
				case "/system/reboot":
					return ok({});
				default:
					return { status: 404, headers: {}, text: "404 page not found" };
			}
		},
	};
	return { client, calls };
}

/**
 * Build the tool specs for one fake client.
 *
 * @param {Record<string, any>} client - fake client.
 * @param {Record<string, any>} [config] - plugin config overrides.
 * @returns {Map<string, Record<string, any>>} specs by name.
 */
function specsFor(client, config = {}) {
	const resolved = {
		downloadDir: "",
		readMaxBytes: 262_144,
		listMaxEntries: 2000,
		...config,
	};
	const specs = createToolSpecs({ getClient: () => client, config: resolved });
	return new Map(specs.map(spec => [spec.name, spec]));
}

/**
 * Validate a value against the enforced schema subset used by DSH tools.
 *
 * @param {Record<string, any>} schema - schema in spec form.
 * @param {unknown} value - candidate value.
 * @param {string} [at] - path for failure messages.
 * @returns {void}
 */
function assertSchema(schema, value, at = "value") {
	if (schema.type === "object") {
		assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), `${at} must be an object`);
		for (const [key, property] of Object.entries(schema.properties ?? {})) {
			if (property.required === true) assert.ok(Object.hasOwn(value, key), `${at}.${key} is required`);
			if (Object.hasOwn(value, key)) assertSchema(property, value[key], `${at}.${key}`);
		}
		if (schema.additionalProperties === false) {
			for (const key of Object.keys(value)) {
				assert.ok(Object.hasOwn(schema.properties ?? {}, key), `${at}.${key} is not declared in the schema`);
			}
		}
		return;
	}
	if (schema.type === "array") {
		assert.ok(Array.isArray(value), `${at} must be an array`);
		if (schema.items) for (const [index, item] of value.entries()) assertSchema(schema.items, item, `${at}[${index}]`);
		return;
	}
	if (schema.type === "integer") {
		assert.ok(Number.isInteger(value), `${at} must be an integer (got ${JSON.stringify(value)})`);
		return;
	}
	if (schema.type === "number") {
		assert.equal(typeof value, "number", `${at} must be a number`);
		return;
	}
	if (schema.type === "boolean") {
		assert.equal(typeof value, "boolean", `${at} must be a boolean`);
		return;
	}
	if (schema.type === "string") {
		assert.equal(typeof value, "string", `${at} must be a string`);
	}
}

test("normalizeRemote collapses slashes and trailing separators", () => {
	assert.equal(normalizeRemote("/sata1//my/data/"), "/sata1/my/data");
	assert.equal(normalizeRemote("/"), "/");
});

test("path resolution understands home:/public:/relative/absolute", async () => {
	const seen = [];
	const client = fakeClient({ list: async (dir) => (seen.push(dir), { entries: [], truncated: false }) });
	const ls = specsFor(client).get("zspace_ls");
	await ls.execute({});
	await ls.execute({ path: "public:skills" });
	await ls.execute({ path: "docs/2026" });
	await ls.execute({ path: "/sata1/my/data/absolute" });
	await ls.execute({ path: "home:相册" });
	assert.deepEqual(seen, [
		HOME,
		`${PUBLIC}/skills`,
		`${HOME}/docs/2026`,
		"/sata1/my/data/absolute",
		`${HOME}/相册`,
	]);
});

test("ls walks subdirectories, tags depth, and reports truncation", async () => {
	let calls = 0;
	const client = fakeClient({
		list: async (dir) => {
			calls += 1;
			if (dir === HOME) {
				return {
					entries: [
						{ name: "a", path: `${HOME}/a`, dir: true, size: 0, modified: "", created: "", ext: "" },
						{ name: "b.txt", path: `${HOME}/b.txt`, dir: false, size: 3, modified: "", created: "", ext: "txt" },
					],
					truncated: false,
				};
			}
			return {
				entries: [{ name: "c.txt", path: `${dir}/c.txt`, dir: false, size: 4, modified: "", created: "", ext: "txt" }],
				truncated: false,
			};
		},
	});
	const ls = specsFor(client).get("zspace_ls");
	const value = await ls.execute({ depth: 2 });
	assertSchema(ls.outputSchema, value);
	assert.deepEqual(value.entries.map(entry => [entry.name, entry.depth]), [["a", 0], ["c.txt", 1], ["b.txt", 0]]);
	assert.equal(calls, 2);
	assert.equal(value.truncated, false);

	const shallow = await ls.execute({ depth: 1, limit: 1 });
	assert.equal(shallow.count, 1);
	assert.equal(shallow.truncated, true);
	assert.match(ls.render({}, shallow)[0].text, /截断/);
});

test("stat and read shape their results", async () => {
	const client = fakeClient();
	const specs = specsFor(client);

	const stat = await specs.get("zspace_stat").execute({ path: "note.txt" });
	assertSchema(specs.get("zspace_stat").outputSchema, stat);
	assert.equal(stat.path, `${HOME}/note.txt`);

	const read = await specs.get("zspace_read").execute({ path: "note.txt" });
	assertSchema(specs.get("zspace_read").outputSchema, read);
	assert.equal(read.content, "hello 极空间");
	assert.equal(read.binary, false);

	const binaryRead = specsFor(fakeClient({ readFile: async () => ({ buffer: Buffer.from([1, 0, 2]), truncated: false, bytes: 3 }) })).get("zspace_read");
	const binary = await binaryRead.execute({ path: "blob.bin" });
	assert.equal(binary.binary, true);
	assert.equal(binary.content, "");
	assert.match(binaryRead.render({}, binary)[0].text, /二进制/);
});

test("find walks the tree by name and reports its coverage", async () => {
	const tree = {
		[HOME]: [
			{ name: "docs", path: `${HOME}/docs`, dir: true, size: 0, modified: "2026-10-05 10:00", created: "", ext: "" },
			{ name: "note.txt", path: `${HOME}/note.txt`, dir: false, size: 12, modified: "2026-10-05 10:01", created: "", ext: "txt" },
		],
		[`${HOME}/docs`]: [
			{ name: "简历-v1.pdf", path: `${HOME}/docs/简历-v1.pdf`, dir: false, size: 5, modified: "2026-10-05 10:02", created: "", ext: "pdf" },
		],
		[PUBLIC]: [
			{ name: "简历-v2.pdf", path: `${PUBLIC}/简历-v2.pdf`, dir: false, size: 5, modified: "2026-10-05 10:03", created: "", ext: "pdf" },
		],
	};
	const client = fakeClient({ list: async (dir) => ({ entries: tree[dir] ?? [], truncated: false }) });
	const find = specsFor(client).get("zspace_find");

	const all = await find.execute({ keyword: "简历" });
	assertSchema(find.outputSchema, all);
	assert.deepEqual([...all.matches.map(match => match.path)].sort(), [`${HOME}/docs/简历-v1.pdf`, `${PUBLIC}/简历-v2.pdf`]);
	assert.equal(all.roots.length, 2, "an unscoped find scans both spaces");
	assert.equal(all.scanned, 4);
	assert.equal(all.truncated, false);
	assert.match(find.render({}, all)[0].text, /已扫 4 项/);

	const scoped = await find.execute({ keyword: "简历", path: "home:docs" });
	assert.deepEqual(scoped.roots, [`${HOME}/docs`]);
	assert.deepEqual(scoped.matches.map(match => match.name), ["简历-v1.pdf"]);

	const shallow = await find.execute({ keyword: "简历", depth: 1 });
	assert.deepEqual(
		shallow.matches.map(match => match.name),
		["简历-v2.pdf"],
		"depth 1 must match direct children only, not nested ones",
	);

	const missing = await find.execute({ keyword: "根本不存在的名字" });
	assert.equal(missing.matches.length, 0);
	assert.match(find.render({}, missing)[0].text, /没有找到/);

	const capped = await find.execute({ keyword: "简历", limit: 1 });
	assert.equal(capped.matches.length, 1);
	assert.equal(capped.truncated, true);
	assert.match(find.render({}, capped)[0].text, /可能不完整/);

	await assert.rejects(() => find.execute({ keyword: "  " }), /must not be blank/);
});

test("download targets the configured directory", async () => {
	let seenDir = "";
	const client = fakeClient({
		download: async (remote, localDir) => (seenDir = localDir, { localPath: `${localDir}/note.txt`, bytes: 14 }),
	});
	const download = specsFor(client, { downloadDir: "/tmp/zs-downloads" }).get("zspace_download");
	const value = await download.execute({ path: "note.txt" });
	assertSchema(download.outputSchema, value);
	assert.equal(seenDir, "/tmp/zs-downloads");
	assert.equal(value.remotePath, `${HOME}/note.txt`);

	const fallback = specsFor(client).get("zspace_download");
	await fallback.execute({ path: "note.txt" });
	assert.equal(seenDir, path.join(os.homedir(), "Downloads", "zspace"));

	await fallback.execute({ path: "note.txt", dir: "~/zs-test-downloads" });
	assert.equal(seenDir, path.join(os.homedir(), "zs-test-downloads"), "`~/` must expand to the home directory");
});

test("upload resolves the local file and the remote directory", async () => {
	let seen = null;
	const client = fakeClient({
		upload: async (localPath, remoteDir, options) => (seen = { localPath, remoteDir, options }, { remotePath: `${remoteDir}/${options.name ?? path.basename(localPath)}`, bytes: 14, method: "sliced" }),
	});
	const upload = specsFor(client).get("zspace_upload");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-zspace-upload-"));
	temporaryDirs.push(dir);
	const local = path.join(dir, "素材.md");
	fs.writeFileSync(local, "# 素材\n");
	const value = await upload.execute({ localPath: local, remoteDir: "public:上传", name: "改名.md" });
	assertSchema(upload.outputSchema, value);
	assert.ok(path.isAbsolute(seen.localPath));
	assert.equal(seen.remoteDir, `${PUBLIC}/上传`);
	assert.equal(value.remotePath, `${PUBLIC}/上传/改名.md`);
	assert.equal(value.method, "sliced");
	assert.match(upload.render({}, value)[0].text, /分片/);

	await assert.rejects(() => upload.execute({ localPath: "./definitely-missing-file.bin" }), /本地文件不存在/);
	await assert.rejects(
		() => upload.execute({ localPath: "~/definitely-missing-dsh-zspace.bin" }),
		error => {
			assert.match(error.message, /DSH 宿主进程目录/);
			assert.ok(error.message.includes(path.join(os.homedir(), "definitely-missing-dsh-zspace.bin")), "`~/` must expand to the home directory");
			return true;
		},
	);
});

test("write puts text onto the NAS through a cleaned-up staging file", async () => {
	let seen = null;
	const client = fakeClient({
		upload: async (localPath, remoteDir, options) => {
			seen = { localPath, remoteDir, options, content: fs.readFileSync(localPath, "utf8"), existedAtCall: fs.existsSync(localPath) };
			return { remotePath: `${remoteDir}/${options.name}`, bytes: Buffer.byteLength(seen.content, "utf8"), method: "create" };
		},
	});
	const write = specsFor(client).get("zspace_write");
	const body = "极空间写入测试\n第二行\n";

	const value = await write.execute({ path: "public:笔记/日报.md", content: body });
	assertSchema(write.outputSchema, value);
	assert.equal(value.path, `${PUBLIC}/笔记/日报.md`);
	assert.equal(value.bytes, Buffer.byteLength(body, "utf8"));
	assert.equal(value.method, "create");
	assert.equal(seen.remoteDir, `${PUBLIC}/笔记`);
	assert.equal(seen.options.name, "日报.md");
	assert.equal(seen.content, body, "临时文件内容必须是待写入的文本");
	assert.equal(fs.existsSync(seen.localPath), false, "临时目录必须清理干净");
	assert.match(write.render({}, value)[0].text, /已写入/);

	// overwrite=false 且目标已存在 -> 拒绝
	await assert.rejects(
		() => write.execute({ path: "note.txt", content: "x", overwrite: false }),
		/overwrite=false 时拒绝覆盖/,
	);
	// overwrite 缺省 = 允许覆盖：中转通道必须「先删（进回收站）再写」，否则 /v2/file/create 会因同名失败
	const removed = [];
	const relayClient = fakeClient({
		remove: async (paths) => {
			removed.push(paths);
		},
		upload: async (localPath, remoteDir, options) => ({ remotePath: `${remoteDir}/${options.name}`, bytes: 6, method: "create" }),
	});
	const relayWrite = specsFor(relayClient).get("zspace_write");
	const forced = await relayWrite.execute({ path: "note.txt", content: "覆盖" });
	assert.equal(forced.path, `${HOME}/note.txt`);
	assert.deepEqual(removed, [[`${HOME}/note.txt`]], "relay 通道覆盖前必须先把旧文件移入回收站");

	// 直连 WebDAV 通道：PUT 本身就是覆盖，绝不能先删（那可能是永久删除）
	const davRemoved = [];
	const davClient = fakeClient({
		transportReport: async () => ({ transport: "webdav", configured: true, probe: { usable: true } }),
		remove: async (paths) => {
			davRemoved.push(paths);
		},
		upload: async (localPath, remoteDir, options) => ({ remotePath: `${remoteDir}/${options.name}`, bytes: 6, method: "put" }),
	});
	const davWrite = specsFor(davClient).get("zspace_write");
	const davValue = await davWrite.execute({ path: "note.txt", content: "覆盖" });
	assert.equal(davValue.method, "put");
	assert.deepEqual(davRemoved, [], "WebDAV 通道不该先删（PUT 直接覆盖）");

	// 目标不存在时任何通道都不删
	const missingRemoved = [];
	const freshClient = fakeClient({
		info: async () => {
			throw Object.assign(new Error("文件不存在"), { code: "N001315" });
		},
		remove: async (paths) => {
			missingRemoved.push(paths);
		},
		upload: async (localPath, remoteDir, options) => ({ remotePath: `${remoteDir}/${options.name}`, bytes: 3, method: "create" }),
	});
	await specsFor(freshClient).get("zspace_write").execute({ path: "new.txt", content: "新" });
	assert.deepEqual(missingRemoved, [], "新文件不该触发删除");

	await assert.rejects(() => write.execute({ path: "note.txt", content: "" }), /不能为空/);
	// 用小上限的配置验证体积护栏（默认 5 MB，测试里不方便造）
	const tiny = specsFor(client, { writeMaxBytes: 1024 }).get("zspace_write");
	await assert.rejects(
		() => tiny.execute({ path: "big.txt", content: "x".repeat(2000) }),
		/超过 writeMaxBytes=1024/,
	);
});

test("write tools validate their arguments", async () => {
	const client = fakeClient();
	const specs = specsFor(client);

	const mkdir = await specs.get("zspace_mkdir").execute({ path: "新建目录" });
	assertSchema(specs.get("zspace_mkdir").outputSchema, mkdir);
	assert.equal(mkdir.path, `${HOME}/新建目录`);
	await assert.rejects(() => specs.get("zspace_mkdir").execute({ path: "/" }), /不能创建根目录/);

	const rename = await specs.get("zspace_rename").execute({ path: "note.txt", newName: "新名字.txt" });
	assertSchema(specs.get("zspace_rename").outputSchema, rename);
	await assert.rejects(() => specs.get("zspace_rename").execute({ path: "note.txt", newName: "a/b.txt" }), /纯文件名/);

	const move = await specs.get("zspace_move").execute({ paths: ["note.txt", "public:skills"], to: "docs" });
	assertSchema(specs.get("zspace_move").outputSchema, move);
	assert.deepEqual([move.count, move.to], [2, `${HOME}/docs`]);
	await assert.rejects(() => specs.get("zspace_move").execute({ paths: [], to: "docs" }), /must not be empty/);

	const copy = await specs.get("zspace_copy").execute({ paths: ["note.txt"], to: "/sata1/public/备份" });
	assert.equal(copy.to, "/sata1/public/备份");

	await assert.rejects(() => specs.get("zspace_remove").execute({ paths: ["note.txt"] }), /confirm=true/);
	const remove = await specs.get("zspace_remove").execute({ paths: ["note.txt"], confirm: true });
	assertSchema(specs.get("zspace_remove").outputSchema, remove);
	assert.deepEqual(remove.paths, [`${HOME}/note.txt`]);
});

test("status reports a live NAS and degrades gracefully when it is not", async () => {
	const specs = specsFor(fakeClient());
	const status = await specs.get("zspace_status").execute({});
	assertSchema(specs.get("zspace_status").outputSchema, status);
	assert.equal(status.ok, true);
	assert.equal(status.homePath, HOME);
	assert.equal(status.publicPath, PUBLIC);
	assert.equal(status.pools[0].name, "sata1");
	assert.match(specs.get("zspace_status").render({}, status)[0].text, /极空间在线/);

	const offline = specsFor(fakeClient({ check: async () => false })).get("zspace_status");
	const down = await offline.execute({});
	assertSchema(offline.outputSchema, down);
	assert.equal(down.ok, false);
	assert.match(down.message, /桌面客户端/);
	assert.match(offline.render({}, down)[0].text, /不可用/);

	const partial = specsFor(
		fakeClient({
			publicPath: async () => {
				throw new ZSpaceError("NOPUBLIC", "无法定位公共空间");
			},
		}),
	).get("zspace_status");
	const degraded = await partial.execute({});
	assert.equal(degraded.ok, true, "a working personal space still counts as online");
	assert.match(degraded.message, /公共空间/);
});

test("ZSpace failures carry their hint into the tool error", async () => {
	const failing = specsFor(
		fakeClient({
			list: async () => {
				throw new ZSpaceError("N001411", "无权限进行此操作");
			},
		}),
	).get("zspace_ls");
	await assert.rejects(() => failing.execute({ path: "/" }), /没有权限/);
});

test("docker list reports the roster, running count and uses GET", async () => {
	const { client, calls } = dockerClient();
	const specs = specsFor(client);
	const list = specs.get("zspace_docker_list");
	const value = await list.execute({});
	assertSchema(list.outputSchema, value);
	assert.deepEqual([value.count, value.running], [2, 1]);
	assert.deepEqual(value.containers.map(container => container.name), ["appstore_openclaw", "appstore_ollama"]);
	assert.match(list.render({}, value)[0].text, /1\/2 运行中/);
	assert.equal(calls[0].method, "GET");
	assert.equal(calls[0].endpoint, "/zdocker/container_list");
	assert.match(calls[0].headers.Cookie, /token=tok/, "会话必须靠 Cookie 带上");
	assert.match(calls[0].url, /^http:\/\/127\.0\.0\.1:13579\/zdocker\/container_list\?&rnd=/);
});

test("docker inspect resolves a name and shapes the configuration", async () => {
	const { client, calls } = dockerClient();
	const inspect = specsFor(client).get("zspace_docker_inspect");
	const value = await inspect.execute({ container: "appstore_openclaw" });
	assertSchema(inspect.outputSchema, value);
	assert.equal(value.name, "appstore_openclaw");
	assert.equal(value.image, "openclaw:latest");
	assert.equal(value.state, "running");
	assert.deepEqual(value.mounts, [{ destination: "/dsh", source: "/sata1/my/data/dsh", type: "bind" }]);
	assert.deepEqual(value.env, ["TZ=Asia/Shanghai"]);
	assert.equal(value.restartPolicy, "always");
	assert.equal(value.networkMode, "host");
	assert.deepEqual(value.ports, ["0.0.0.0:19388->19388/tcp"]);
	const text = inspect.render({}, value)[0].text;
	assert.match(text, /19388/);
	assert.match(text, /\/sata1\/my\/data\/dsh/);
	assert.equal(calls.at(-1).endpoint, "/zdocker/container_info");
	assert.match(calls.at(-1).url, new RegExp(`container_id=${"a".repeat(64)}`), "名字必须解析成 NAS 报告的完整 id");
	await assert.rejects(() => inspect.execute({ container: "不存在的容器" }), /没有找到容器/);
	await assert.rejects(() => inspect.execute({ container: "  " }), /需要一个容器名或 id/);
});

test("docker logs strips multiplexed control bytes and honours tail", async () => {
	// 真机形状：每行前面是 8 字节帧头（类型 + 3 个 0 + 4 字节大端长度），
	// 长度末字节解码后会以 `j`/`;`/U+FFFD 之类串到行首。
	const muxed = "\u0001\u0000\u0000\u0000\u0000\u0000\u0001jline one\n\u0002\u0000\u0000\u0000\u0000\u0000\u0000;line two\u0002";
	const { client, calls } = dockerClient({ logs: muxed });
	const logs = specsFor(client).get("zspace_docker_logs");
	const value = await logs.execute({ container: "appstore_openclaw", tail: 20 });
	assertSchema(logs.outputSchema, value);
	assert.equal(value.log, "line one\nline two", "帧头与长度字节都不能留在正文里");
	assert.equal(value.lines, 2);
	assert.equal(value.container, "appstore_openclaw");
	assert.match(calls.at(-1).url, /tail=20/);
	assert.match(logs.render({}, value)[0].text, /最近 2 行/);

	const capped = await logs.execute({ container: "appstore_openclaw", tail: 99999 });
	assert.match(calls.at(-1).url, /tail=2000/, "tail 上限 2000");

	const empty = specsFor(dockerClient({ logs: "" }).client).get("zspace_docker_logs");
	const blank = await empty.execute({ container: "appstore_openclaw" });
	assert.equal(blank.lines, 0);
	assert.match(empty.render({}, blank)[0].text, /日志为空/);
});

test("docker op guards remove, rejects unknown actions, and still uses GET", async () => {
	const { client, calls } = dockerClient();
	const op = specsFor(client).get("zspace_docker_op");

	await assert.rejects(() => op.execute({ container: "appstore_openclaw", action: "remove" }), /confirm=true/);
	assert.equal(calls.length, 0, "缺少 confirm 时不该发出任何请求");
	await assert.rejects(() => op.execute({ container: "appstore_openclaw", action: "unpause" }), /不支持的 action/);
	await assert.rejects(() => op.execute({ container: "nope", action: "start" }), /没有找到容器/);

	const restarted = await op.execute({ container: "appstore_ollama", action: "restart" });
	assertSchema(op.outputSchema, restarted);
	assert.equal(restarted.container, "appstore_ollama");
	assert.equal(restarted.action, "restart");
	assert.equal(restarted.ok, true);
	assert.equal(calls.at(-1).endpoint, "/zdocker/container_op");
	assert.equal(calls.at(-1).method, "GET", "container_op 是 GET；POST 会 404");
	assert.match(calls.at(-1).url, /action=restart/);

	const removed = await op.execute({ container: "appstore_openclaw", action: "remove", confirm: true });
	assert.equal(removed.ok, true);
	assert.match(calls.at(-1).url, /action=remove/);
	assert.match(op.render({}, removed)[0].text, /已提交/);
});

test("docker health distinguishes healthy, wedged, off and inconclusive probes", async () => {
	const healthy = specsFor(dockerClient().client).get("zspace_docker_health");
	const value = await healthy.execute({});
	assertSchema(healthy.outputSchema, value);
	assert.equal(value.verdict, "healthy");
	assert.equal(value.processCount, 3);
	assert.equal(value.probeContainer, "appstore_openclaw");
	assert.equal(value.service, "on");
	assert.match(healthy.render({}, value)[0].text, /✅/);

	const wedged = specsFor(
		dockerClient({ topStderr: "Error response from daemon: ... dial unix:///run/containerd/containerd.sock: timeout" }).client,
	).get("zspace_docker_health");
	const wedgedValue = await wedged.execute({});
	assert.equal(wedgedValue.verdict, "containerd-wedged");
	assert.equal(wedgedValue.processCount, 0);
	assert.match(wedgedValue.detail, /containerd\.sock/);
	assert.match(wedged.render({}, wedgedValue)[0].text, /zspace_system_reboot/);

	const noProcesses = specsFor(dockerClient({ top: { message: "no process list here" } }).client).get("zspace_docker_health");
	const broken = await noProcesses.execute({});
	assert.equal(broken.verdict, "error", "没有 Processes 数组就不算健康");
	assert.match(broken.detail, /no process list here/);

	const exited = [{ Names: "/appstore_ollama", State: "exited", Status: "Exited (137)", Id: "b".repeat(64) }];
	const notRunning = specsFor(dockerClient({ containers: exited }).client).get("zspace_docker_health");
	const none = await notRunning.execute({});
	assert.equal(none.verdict, "container-not-running");
	assert.equal(none.probeContainer, "");
	assert.match(notRunning.render({}, none)[0].text, /不可信/);

	const pinned = specsFor(dockerClient().client).get("zspace_docker_health");
	const stoppedProbe = await pinned.execute({ container: "appstore_ollama" });
	assert.equal(stoppedProbe.verdict, "container-not-running");
	assert.equal(stoppedProbe.probeContainer, "appstore_ollama");

	const off = specsFor(dockerClient({ service: "off" }).client).get("zspace_docker_health");
	const offValue = await off.execute({});
	assert.equal(offValue.verdict, "service-off");
	assert.match(off.render({}, offValue)[0].text, /Docker 服务是关的/);

	const listDown = specsFor(dockerClient({ listError: "Error response from daemon: timeout" }).client).get("zspace_docker_health");
	const downValue = await listDown.execute({});
	assert.equal(downValue.verdict, "error", "列表都读不到时给出 error 而不是抛出");
	assert.match(downValue.detail, /容器列表读取失败/);
});

test("system reboot requires confirm and posts", async () => {
	const { client, calls } = dockerClient();
	const reboot = specsFor(client).get("zspace_system_reboot");
	await assert.rejects(() => reboot.execute({}), /confirm=true/);
	assert.equal(calls.length, 0, "缺少 confirm 时不该发出任何请求");

	const value = await reboot.execute({ confirm: true });
	assertSchema(reboot.outputSchema, value);
	assert.equal(value.ok, true);
	assert.equal(calls.at(-1).endpoint, "/system/reboot");
	assert.equal(calls.at(-1).method, "POST", "/system/reboot 是 POST；GET 会 404");
	assert.equal(calls.at(-1).body.toString("utf8"), "{}");
	assert.match(reboot.render({}, value)[0].text, /7~8 分钟/);
});

test("docker failures surface the daemon text and the 404 method hint", async () => {
	const daemon = specsFor(
		dockerClient({ listError: "Error response from daemon: ... dial unix:///run/containerd/containerd.sock: timeout" }).client,
	).get("zspace_docker_list");
	await assert.rejects(
		() => daemon.execute({}),
		error => {
			assert.match(error.message, /containerd\.sock: timeout/);
			assert.match(error.message, /只能整机重启|zspace_system_reboot/);
			return true;
		},
	);

	// 方法传错时 openresty 直接回纯文本 404（不是 JSON 包封）—— 必须能被读懂并给出提示
	const wrongMethod = {
		baseUrl: "http://127.0.0.1:13579",
		credentials: { token: "tok", nasId: "ZTEST", deviceId: "dev" },
		send: async () => ({ status: 404, headers: {}, text: "404 page not found" }),
	};
	await assert.rejects(
		() => specsFor(wrongMethod).get("zspace_docker_list").execute({}),
		error => {
			assert.match(error.message, /404 page not found/);
			assert.match(error.message, /方法传错/);
			return true;
		},
	);
});

test("every spec is well-formed: unique zspace_ name, described parameters, valid output", async () => {
	const client = fakeClient();
	const specs = createToolSpecs({ getClient: () => client, config: { downloadDir: "", readMaxBytes: 262_144, listMaxEntries: 2000 } });
	const names = new Set();
	for (const spec of specs) {
		assert.match(spec.name, /^zspace_[a-z][a-z_]*$/, `${spec.name} must be namespaced`);
		assert.equal(names.has(spec.name), false, `${spec.name} registered twice`);
		names.add(spec.name);
		assert.ok(spec.description.length > 40, `${spec.name} needs a real description`);
		assert.equal(typeof spec.execute, "function", `${spec.name} needs an execute`);
		assert.equal(typeof spec.render, "function", `${spec.name} needs a render`);
		for (const [parameter, schema] of Object.entries(spec.parameters ?? {})) {
			assert.ok(["string", "integer", "number", "boolean", "array", "object"].includes(schema.type), `${spec.name}.${parameter} has type ${schema.type}`);
			assert.equal(typeof schema.description, "string", `${spec.name}.${parameter} needs a description`);
			if (schema.type === "array") assert.ok(schema.items, `${spec.name}.${parameter} needs items`);
			if (schema.required === true) assert.ok(schema.description.length > 0, `${spec.name}.${parameter} is required but undocumented`);
		}
		assert.equal(spec.outputSchema.type, "object", `${spec.name} output must be an object`);
		assert.equal(spec.outputSchema.additionalProperties, false, `${spec.name} output must be closed`);
	}
	assert.equal(names.size, 19, "the plugin ships 19 tools (13 file tools + 6 Docker/system tools)");
});
