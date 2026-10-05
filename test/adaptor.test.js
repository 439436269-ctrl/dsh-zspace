/**
 * Host-adapter smoke test.
 *
 * `lib/index.js` is the only file that imports host packages, so it cannot run
 * under plain Node in this repository. This test copies the plugin into a temp
 * tree, writes minimal `@deepseek-ai/dsh-tools` / `schemastery` stubs there,
 * then mounts the plugin with a fake cordis context and drives one tool end to
 * end through a mock desktop-client proxy — proving the wiring (config →
 * `apply` → `ctx.tools.register` → `execute` → HTTP) that the unit tests skip.
 *
 * Run with: node --test test/
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";

const projectRoot = path.resolve(import.meta.dirname, "..");

/** Temp trees removed when the suite ends. @type {string[]} */
const temporaryDirs = [];
/** Every proxy started here, so a failing assertion cannot leave the process alive. @type {Array<{close: () => Promise<void>}>} */
const proxies = [];
after(async () => {
	for (const proxy of proxies) await proxy.close().catch(() => {});
	for (const dir of temporaryDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Write a stub package into a temp tree's node_modules.
 *
 * @param {string} root - temp tree root.
 * @param {string} name - package name (may be scoped).
 * @param {string} source - module source.
 * @returns {void}
 */
function writeStubPackage(root, name, source) {
	const dir = path.join(root, "node_modules", ...name.split("/"));
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version: "0.0.0-stub", type: "module", main: "index.js", exports: { ".": "./index.js" } }));
	fs.writeFileSync(path.join(dir, "index.js"), source);
}

/**
 * Build a temp copy of the plugin plus host stubs.
 *
 * @returns {string} the copy's root directory.
 */
function stagePlugin() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-zspace-adapter-"));
	temporaryDirs.push(root);
	fs.cpSync(path.join(projectRoot, "lib"), path.join(root, "lib"), { recursive: true });
	fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "dsh-zspace", version: "0.1.0", type: "module", main: "lib/index.js" }));
	writeStubPackage(root, "@deepseek-ai/dsh-tools", "export function defineTool(definition) { return definition; }\n");
	writeStubPackage(
		root,
		"@deepseek-ai/schemastery",
		[
			"const chain = () => new Proxy(function () {}, {",
			"  get: (_target, property) => (property === 'then' ? undefined : chain()),",
			"  apply: () => chain(),",
			"});",
			"export default new Proxy({}, { get: () => () => chain() });",
			"",
		].join("\n"),
	);
	return root;
}

/**
 * Start a minimal proxy serving just what `zspace_status` needs.
 *
 * @returns {Promise<{baseUrl: string, close: () => Promise<void>}>} proxy handle.
 */
async function startStatusProxy() {
	const server = http.createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const chunks = [];
		for await (const chunk of req) chunks.push(chunk);
		const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
		const send = body => {
			const text = JSON.stringify(body);
			res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
			res.end(text);
		};
		if (url.pathname === "/home/") {
			res.writeHead(200, { "Content-Type": "text/html" }).end("zspace");
			return;
		}
		if (!form.has("token")) {
			send({ code: "N001212", msg: "参数有误" });
			return;
		}
		if (url.pathname === "/zspool/info") {
			send({ code: "200", msg: "success", data: { pool_list: [{ name: "sata1", status: "ok", total_size: 1000, free_size: 400 }] } });
			return;
		}
		if (url.pathname === "/v2/file/list") {
			send({ code: "200", msg: "200", data: { list: [{ name: "note.txt", path: `${form.get("path")}/note.txt`, is_dir: "0", size: "5" }] } });
			return;
		}
		send({ code: "N001411", msg: "无权限进行此操作" });
	});
	await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
	const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
	const handle = {
		baseUrl: `http://127.0.0.1:${port}`,
		close: () =>
			new Promise(resolve => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
	proxies.push(handle);
	return handle;
}

/**
 * Write a fake desktop-client `vuex.json`.
 *
 * @param {string} dir - directory to place it in.
 * @returns {string} config directory.
 */
function writeFakeVuex(dir) {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, "vuex.json"),
		JSON.stringify({
			state: {
				user: { token: "fake-token", username: "adapter-tester" },
				nas: { nasId: "ZADAPTER" },
				app: { deviceId: "device-1", device: "mac", version: "1.0" },
			},
		}),
	);
	return dir;
}

