/**
 * WebDAV transport + transport routing.
 *
 * Both servers here are real: a mock WebDAV endpoint (`http://127.0.0.1:<port>/`
 * speaking PROPFIND/MKCOL/PUT/GET/MOVE/COPY/DELETE with Basic auth) and a stub
 * of the desktop client's relay. That keeps the router honest — the fallback
 * path is exercised over actual sockets, not mocks of `fetch`.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { ZSpaceClient } from "../lib/client.js";
import { fromDavPath, parseMultiStatus, probe, toDavPath } from "../lib/client/webdav.js";
import { isTransportFailure, selectTransport } from "../lib/client/router.js";

const HOME = "/sata1/my/data";
const PUBLIC = "/sata1/public";
const PUBLIC_DAV = "/公共空间";
const USER = "nasuser";
const PASSWORD = "naspass";

const temporaryDirs = [];
const servers = [];

/**
 * Minimal but faithful WebDAV endpoint backed by an in-memory tree.
 *
 * @returns {Promise<object>} server handle.
 */
async function startDavServer() {
	/** @type {Map<string, {dir: boolean, body: Buffer}>} */
	const tree = new Map([
		["/", { dir: true, body: Buffer.alloc(0) }],
		["/note.txt", { dir: false, body: Buffer.from("hello dav\n", "utf8") }],
		["/相册", { dir: true, body: Buffer.alloc(0) }],
		["/相册/a.jpg", { dir: false, body: Buffer.from("JPGDATA", "utf8") }],
		["/公共空间", { dir: true, body: Buffer.alloc(0) }],
		["/公共空间/shared.txt", { dir: false, body: Buffer.from("public", "utf8") }],
	]);
	let fail = false;
	let failData = false;
	const log = [];

	const childrenOf = davPath =>
		[...tree.entries()]
			.filter(([candidate]) => {
				if (candidate === davPath) return false;
				if (davPath === "/") return !candidate.slice(1).includes("/");
				return candidate.startsWith(`${davPath}/`) && !candidate.slice(davPath.length + 1).includes("/");
			})
			.map(([candidate, node]) => ({ href: candidate, dir: node.dir, size: node.dir ? 0 : node.body.length }));

	const render = node =>
		`<D:response><D:href>${encodeURI(node.href)}</D:href><D:propstat><D:prop>` +
		`<D:resourcetype>${node.dir ? "<D:collection/>" : ""}</D:resourcetype>` +
		`<D:getcontentlength>${node.size}</D:getcontentlength>` +
		`<D:getlastmodified>Mon, 06 Oct 2026 10:00:00 GMT</D:getlastmodified>` +
		`</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;

	const xmlFor = (davPath, depth) => {
		const node = tree.get(davPath);
		const nodes = [{ href: davPath, dir: node.dir, size: node.dir ? 0 : node.body.length }];
		if (depth === "1") nodes.push(...childrenOf(davPath));
		return `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${nodes.map(render).join("")}</D:multistatus>`;
	};

	const server = http.createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const davPath = decodeURIComponent(url.pathname);
		log.push(`${req.method} ${davPath}`);
		const isProbe = req.method === "PROPFIND" && String(req.headers.depth ?? "0") === "0";
		if (fail || (failData && !isProbe)) {
			res.writeHead(503, { "Content-Type": "text/plain" }).end("temporarily down");
			return;
		}
		const expected = `Basic ${Buffer.from(`${USER}:${PASSWORD}`, "utf8").toString("base64")}`;
		if (req.headers.authorization !== expected) {
			res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Restricted"', "Content-Type": "text/plain" }).end("please auth");
			return;
		}
		const node = tree.get(davPath);
		if (req.method === "PROPFIND") {
			if (!node) {
				res.writeHead(404).end("missing");
				return;
			}
			res.writeHead(207, { "Content-Type": "application/xml" }).end(xmlFor(davPath, String(req.headers.depth ?? "0")));
			return;
		}
		if (req.method === "MKCOL") {
			if (node) {
				res.writeHead(405).end("exists");
				return;
			}
			tree.set(davPath, { dir: true, body: Buffer.alloc(0) });
			res.writeHead(201).end();
			return;
		}
		if (req.method === "PUT") {
			const chunks = [];
			for await (const chunk of req) chunks.push(chunk);
			tree.set(davPath, { dir: false, body: Buffer.concat(chunks) });
			res.writeHead(201).end();
			return;
		}
		if (req.method === "GET") {
			if (!node || node.dir) {
				res.writeHead(404).end("missing");
				return;
			}
			const range = /bytes=(\d+)-(\d+)?/.exec(String(req.headers.range ?? ""));
			if (range) {
				const start = Number(range[1]);
				const end = range[2] ? Number(range[2]) : node.body.length - 1;
				const slice = node.body.subarray(start, end + 1);
				res.writeHead(206, { "Content-Range": `bytes ${start}-${start + slice.length - 1}/${node.body.length}`, "Content-Length": String(slice.length) }).end(slice);
				return;
			}
			res.writeHead(200, { "Content-Length": String(node.body.length) }).end(node.body);
			return;
		}
		if (req.method === "MOVE" || req.method === "COPY") {
			const destination = decodeURIComponent(new URL(String(req.headers.destination), "http://127.0.0.1").pathname);
			if (!node) {
				res.writeHead(404).end("missing");
				return;
			}
			if (tree.has(destination)) {
				res.writeHead(412).end("exists");
				return;
			}
			tree.set(destination, { dir: node.dir, body: node.body });
			if (node.dir) {
				for (const [candidate, child] of [...tree.entries()]) {
					if (candidate.startsWith(`${davPath}/`)) tree.set(destination + candidate.slice(davPath.length), { dir: child.dir, body: child.body });
				}
			}
			if (req.method === "MOVE") tree.delete(davPath);
			res.writeHead(201).end();
			return;
		}
		if (req.method === "DELETE") {
			if (!node) {
				res.writeHead(404).end("missing");
				return;
			}
			tree.delete(davPath);
			for (const candidate of [...tree.keys()]) if (candidate.startsWith(`${davPath}/`)) tree.delete(candidate);
			res.writeHead(204).end();
			return;
		}
		res.writeHead(405).end("unsupported");
	});
	await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
	const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
	const handle = {
		baseUrl: `http://127.0.0.1:${port}/`,
		log,
		tree,
		setFail: value => {
			fail = value;
		},
		setFailData: value => {
			failData = value;
		},
		close: async () => {
			server.closeAllConnections?.();
			await new Promise(resolve => server.close(resolve));
		},
	};
	servers.push(handle);
	return handle;
}

