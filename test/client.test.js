/**
 * Client-layer tests against a mock ZSpace desktop-client proxy.
 *
 * The mock mirrors the real proxy's contract: common parameters must arrive in
 * the **form body** (query-string auth makes the NAS answer N001212), URLs
 * carry `?&rnd=…&webagent=v2`, `/v2/file/create` carries a percent-encoded
 * `path` header, and oversized create bodies answer HTTP 413 so the client must
 * fall back to the sliced protocol.
 *
 * Run with: node --test test/
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { ZSpaceClient, ZSpaceError } from "../lib/client.js";

/**
 * Start one mock proxy.
 *
 * @param {object} [options] - mock options.
 * @param {number} [options.createLimitBytes] - create bodies above this answer 413.
 * @param {number} [options.failFirstAttempts] - answer HTTP 500 this many times first.
 * @returns {Promise<{baseUrl: string, state: any, close: () => Promise<void>}>} mock handle.
 */
async function startMockProxy(options = {}) {
	const state = {
		files: new Map(),
		dirs: new Set(["/", "/sata1", "/sata1/my", "/sata1/my/data", "/sata1/public"]),
		listCalls: 0,
		uploadSlices: [],
		attempts: 0,
		authInQuery: false,
	};
	const createLimitBytes = options.createLimitBytes ?? Number.POSITIVE_INFINITY;
	const failFirstAttempts = options.failFirstAttempts ?? 0;

	/**
	 * Children of one directory in the mock filesystem.
	 *
	 * @param {string} dir - directory path.
	 * @returns {Array<Record<string, unknown>>} rows.
	 */
	function children(dir) {
		const prefix = dir === "/" ? "/" : `${dir}/`;
		const rows = [];
		const push = (full, isDir, content) => {
			const rest = full.slice(prefix.length);
			if (rest === "" || rest.includes("/")) return;
			rows.push({
				name: rest,
				path: full,
				is_dir: isDir ? "1" : "0",
				type: "0",
				size: String(content ? content.length : 0),
				modify_time: "1791187991",
				crtime: "1791187991",
				ext: "",
			});
		};
		for (const d of state.dirs) if (d !== dir) push(d, true);
		for (const [file, content] of state.files) push(file, false, content);
		rows.sort((a, b) => Number(b.is_dir) - Number(a.is_dir) || String(a.name).localeCompare(String(b.name)));
		return rows;
	}

	/**
	 * @param {http.ServerResponse} res - response.
	 * @param {number} status - HTTP status.
	 * @param {unknown} body - JSON body.
	 * @returns {void}
	 */
	function json(res, status, body) {
		const text = JSON.stringify(body);
		res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
		res.end(text);
	}

	/**
	 * @param {http.IncomingMessage} req - request.
	 * @returns {Promise<Buffer>} raw body.
	 */
	async function readBody(req) {
		const chunks = [];
		for await (const chunk of req) chunks.push(chunk);
		return Buffer.concat(chunks);
	}

	const server = http.createServer(async (req, res) => {
		state.attempts += 1;
		if (failFirstAttempts > 0 && state.attempts <= failFirstAttempts) {
			res.writeHead(500).end("boom");
			return;
		}
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		// The sliced-upload endpoint is the one URL that carries only
		// remote_port/drnd/uuid, so the rnd/webagent check skips it.
		const isSliceUpload = url.pathname === "/v2/file/upload";
		if (!isSliceUpload && (!url.search.includes("webagent=v2") || !url.search.includes("rnd="))) {
			json(res, 200, { code: "N001212", msg: "参数有误" });
			return;
		}
		if (url.pathname === "/home/") {
			res.writeHead(200, { "Content-Type": "text/html" }).end("<html>zspace</html>");
			return;
		}
		if (url.pathname === "/v2/file/download") {
			const target = url.searchParams.get("path") ?? "";
			const content = state.files.get(target);
			if (!content) {
				json(res, 200, { code: "N001315", msg: "文件不存在" });
				return;
			}
			res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": content.length });
			res.end(content);
			return;
		}

		const raw = await readBody(req);
		if (url.pathname === "/v2/file/create") {
			if (raw.length > createLimitBytes) {
				res.writeHead(413).end("too large");
				return;
			}
			const target = decodeURIComponent(String(req.headers.path ?? ""));
			state.files.set(target, raw);
			state.dirs.add(target.slice(0, target.lastIndexOf("/")));
			json(res, 200, { code: "200", msg: "200", data: { name: path.posix.basename(target), path: target, is_dir: "0", size: String(raw.length) } });
			return;
		}
		if (url.pathname === "/v2/file/upload") {
			const target = decodeURIComponent(String(req.headers.path ?? ""));
			const seek = Number(req.headers.seek ?? 0);
			const uuid = String(req.headers.uuid ?? "");
			state.uploadSlices.push({ target, seek, length: raw.length, uuid });
			const current = state.files.get(target) ?? Buffer.alloc(0);
			const next = Buffer.alloc(Math.max(current.length, seek + raw.length));
			current.copy(next, 0);
			raw.copy(next, seek);
			state.files.set(target, next);
			json(res, 200, { code: "200", msg: "200", data: { path: target } });
			return;
		}

		const form = new URLSearchParams(raw.toString("utf8"));
		if (url.searchParams.has("token") || url.searchParams.has("nasid")) state.authInQuery = true;
		if (!form.has("token") || !form.has("nasid") || !form.has("device_id")) {
			json(res, 200, { code: "N001212", msg: "参数有误" });
			return;
		}

		switch (url.pathname) {
			case "/zspool/info": {
				json(res, 200, { code: "200", msg: "success", data: { pool_list: [{ id: 1, name: "sata1", status: "ok", total_size: 22002093703168, free_size: 14480136368128 }] } });
				return;
			}
			case "/v2/file/list": {
				state.listCalls += 1;
				const dir = form.get("path") ?? "";
				if (dir === "/" || !state.dirs.has(dir)) {
					// The NAS denies the filesystem root and reports missing dirs the same way.
					json(res, 200, dir === "/" ? { code: "N001411", msg: "无权限进行此操作" } : { code: "N001315", msg: "文件不存在" });
					return;
				}
				const start = Number(form.get("start") ?? 0);
				const limit = Number(form.get("limit") ?? 50);
				const rows = children(dir);
				json(res, 200, { code: "200", msg: "200", data: { list: rows.slice(start, start + limit) } });
				return;
			}
			case "/v2/file/info": {
				const target = form.get("path") ?? "";
				const isDir = state.dirs.has(target);
				if (target === "/" || (!isDir && !state.files.has(target))) {
					json(res, 200, target === "/" ? { code: "N001411", msg: "无权限进行此操作" } : { code: "N001315", msg: "文件不存在" });
					return;
				}
				json(res, 200, {
					code: "200",
					msg: "200",
					data: {
						name: path.posix.basename(target),
						path: target,
						is_dir: isDir ? "1" : "0",
						size: isDir ? "0" : String(state.files.get(target)?.length ?? 0),
						modify_time: "1791187991",
						crtime: "1715493979",
						ext: "",
					},
				});
				return;
			}
			case "/v2/file/newdir": {
				const parent = form.get("parent") ?? "";
				const name = form.get("name") ?? "";
				const target = `${parent.replace(/\/+$/, "")}/${name}`;
				if (!state.dirs.has(parent)) {
					json(res, 200, { code: "N001315", msg: "文件不存在" });
					return;
				}
				if (state.dirs.has(target)) {
					json(res, 200, { code: "N001212", msg: "已存在" });
					return;
				}
				state.dirs.add(target);
				json(res, 200, { code: "200", msg: "200", data: { name, path: target, is_dir: "1", size: "0" } });
				return;
			}
			case "/v2/file/modify": {
				const target = form.get("path") ?? "";
				const newName = form.get("newname") ?? "";
				const parent = target.slice(0, target.lastIndexOf("/"));
				const renamed = `${parent}/${newName}`;
				if (state.files.has(target)) {
					state.files.set(renamed, state.files.get(target));
					state.files.delete(target);
				} else if (state.dirs.has(target)) {
					state.dirs.delete(target);
					state.dirs.add(renamed);
				}
				json(res, 200, { code: "200", msg: "200", data: { name: newName, path: renamed, is_dir: "0", size: "0" } });
				return;
			}
			case "/v2/file/move":
			case "/v2/file/copy": {
				const to = (form.get("to") ?? "").replace(/\/+$/, "");
				for (const source of form.getAll("paths[]")) {
					const base = source.slice(source.lastIndexOf("/") + 1);
					const destination = `${to}/${base}`;
					if (url.pathname.endsWith("/copy")) {
						if (state.files.has(source)) state.files.set(destination, state.files.get(source));
						else state.dirs.add(destination);
					} else if (state.files.has(source)) {
						state.files.set(destination, state.files.get(source));
						state.files.delete(source);
					} else {
						state.dirs.delete(source);
						state.dirs.add(destination);
					}
				}
				json(res, 200, { code: "200", msg: "200", data: {} });
				return;
			}
			case "/v2/file/remove": {
				for (const target of form.getAll("paths[]")) {
					state.files.delete(target);
					state.dirs.delete(target);
				}
				json(res, 200, { code: "200", msg: "200", data: {} });
				return;
			}
			case "/file_search/file_search": {
				const keyword = form.get("keyword") ?? "";
				const rows = [...children("/sata1/my/data"), ...children("/sata1/public")].filter(row => String(row.name).includes(keyword));
				json(res, 200, { code: "200", msg: "200", data: { list: rows } });
				return;
			}
			default:
				json(res, 200, { code: "N001411", msg: "无权限进行此操作" });
		}
	});

	await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
	const address = /** @type {import("node:net").AddressInfo} */ (server.address());
	const handle = {
		baseUrl: `http://127.0.0.1:${address.port}`,
		state,
		// The global HTTP agent keeps sockets alive, so a plain close() would wait
		// forever for connections that nobody is going to end.
		close: () =>
			new Promise(resolve => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
	// Tracked so a failing assertion can never leave a listening server behind
	// (which would keep the test process alive forever).
	mockProxies.push(handle);
	return handle;
}

const credentials = { token: "tok", nasId: "ZTEST", deviceId: "dev", device: "mac", appVersion: "1.0", username: "tester" };

/** @type {string[]} */
const temporaryDirs = [];

/** Every mock proxy ever started, so teardown is watertight. @type {Array<{close: () => Promise<void>}>} */
const mockProxies = [];

after(async () => {
	for (const proxy of mockProxies) await proxy.close().catch(() => {});
	for (const dir of temporaryDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Create a temp directory cleaned up after the suite.
 *
 * @param {string} label - prefix.
 * @returns {string} directory path.
 */
function tempDir(label) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dsh-zspace-${label}-`));
	temporaryDirs.push(dir);
	return dir;
}

test("check() reports a live proxy and a dead port", async () => {
	const proxy = await startMockProxy();
	const client = new ZSpaceClient({ baseUrl: proxy.baseUrl, credentials });
	assert.equal(await client.check(), true);
	await proxy.close();
	assert.equal(await client.check(), false);
});

test("missing common params in the body would be rejected — the client always sends them", async () => {
	const proxy = await startMockProxy();
	const client = new ZSpaceClient({ baseUrl: proxy.baseUrl, credentials });
	proxy.state.dirs.add("/sata1/my/data/sub");
	const { entries } = await client.list("/sata1/my/data");
	assert.deepEqual(entries.map(entry => entry.name), ["sub"]);
	assert.equal(proxy.state.authInQuery, false, "auth must ride in the body, never the query string");
	await proxy.close();
});

test("list() pages through long directories", async () => {
	const proxy = await startMockProxy();
	const client = new ZSpaceClient({ baseUrl: proxy.baseUrl, credentials });
	for (let index = 0; index < 120; index += 1) {
		proxy.state.files.set(`/sata1/my/data/file-${String(index).padStart(3, "0")}.bin`, Buffer.from("x"));
	}
	const { entries, truncated } = await client.list("/sata1/my/data");
	assert.equal(entries.length, 120);
	assert.equal(truncated, false);
	assert.equal(proxy.state.listCalls, 3, "50 + 50 + 20 rows = three pages");
	await proxy.close();
});

test("list() truncates at maxEntries", async () => {
	const proxy = await startMockProxy();
	const client = new ZSpaceClient({ baseUrl: proxy.baseUrl, credentials, listMaxEntries: 60 });
	for (let index = 0; index < 120; index += 1) {
		proxy.state.files.set(`/sata1/my/data/file-${String(index).padStart(3, "0")}.bin`, Buffer.from("x"));
	}
	const { entries, truncated } = await client.list("/sata1/my/data");
	assert.equal(entries.length, 60);
	assert.equal(truncated, true);
	await proxy.close();
});

test("homePath()/publicPath() discover the pool layout", async () => {
	const proxy = await startMockProxy();
	const client = new ZSpaceClient({ baseUrl: proxy.baseUrl, credentials });
	assert.equal(await client.homePath(), "/sata1/my/data");
	assert.equal(await client.publicPath(), "/sata1/public");
	await proxy.close();
});

test("upload() sends Chinese names through the percent-encoded create header", async () => {
	const proxy = await startMockProxy();
	const client = new ZSpaceClient({ baseUrl: proxy.baseUrl, credentials });
	const dir = tempDir("create");
	const local = path.join(dir, "测试 报告.txt");
	fs.writeFileSync(local, "hello 极空间\n");
	const result = await client.upload(local, "/sata1/my/data");
	assert.equal(result.method, "create");
	assert.equal(result.remotePath, "/sata1/my/data/测试 报告.txt");
	assert.equal(proxy.state.files.get(result.remotePath)?.toString("utf8"), "hello 极空间\n");
	await proxy.close();
});

test("upload() falls back to sliced slices when the proxy answers 413", async () => {
	const proxy = await startMockProxy({ createLimitBytes: 4 });
	const client = new ZSpaceClient({ baseUrl: proxy.baseUrl, credentials, sliceSize: 3 });
	const dir = tempDir("sliced");
	const local = path.join(dir, "big.bin");
	const payload = crypto.randomBytes(10);
	fs.writeFileSync(local, payload);
	const result = await client.upload(local, "/sata1/my/data");
	assert.equal(result.method, "sliced");
	assert.equal(proxy.state.uploadSlices.length, 4, "3 + 3 + 3 + 1 byte slices");
	assert.deepEqual(proxy.state.uploadSlices.map(slice => slice.seek), [0, 3, 6, 9]);
	const stored = proxy.state.files.get(result.remotePath);
	assert.ok(stored && stored.equals(payload), "sliced bytes must reassemble exactly");
	assert.equal(crypto.createHash("md5").update(stored).digest("hex"), crypto.createHash("md5").update(payload).digest("hex"));
	await proxy.close();
});

test("upload() picks the sliced path for files above smallUploadMaxBytes", async () => {
	const proxy = await startMockProxy();
	const client = new ZSpaceClient({ baseUrl: proxy.baseUrl, credentials, smallUploadMaxBytes: 8, sliceSize: 5 });
	const dir = tempDir("threshold");
	const local = path.join(dir, "medium.bin");
	fs.writeFileSync(local, Buffer.alloc(12, 7));
	const result = await client.upload(local, "/sata1/my/data");
	assert.equal(result.method, "sliced");
	assert.equal(proxy.state.uploadSlices.length, 3);
	await proxy.close();
});

test("download() streams bytes and readFile() truncates", async () => {
	const proxy = await startMockProxy();
	const client = new ZSpaceClient({ baseUrl: proxy.baseUrl, credentials });
	const remote = "/sata1/my/data/note.txt";
	proxy.state.files.set(remote, Buffer.from("0123456789"));
	const dir = tempDir("download");
	const { localPath, bytes } = await client.download(remote, dir);
	assert.equal(bytes, 10);
	assert.equal(fs.readFileSync(localPath, "utf8"), "0123456789");

	const head = await client.readFile(remote, { maxBytes: 4 });
	assert.equal(head.buffer.toString("utf8"), "0123");
	assert.equal(head.truncated, true);
	await proxy.close();
});

test("create/modify/move/copy/remove round-trip", async () => {
	const proxy = await startMockProxy();
	const client = new ZSpaceClient({ baseUrl: proxy.baseUrl, credentials });
	await client.mkdir("/sata1/my/data/相册");
	assert.ok(proxy.state.dirs.has("/sata1/my/data/相册"));

	const dir = tempDir("ops");
	const local = path.join(dir, "a.txt");
	fs.writeFileSync(local, "a");
	await client.upload(local, "/sata1/my/data/相册");
	await client.rename("/sata1/my/data/相册/a.txt", "b.txt");
	assert.ok(proxy.state.files.has("/sata1/my/data/相册/b.txt"));

	await client.copy(["/sata1/my/data/相册/b.txt"], "/sata1/my/data");
	assert.ok(proxy.state.files.has("/sata1/my/data/b.txt"));
	await client.move(["/sata1/my/data/b.txt"], "/sata1/my/data/相册");
	assert.ok(proxy.state.files.has("/sata1/my/data/相册/b.txt"));

	await client.remove(["/sata1/my/data/相册/b.txt"]);
	assert.equal(proxy.state.files.has("/sata1/my/data/相册/b.txt"), false);
	await proxy.close();
});

test("business errors surface as ZSpaceError with a hint", async () => {
	const proxy = await startMockProxy();
	const client = new ZSpaceClient({ baseUrl: proxy.baseUrl, credentials });
	await assert.rejects(
		() => client.list("/nope"),
		error => {
			assert.ok(error instanceof ZSpaceError);
			assert.equal(error.code, "N001315");
			assert.match(error.hint ?? "", /路径不存在/);
			return true;
		},
	);
	await assert.rejects(
		() => client.info("/"),
		error => {
			assert.equal(error.code, "N001411");
			assert.match(error.hint ?? "", /没有权限/);
			return true;
		},
	);
	await proxy.close();
});

test("transient 5xx answers are retried", async () => {
	const proxy = await startMockProxy({ failFirstAttempts: 1 });
	const client = new ZSpaceClient({ baseUrl: proxy.baseUrl, credentials, retryDelayMs: 5 });
	const { entries } = await client.list("/sata1/my/data");
	assert.deepEqual(entries, []);
	await proxy.close();
});

test("a dead proxy reports EPROXY without retrying forever", async () => {
	const client = new ZSpaceClient({ baseUrl: "http://127.0.0.1:1", credentials, retryDelayMs: 5 });
	await assert.rejects(
		() => client.list("/sata1/my/data"),
		error => {
			assert.equal(error.code, "EPROXY");
			assert.match(error.hint ?? "", /桌面客户端/);
			return true;
		},
	);
});
