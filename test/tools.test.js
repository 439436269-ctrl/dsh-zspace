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
	// overwrite 缺省 = 允许覆盖（fake client 的 info 永远成功，正好走这条分支）
	const forced = await write.execute({ path: "note.txt", content: "覆盖" });
	assert.equal(forced.path, `${HOME}/note.txt`);

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

test("every spec is well-formed: unique zspace_ name, described parameters, valid output", async () => {
	const client = fakeClient();
	const specs = createToolSpecs({ getClient: () => client, config: { downloadDir: "", readMaxBytes: 262_144, listMaxEntries: 2000 } });
	const names = new Set();
	for (const spec of specs) {
		assert.match(spec.name, /^zspace_[a-z]+$/, `${spec.name} must be namespaced`);
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
	assert.equal(names.size, 13, "the plugin ships 13 tools");
});