/**
 * Stub of the desktop client relay: just enough for `check()` and `list()`.
 *
 * @returns {Promise<{baseUrl: string, log: string[], close: () => Promise<void>}>} relay handle.
 */
async function startRelayStub() {
	const log = [];
	const server = http.createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const chunks = [];
		for await (const chunk of req) chunks.push(chunk);
		const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
		log.push(`relay ${url.pathname}`);
		if (url.pathname === "/home/") {
			res.writeHead(200, { "Content-Type": "text/html" }).end("zspace");
			return;
		}
		const send = body => {
			const text = JSON.stringify(body);
			res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) }).end(text);
		};
		if (!form.has("token")) {
			send({ code: "N001212", msg: "参数有误" });
			return;
		}
		if (url.pathname === "/v2/file/list") {
			send({ code: "200", msg: "200", data: { list: [{ name: "relay-only.txt", path: `${form.get("path")}/relay-only.txt`, is_dir: "0", size: "5", modify_time: "" }] } });
			return;
		}
		send({ code: "N001411", msg: "无权限进行此操作" });
	});
	await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
	const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
	const handle = {
		baseUrl: `http://127.0.0.1:${port}`,
		log,
		close: async () => {
			server.closeAllConnections?.();
			await new Promise(resolve => server.close(resolve));
		},
	};
	servers.push(handle);
	return handle;
}