test("the adapter mounts 12 tools, one guide section, and a working status tool", async () => {
	const root = stagePlugin();
	const proxy = await startStatusProxy();
	const configDir = writeFakeVuex(path.join(root, "zspace-config"));

	const module = await import(pathToFileURL(path.join(root, "lib/index.js")).href);
	assert.equal(module.name, "zspace");
	assert.deepEqual(module.inject, ["tools", "systemPrompt"]);
	assert.ok(module.Config, "the plugin must export a config schema");

	/** @type {Array<Record<string, any>>} */
	const registered = [];
	/** @type {Array<Record<string, any>>} */
	const sections = [];
	/** @type {(() => void)|undefined} */
	let disposer;
	const ctx = {
		tools: { register: tool => registered.push(tool) },
		systemPrompt: { section: section => sections.push(section) },
		effect: (factory) => {
			disposer = factory();
		},
	};

	module.apply(ctx, {
		baseUrl: proxy.baseUrl,
		configDir,
		apiVersion: "2.3.2026042401",
		homePath: "",
		publicPath: "",
		downloadDir: "",
		readMaxBytes: 262_144,
		listMaxEntries: 2000,
		timeoutMs: 5000,
		maxRetries: 0,
		smallUploadMaxBytes: 8 * 1024 * 1024,
		sliceSize: 2 * 1024 * 1024,
		promptEnabled: true,
		promptOrder: 60,
	});

	assert.equal(typeof disposer, "function", "the client must be created inside ctx.effect");
	assert.equal(registered.length, 12, `expected 12 tools, got ${registered.map(tool => tool.name).join(", ")}`);
	assert.equal(sections.length, 1);
	assert.equal(sections[0].name, "zspace:guide");
	assert.match(sections[0].text(), /极空间/);
	assert.match(sections[0].text(), /zspace_upload/);

	const status = registered.find(tool => tool.name === "zspace_status");
	assert.ok(status);
	const value = await status.execute({});
	assert.equal(value.ok, true);
	assert.equal(value.username, "adapter-tester");
	assert.equal(value.nasId, "ZADAPTER");
	assert.equal(value.homePath, "/sata1/my/data");
	assert.equal(value.publicPath, "/sata1/public");
	assert.equal(value.homeEntries, 1);
	assert.equal(value.pools[0].name, "sata1");
	assert.match(status.output.render({}, value)[0].text, /极空间在线/);

	// Unloading the plugin must drop the client, so a stale tool call fails loudly.
	disposer?.();
	await assert.rejects(() => status.execute({}), /client is not available/);

	await proxy.close();
});

test("the adapter refuses a broken config at load time", async () => {
	const root = stagePlugin();
	const module = await import(pathToFileURL(path.join(root, "lib/index.js")).href);
	const ctx = { tools: { register: () => {} }, systemPrompt: { section: () => {} }, effect: factory => factory() };
	const base = {
		baseUrl: "http://127.0.0.1:13579",
		configDir: "",
		apiVersion: "2.3.2026042401",
		homePath: "",
		publicPath: "",
		downloadDir: "",
		readMaxBytes: 262_144,
		listMaxEntries: 2000,
		timeoutMs: 5000,
		maxRetries: 0,
		smallUploadMaxBytes: 1024,
		sliceSize: 1024,
		promptEnabled: true,
		promptOrder: 60,
	};
	assert.throws(() => module.apply(ctx, { ...base, baseUrl: "13579" }), /baseUrl/);
	assert.throws(() => module.apply(ctx, { ...base, readMaxBytes: 0 }), /readMaxBytes/);
});

test("the guide section can be disabled without breaking the mount", async () => {
	const root = stagePlugin();
	const module = await import(pathToFileURL(path.join(root, "lib/index.js")).href);
	/** @type {Array<Record<string, any>>} */
	const registered = [];
	/** @type {Array<Record<string, any>>} */
	const sections = [];
	const ctx = {
		tools: { register: tool => registered.push(tool) },
		systemPrompt: { section: section => sections.push(section) },
		effect: factory => factory(),
	};
	module.apply(ctx, {
		baseUrl: "http://127.0.0.1:13579",
		configDir: "",
		apiVersion: "2.3.2026042401",
		homePath: "",
		publicPath: "",
		downloadDir: "",
		readMaxBytes: 262_144,
		listMaxEntries: 2000,
		timeoutMs: 5000,
		maxRetries: 0,
		smallUploadMaxBytes: 1024,
		sliceSize: 1024,
		promptEnabled: false,
		promptOrder: 60,
	});
	assert.equal(sections.length, 0);
	assert.equal(registered.length, 12);
});

test("a partial config falls back to code-side defaults", async () => {
	const root = stagePlugin();
	const proxy = await startStatusProxy();
	const configDir = writeFakeVuex(path.join(root, "zspace-config-2"));
	const module = await import(pathToFileURL(path.join(root, "lib/index.js")).href);
	/** @type {Array<Record<string, any>>} */
	const registered = [];
	const ctx = {
		tools: { register: tool => registered.push(tool) },
		systemPrompt: { section: () => {} },
		effect: factory => factory(),
	};
	// Only the two keys a user actually has to care about.
	module.apply(ctx, { baseUrl: proxy.baseUrl, configDir });

	const ls = registered.find(tool => tool.name === "zspace_ls");
	assert.ok(ls);
	const value = await ls.execute({ path: "note.txt", depth: 1 });
	assert.equal(value.root, "/sata1/my/data/note.txt");
	assert.equal(value.count, 1);
	await proxy.close();
});