/**
 * Client wired to both servers with WebDAV credentials in the environment.
 *
 * @param {object} options - overrides.
 * @returns {Promise<{client: ZSpaceClient, dav: object, relay: object, restore: () => void}>} fixture.
 */
async function fixture(options = {}) {
	const dav = await startDavServer();
	const relay = await startRelayStub();
	const previous = { user: process.env.ZS_WEBDAV_USER, password: process.env.ZS_WEBDAV_PASSWORD };
	process.env.ZS_WEBDAV_USER = USER;
	process.env.ZS_WEBDAV_PASSWORD = PASSWORD;
	const client = new ZSpaceClient({
		baseUrl: relay.baseUrl,
		credentials: { token: "t", nasId: "n", deviceId: "d", username: "u", device: "mac", appVersion: "1" },
		homePath: HOME,
		publicPath: PUBLIC,
		webdavUrl: dav.baseUrl,
		webdavHomePath: "/",
		webdavPublicPath: PUBLIC_DAV,
		transportMode: "auto",
		timeoutMs: 5000,
		...options,
	});
	return {
		client,
		dav,
		relay,
		restore: () => {
			if (previous.user === undefined) delete process.env.ZS_WEBDAV_USER;
			else process.env.ZS_WEBDAV_USER = previous.user;
			if (previous.password === undefined) delete process.env.ZS_WEBDAV_PASSWORD;
			else process.env.ZS_WEBDAV_PASSWORD = previous.password;
		},
	};
}

after(async () => {
	for (const handle of servers) await handle.close().catch(() => {});
	for (const dir of temporaryDirs) fs.rmSync(dir, { recursive: true, force: true });
});

test("parseMultiStatus reads D: and lp1: prefixed multistatus bodies", () => {
	const xml = `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">
		<D:response><D:href>/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response>
		<D:response><D:href>/${encodeURIComponent("相册")}/</D:href><D:propstat><D:prop><D:resourcetype><lp1:collection xmlns:lp1="DAV:"/></D:resourcetype></D:prop></D:propstat></D:response>
		<D:response><D:href>/note.txt</D:href><D:propstat><D:prop><D:resourcetype/><D:getcontentlength>11</D:getcontentlength><D:getlastmodified>Mon, 06 Oct 2026 10:00:00 GMT</D:getlastmodified></D:prop></D:propstat></D:response>
	</D:multistatus>`;
	const entries = parseMultiStatus(xml);
	assert.equal(entries.length, 3);
	assert.deepEqual(entries.map(entry => [entry.name, entry.dir, entry.size]), [["/", true, 0], ["相册", true, 0], ["note.txt", false, 11]]);
	assert.equal(entries[2].modified, String(Math.floor(Date.parse("Mon, 06 Oct 2026 10:00:00 GMT") / 1000)));
});

test("NAS paths map onto the WebDAV layout in both directions", async () => {
	const { client, restore } = await fixture();
	try {
		assert.equal(await toDavPath(client, `${HOME}/相册/a.jpg`), "/相册/a.jpg");
		assert.equal(await toDavPath(client, HOME), "/");
		assert.equal(await toDavPath(client, `${PUBLIC}/shared.txt`), `${PUBLIC_DAV}/shared.txt`);
		assert.equal(await fromDavPath(client, "/相册/a.jpg"), `${HOME}/相册/a.jpg`);
		assert.equal(await fromDavPath(client, `${PUBLIC_DAV}/shared.txt`), `${PUBLIC}/shared.txt`);
		await assert.rejects(() => toDavPath(client, "/sata9/other/x"), /无法映射该路径/);
	} finally {
		restore();
	}
});

test("WebDAV transport serves every capability over the LAN", async () => {
	const { client, dav, restore } = await fixture();
	const localDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-zspace-dav-"));
	temporaryDirs.push(localDir);
	try {
		assert.equal((await probe(client)).usable, true, "probe must accept our mock endpoint");
		assert.equal(await client.check(), true);
		assert.equal((await client.transportReport()).transport, "webdav");

		// list
		const listing = await client.list(HOME);
		assert.deepEqual([...listing.entries.map(entry => entry.name)].sort(), ["note.txt", "公共空间", "相册"]);
		assert.equal(listing.entries[0].dir, true, "directories sort before files");
		assert.equal(listing.entries.find(entry => entry.name === "相册").path, `${HOME}/相册`);

		// info
		const info = await client.info(`${HOME}/note.txt`);
		assert.deepEqual([info.name, info.dir, info.size], ["note.txt", false, 10]);
		assert.equal((await client.info(`${HOME}/相册`)).dir, true);
		assert.equal(await client.isDirectory(`${HOME}/相册`), true);
		assert.equal(await client.isDirectory(`${HOME}/note.txt`), false);

		// mkdir / upload / readFile / download
		await client.mkdir(`${HOME}/新建目录`);
		assert.equal(dav.tree.has("/新建目录"), true);
		await assert.rejects(() => client.mkdir(`${HOME}/新建目录`), /已存在/);

		const local = path.join(localDir, "上传-中文.txt");
		fs.writeFileSync(local, "上传内容\n");
		const uploaded = await client.upload(local, `${HOME}/新建目录`);
		assert.deepEqual([uploaded.remotePath, uploaded.bytes, uploaded.method], [`${HOME}/新建目录/上传-中文.txt`, Buffer.byteLength("上传内容\n"), "put"]);

		const head = await client.readFile(`${HOME}/新建目录/上传-中文.txt`, { maxBytes: 6 });
		assert.equal(head.buffer.toString("utf8"), Buffer.from("上传内容\n", "utf8").subarray(0, 6).toString("utf8"));
		assert.equal(head.bytes, 6);
		assert.equal(head.truncated, true, "a 6-byte range over a longer file must report truncation");

		const downloaded = await client.download(`${HOME}/note.txt`, localDir);
		assert.equal(fs.readFileSync(downloaded.localPath, "utf8"), "hello dav\n");

		// rename / copy / move / remove
		await client.rename(`${HOME}/note.txt`, "改名.txt");
		assert.equal(dav.tree.has("/改名.txt"), true);
		assert.equal(dav.tree.has("/note.txt"), false);

		await client.copy([`${HOME}/改名.txt`], `${HOME}/新建目录`);
		assert.equal(dav.tree.has("/新建目录/改名.txt"), true);

		// 移动到公共空间（HOME 里已有同名文件，正好也验证 MOVE 的冲突语义）
		await client.move([`${HOME}/新建目录/改名.txt`], PUBLIC);
		assert.equal(dav.tree.has("/新建目录/改名.txt"), false);
		assert.equal(dav.tree.has(`${PUBLIC_DAV}/改名.txt`), true);

		await client.remove([`${HOME}/新建目录`]);
		assert.equal(dav.tree.has("/新建目录"), false);
		assert.equal(dav.tree.has("/新建目录/上传-中文.txt"), false, "recursive delete must clear children");

		// public space goes through the configured DAV path too
		assert.equal((await client.info(`${PUBLIC}/shared.txt`)).name, "shared.txt");
	} finally {
		restore();
	}
});

test("the fast path can be enabled by environment variables alone", async () => {
	const dav = await startDavServer();
	const previous = { url: process.env.ZS_WEBDAV_URL, user: process.env.ZS_WEBDAV_USER, password: process.env.ZS_WEBDAV_PASSWORD };
	process.env.ZS_WEBDAV_URL = dav.baseUrl;
	process.env.ZS_WEBDAV_USER = USER;
	process.env.ZS_WEBDAV_PASSWORD = PASSWORD;
	try {
		const client = new ZSpaceClient({ homePath: HOME, publicPath: PUBLIC }); // 没有任何 webdav* 配置项
		const report = await client.transportReport();
		assert.equal(report.configured, true, "env-only configuration must count as configured");
		assert.equal(report.transport, "webdav");
		assert.equal((await client.list(HOME)).entries.some(entry => entry.name === "note.txt"), true);
	} finally {
		for (const [key, value] of Object.entries(previous)) {
			const name = { url: "ZS_WEBDAV_URL", user: "ZS_WEBDAV_USER", password: "ZS_WEBDAV_PASSWORD" }[key];
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
});

test("probe reports unreachable, rejected credentials and configured state", async () => {
	const { client, dav, restore } = await fixture();
	try {
		dav.setFail(true);
		const down = await probe(client);
		assert.deepEqual([down.reachable, down.usable], [true, false]);
		assert.match(down.reason, /服务端错误/);

		dav.setFail(false);
		process.env.ZS_WEBDAV_PASSWORD = "wrong";
		const rejected = await probe(client);
		assert.deepEqual([rejected.reachable, rejected.usable, rejected.status], [true, false, 401]);

		delete process.env.ZS_WEBDAV_PASSWORD;
		assert.match((await probe(client)).reason, /ZS_WEBDAV_PASSWORD/);

		process.env.ZS_WEBDAV_PASSWORD = PASSWORD;
		const offline = new ZSpaceClient({ webdavUrl: "http://127.0.0.1:9/", webdavProbeTimeoutMs: 500 });
		const unreachable = await probe(offline);
		assert.equal(unreachable.usable, false);
		assert.match(unreachable.reason, /不可达|超时/);
	} finally {
		restore();
	}
});

test("auto routing prefers WebDAV, honours explicit modes, and falls back at runtime", async () => {
	const { client, dav, relay, restore } = await fixture();
	try {
		// auto + reachable -> WebDAV
		const first = await client.list(HOME);
		assert.equal(await selectTransport(client), "webdav");
		assert.ok(first.entries.some(entry => entry.name === "note.txt"), "WebDAV listing must be served");
		assert.ok(dav.log.some(line => line.startsWith("PROPFIND")), "WebDAV must have served the listing");
		assert.equal(relay.log.length, 0, "no relay traffic while the LAN path is healthy");

		// runtime failure (probe still healthy, the data call breaks) -> mark down + retry on the relay
		dav.setFailData(true);
		const fallback = await client.list(HOME);
		assert.equal(fallback.entries[0].name, "relay-only.txt", "the failing call must be retried on the relay");
		assert.ok(relay.log.some(line => line.includes("/v2/file/list")), "relay must have served the retry");
		assert.ok(client._webdavDownUntil > Date.now(), "WebDAV must be marked down for the cooldown");
		assert.equal(await selectTransport(client), "relay");

		// explicit relay mode never probes WebDAV
		client.transportMode = "relay";
		const forced = await fixture({ transportMode: "relay" });
		try {
			assert.equal(await selectTransport(forced.client), "relay");
			client.transportMode = "auto";
			assert.equal(forced.dav.log.length, 0, "relay mode must not touch WebDAV");
		} finally {
			forced.restore();
		}
	} finally {
		restore();
	}
});

test("forced WebDAV mode surfaces transport failures instead of falling back", async () => {
	const { client, dav, restore } = await fixture({ transportMode: "webdav" });
	try {
		assert.equal(await selectTransport(client), "webdav");
		dav.setFail(true);
		await assert.rejects(() => client.list(HOME), /HTTP 503/);
		assert.equal(client._webdavDownUntil, 0, "forced mode must not silently reroute");
	} finally {
		restore();
	}
});

test("transport failures are told apart from business errors", () => {
	assert.equal(isTransportFailure(Object.assign(new Error("x"), { code: "ETIMEDOUT" })), true);
	assert.equal(isTransportFailure(Object.assign(new Error("x"), { code: "HTTP503" })), true);
	assert.equal(isTransportFailure(new TypeError("fetch failed")), true);
	assert.equal(isTransportFailure(Object.assign(new Error("x"), { code: "HTTP404" })), false);
	assert.equal(isTransportFailure(Object.assign(new Error("x"), { code: "N001315" })), false);
});
