/**
 * WebDAV transport — the same-network fast path.
 *
 * When the machine can reach the NAS directly (typical on the same LAN), every
 * file operation can go over the NAS's built-in WebDAV service
 * (`http://<nas>:5005/`) instead of the desktop client's cloud relay: lower
 * latency, no dependency on the client being logged in, and directory listing
 * without the relay's 50-row page limit.
 *
 * The plugin's tools speak **NAS paths** (`/sata1/my/data/...`), so this module
 * translates between those and the WebDAV layout:
 *
 * ```
 * NAS  /sata1/my/data/相册/a.jpg   <->  WebDAV  <webdavHomePath>/相册/a.jpg
 * NAS  /sata1/public/img/b.png     <->  WebDAV  <webdavPublicPath>/img/b.png
 * ```
 *
 * The NAS-side roots come from config (`homePath` / `publicPath`) or, failing
 * that, a one-off relay lookup — so results look identical no matter which
 * transport served them.
 *
 * @module dsh-zspace/client/webdav
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { joinRemote, toEntry } from "../format.js";
import { ZSpaceError } from "./errors.js";

/** Environment variable carrying the WebDAV password (kept out of config files). */
export const PASSWORD_ENV = "ZS_WEBDAV_PASSWORD";

/** Environment variable carrying the WebDAV user name. */
export const USER_ENV = "ZS_WEBDAV_USER";

export const name = "webdav";

/**
 * Resolve WebDAV credentials: environment first, config as a fallback.
 *
 * @param {import("../client.js").ZSpaceClient} client - live client.
 * @returns {{user: string, password: string, complete: boolean}} credentials.
 */
export function credentials(client) {
	const user = process.env[USER_ENV] || client.webdavUser || "";
	const password = process.env[PASSWORD_ENV] || client.webdavPassword || "";
	return { user, password, complete: Boolean(user && password) };
}

/**
 * Whether this transport has everything it needs to be used at all.
 *
 * @param {import("../client.js").ZSpaceClient} client - live client.
 * @returns {boolean} true when a URL and complete credentials are configured.
 */
export function configured(client) {
	return Boolean(String(client.webdavUrl ?? "").trim()) && credentials(client).complete;
}

/**
 * Base URL without a trailing slash.
 *
 * @param {import("../client.js").ZSpaceClient} client - live client.
 * @returns {string} base URL.
 */
function baseUrl(client) {
	return String(client.webdavUrl ?? "").replace(/\/+$/, "");
}

/**
 * Percent-encode every path segment (keeps the separators).
 *
 * @param {string} remotePath - DAV path.
 * @returns {string} encoded path.
 */
function encodePath(remotePath) {
	return String(remotePath)
		.split("/")
		.map(segment => encodeURIComponent(segment))
		.join("/");
}

/**
 * Join two DAV paths with single slashes.
 *
 * @param {string} base - base path.
 * @param {string} rest - remainder.
 * @returns {string} joined path, always starting with `/`.
 */
function joinDav(base, rest) {
	const left = `/${String(base).replace(/^\/+|\/+$/g, "")}`;
	const right = String(rest).replace(/^\/+/, "");
	const joined = right === "" ? left : `${left === "/" ? "" : left}/${right}`;
	return joined.startsWith("/") ? joined : `/${joined}`;
}

/**
 * One HTTP request against the WebDAV endpoint.
 *
 * @param {import("../client.js").ZSpaceClient} client - live client.
 * @param {object} options - request options.
 * @param {string} options.method - HTTP method (PROPFIND/MKCOL/MOVE/... allowed).
 * @param {string} options.davPath - DAV path (already NAS-relative, not encoded).
 * @param {Record<string, string>} [options.headers] - extra headers.
 * @param {BodyInit|null} [options.body] - request body.
 * @param {number} [options.timeoutMs] - per-request timeout.
 * @returns {Promise<Response>} fetch response.
 */
async function request(client, { method, davPath, headers = {}, body = null, timeoutMs }) {
	const { user, password } = credentials(client);
	const authorization = `Basic ${Buffer.from(`${user}:${password}`, "utf8").toString("base64")}`;
	const init = {
		method,
		headers: { Authorization: authorization, ...headers },
		signal: AbortSignal.timeout(timeoutMs ?? client.timeoutMs ?? 60_000),
	};
	if (body !== null) {
		init.body = body;
		init.duplex = "half";
	}
	try {
		return await fetch(`${baseUrl(client)}${encodePath(davPath) || "/"}`, init);
	} catch (error) {
		const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
		throw new ZSpaceError(
			timedOut ? "ETIMEDOUT" : "EDAV",
			timedOut ? `WebDAV 请求超时：${method} ${davPath}` : `WebDAV 请求失败（${method} ${davPath}）：${error?.message ?? error}`,
			{ endpoint: davPath, cause: error },
		);
	}
}

/**
 * Turn a non-2xx response into a ZSpaceError with an actionable message.
 *
 * @param {Response} response - fetch response.
 * @param {string} action - what was attempted (for the message).
 * @returns {Promise<void>} resolves for success statuses.
 * @throws {ZSpaceError} for failures.
 */
async function assertOk(response, action) {
	if (response.ok || response.status === 207) return;
	const status = response.status;
	const hints = {
		401: "WebDAV 凭据被拒：检查 webdavUser 与 ZS_WEBDAV_PASSWORD（极空间用 NAS 账号密码，不是桌面客户端 token）",
		403: "WebDAV 无权限：确认该账号对该目录可读写",
		404: "路径不存在：先 zspace_ls 上级目录确认拼写",
		405: "目标已存在或方法不被支持",
		409: "父目录不存在或状态冲突：先建父目录",
		507: "NAS 空间不足",
	};
	throw new ZSpaceError(`HTTP${status}`, `${action} 失败：HTTP ${status}${hints[status] ? ` — ${hints[status]}` : ""}`, { endpoint: action });
}

/**
 * Local name of a DAV href, decoded and stripped down to a DAV path.
 *
 * @param {string} href - raw href from a PROPFIND response.
 * @returns {string} decoded DAV path.
 */
function hrefToDavPath(href) {
	let value = String(href ?? "");
	try {
		value = new URL(value, "http://placeholder").pathname;
	} catch {
		/* keep raw value */
	}
	try {
		value = decodeURIComponent(value);
	} catch {
		/* keep encoded value */
	}
	if (value.length > 1) value = value.replace(/\/+$/, "");
	return value;
}

/**
 * Parse a PROPFIND multistatus body without a full XML dependency.
 *
 * Namespace prefixes differ between servers (`D:`, `d:`, `lp1:`), so every tag
 * is matched by its local name.
 *
 * @param {string} xml - response body.
 * @returns {Array<{href: string, name: string, dir: boolean, size: number, modified: string}>} parsed entries.
 */
export function parseMultiStatus(xml) {
	const entries = [];
	for (const block of String(xml).matchAll(/<(?:[\w-]+:)?response\b[\s\S]*?<\/(?:[\w-]+:)?response>/gi)) {
		const chunk = block[0];
		const href = /<(?:[\w-]+:)?href[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?href>/i.exec(chunk)?.[1] ?? "";
		const type = /<(?:[\w-]+:)?resourcetype[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?resourcetype>/i.exec(chunk)?.[1] ?? "";
		const size = /<(?:[\w-]+:)?getcontentlength[^>]*>(\d*)</i.exec(chunk)?.[1] ?? "0";
		const modified = /<(?:[\w-]+:)?getlastmodified[^>]*>([\s\S]*?)</i.exec(chunk)?.[1] ?? "";
		const davPath = hrefToDavPath(href);
		const stamp = Date.parse(modified);
		entries.push({
			href: davPath,
			name: davPath === "/" ? "/" : davPath.slice(davPath.lastIndexOf("/") + 1),
			dir: /collection/i.test(type),
			size: Number(size) || 0,
			modified: Number.isFinite(stamp) ? String(Math.floor(stamp / 1000)) : "",
		});
	}
	return entries;
}

/**
 * Translate a NAS path the tools use into a WebDAV path.
 *
 * @param {import("../client.js").ZSpaceClient} client - live client.
 * @param {string} nasPath - NAS path such as `/sata1/my/data/a.txt`.
 * @returns {Promise<string>} DAV path.
 * @throws {ZSpaceError} when the path is outside both known roots.
 */
export async function toDavPath(client, nasPath) {
	const roots = await nasRoots(client);
	const homeDav = client.webdavHomePath || "/";
	const publicDav = client.webdavPublicPath || "";
	const value = String(nasPath);
	if (roots.home && (value === roots.home || value.startsWith(`${roots.home}/`))) {
		return joinDav(homeDav, value.slice(roots.home.length));
	}
	if (publicDav && roots.public && (value === roots.public || value.startsWith(`${roots.public}/`))) {
		return joinDav(publicDav, value.slice(roots.public.length));
	}
	throw new ZSpaceError(
		"DAV_PATH",
		`WebDAV 通道无法映射该路径（不在个人/公共空间根下）：${value}。可在配置里写死 homePath / publicPath，或改用 home: / public: 前缀。`,
	);
}

/**
 * Translate a WebDAV path back into the NAS path shape the tools expect.
 *
 * @param {import("../client.js").ZSpaceClient} client - live client.
 * @param {string} davPath - DAV path.
 * @returns {Promise<string>} NAS path.
 */
export async function fromDavPath(client, davPath) {
	const roots = await nasRoots(client);
	const homeDav = (client.webdavHomePath || "/").replace(/\/+$/, "") || "/";
	const publicDav = (client.webdavPublicPath || "").replace(/\/+$/, "");
	const value = davPath === "/" ? "/" : davPath.replace(/\/+$/, "");
	if (publicDav && (value === publicDav || value.startsWith(`${publicDav}/`))) {
		return joinRemote(roots.public || "/public", value.slice(publicDav.length));
	}
	const rest = homeDav === "/" ? value : value.slice(homeDav.length);
	return joinRemote(roots.home || "", rest);
}

/**
 * NAS-side roots, resolved once: config first, then a relay lookup.
 *
 * @param {import("../client.js").ZSpaceClient} client - live client.
 * @returns {Promise<{home: string, public: string}>} NAS roots ("" when unknown).
 */
export async function nasRoots(client) {
	if (client._davRoots) return client._davRoots;
	let home = client.configuredHomePath || client._homePath || "";
	let publicSpace = client.configuredPublicPath || client._publicPath || "";
	if (!home || !publicSpace) {
		// The relay knows the real roots; one lookup is cheaper than making the
		// user restate them. It is fine for this to fail — the caller then gets a
		// clear "set homePath/publicPath" error.
		const relay = await import("./relay.js");
		if (!home) home = await relay.homePath(client).catch(() => "");
		if (!publicSpace) publicSpace = await relay.publicPath(client).catch(() => "");
	}
	client._davRoots = { home, public: publicSpace };
	return client._davRoots;
}

/**
 * Reachability + credential probe, used by the router.
 *
 * @param {import("../client.js").ZSpaceClient} client - live client.
 * @returns {Promise<{reachable: boolean, usable: boolean, status?: number, reason: string}>} probe result.
 */
export async function probe(client) {
	if (!String(client.webdavUrl ?? "").trim()) {
		return { reachable: false, usable: false, reason: "未配置 webdavUrl" };
	}
	if (!credentials(client).complete) {
		return { reachable: false, usable: false, reason: `缺少 WebDAV 凭据（设置 ${USER_ENV} 与 ${PASSWORD_ENV}）` };
	}
	try {
		const response = await request(client, {
			method: "PROPFIND",
			davPath: "/",
			headers: { Depth: "0" },
			timeoutMs: client.webdavProbeTimeoutMs ?? 1500,
		});
		if (response.status === 401 || response.status === 403) {
			return { reachable: true, usable: false, status: response.status, reason: `可达但凭据被拒（HTTP ${response.status}）` };
		}
		if (response.status >= 500) {
			return { reachable: true, usable: false, status: response.status, reason: `服务端错误（HTTP ${response.status}）` };
		}
		return { reachable: true, usable: true, status: response.status, reason: `可达（HTTP ${response.status}）` };
	} catch (error) {
		return {
			reachable: false,
			usable: false,
			reason: error?.code === "ETIMEDOUT" ? "探测超时（多半不在同一网络）" : `不可达：${error?.message ?? error}`,
		};
	}
}

/**
 * Connectivity in the shape the tools expect.
 *
 * @param {import("../client.js").ZSpaceClient} client - live client.
 * @returns {Promise<boolean>} whether WebDAV is usable right now.
 */
export async function check(client) {
	return (await probe(client)).usable;
}

/**
 * Storage pools are a relay-only concept (WebDAV does not expose them).
 *
 * @returns {Promise<Array<never>>} always empty.
 */
export async function pools() {
	return [];
}

/**
 * Whether a path exists and is a collection.
 *
 * @param {import("../client.js").ZSpaceClient} client - live client.
 * @param {string} nasPath - NAS path.
 * @returns {Promise<boolean>} true for existing directories.
 */
export async function isDirectory(client, nasPath) {
	try {
		const entry = await info(client, nasPath);
		return entry.dir === true;
	} catch {
		return false;
	}
}

/**
 * NAS path of the personal-space root.
 *
 * @param {import("../client.js").ZSpaceClient} client - live client.
 * @returns {Promise<string>} NAS path.
 */
export async function homePath(client) {
	const roots = await nasRoots(client);
	if (!roots.home) throw new ZSpaceError("NOHOME", "WebDAV 模式下无法确定个人空间根：请在配置里设置 homePath");
	return roots.home;
}

/**
 * NAS path of the public-space root.
 *
 * @param {import("../client.js").ZSpaceClient} client - live client.
 * @returns {Promise<string>} NAS path.
 */
export async function publicPath(client) {
	const roots = await nasRoots(client);
	if (!roots.public) throw new ZSpaceError("NOPUBLIC", "WebDAV 模式下无法确定公共空间根：请在配置里设置 publicPath（或它在 WebDAV 里不可见）");
	return roots.public;
}

/**
 * List one directory (single PROPFIND, no 50-row paging).
 *
 * @param {import("../client.js").ZSpaceClient} client - live client.
 * @param {string} nasPath - NAS directory.
 * @param {{showHidden?: boolean, maxEntries?: number}} [options] - listing options.
 * @returns {Promise<{entries: Array<ReturnType<typeof toEntry>>, truncated: boolean}>} listing.
 */
export async function list(client, nasPath, options = {}) {
	const davPath = await toDavPath(client, nasPath);
	const response = await request(client, { method: "PROPFIND", davPath, headers: { Depth: "1" } });
	await assertOk(response, `PROPFIND ${nasPath}`);
	const xml = await response.text();
	const self = davPath === "/" ? "/" : davPath.replace(/\/+$/, "");
	const maxEntries = options.maxEntries ?? client.listMaxEntries ?? 2000;
	const entries = [];
	let truncated = false;
	for (const raw of parseMultiStatus(xml)) {
		if (raw.href === self || raw.href === `${self}/`) continue;
		if (!raw.name) continue;
		if (!options.showHidden && raw.name.startsWith(".")) continue;
		if (entries.length >= maxEntries) {
			truncated = true;
			break;
		}
		const nas = await fromDavPath(client, raw.href);
		entries.push(
			toEntry({
				name: raw.name,
				path: nas,
				is_dir: raw.dir ? "1" : "0",
				size: String(raw.size),
				modify_time: raw.modified,
			}),
		);
	}
	entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, "zh"));
	return { entries, truncated };
}

/**
 * Metadata for one path.
 *
 * @param {import("../client.js").ZSpaceClient} client - live client.
 * @param {string} nasPath - NAS path.
 * @returns {Promise<ReturnType<typeof toEntry>>} normalized entry.
 */
export async function info(client, nasPath) {
	const davPath = await toDavPath(client, nasPath);
	const response = await request(client, { method: "PROPFIND", davPath, headers: { Depth: "0" } });
	await assertOk(response, `PROPFIND ${nasPath}`);
	const [first] = parseMultiStatus(await response.text());
	if (!first) throw new ZSpaceError("N001315", `文件不存在（${nasPath}）`);
	return toEntry({
		name: first.name === "/" ? davPath.slice(davPath.lastIndexOf("/") + 1) : first.name,
		path: nasPath,
		is_dir: first.dir ? "1" : "0",
		size: String(first.size),
		modify_time: first.modified,
	});
}

/**
 * Create a directory (MKCOL).
 *
 * @param {import("../client.js").ZSpaceClient} client - live client.
 * @param {string} nasPath - NAS directory to create.
 * @returns {Promise<ReturnType<typeof toEntry>>} created entry.
 */
export async function mkdir(client, nasPath) {
	const davPath = await toDavPath(client, nasPath);
	const response = await request(client, { method: "MKCOL", davPath });
	if (response.status === 405) throw new ZSpaceError("N001212", `目录已存在：${nasPath}`);
	await assertOk(response, `MKCOL ${nasPath}`);
	return toEntry({ name: nasPath.slice(nasPath.lastIndexOf("/") + 1), path: nasPath, is_dir: "1", size: "0" });
}

/**
 * Rename in place (MOVE within the same directory).
 *
 * @param {import("../client.js").ZSpaceClient} client - live client.
 * @param {string} nasPath - NAS path to rename.
 * @param {string} newName - new base name.
 * @returns {Promise<ReturnType<typeof toEntry>>} renamed entry.
 */
export async function rename(client, nasPath, newName) {
	const parent = nasPath.slice(0, nasPath.lastIndexOf("/"));
	const target = `${parent}/${newName}`;
	await movePath(client, nasPath, target);
	return toEntry({ name: newName, path: target, is_dir: "0", size: "0" });
}

/**
 * MOVE one NAS path to an absolute destination (used by rename/move).
 *
 * @param {import("../client.js").ZSpaceClient} client - live client.
 * @param {string} from - source NAS path.
 * @param {string} to - destination NAS path.
 * @returns {Promise<void>} resolves when accepted.
 */
async function movePath(client, from, to) {
	const source = await toDavPath(client, from);
	const destination = await toDavPath(client, to);
	const response = await request(client, {
		method: "MOVE",
		davPath: source,
		headers: { Destination: `${baseUrl(client)}${encodePath(destination)}`, Overwrite: "F" },
	});
	if (response.status === 412) throw new ZSpaceError("N001212", `目标已存在：${to}`);
	await assertOk(response, `MOVE ${from} -> ${to}`);
}

/**
 * Move several paths into a target directory.
 *
 * @param {import("../client.js").ZSpaceClient} client - live client.
 * @param {string[]} nasPaths - sources.
 * @param {string} to - destination directory.
 * @returns {Promise<void>} resolves when accepted.
 */
export async function move(client, nasPaths, to) {
	for (const source of nasPaths) {
		const name = source.slice(source.lastIndexOf("/") + 1);
		await movePath(client, source, `${to.replace(/\/+$/, "")}/${name}`);
	}
}

/**
 * Copy several paths into a target directory.
 *
 * @param {import("../client.js").ZSpaceClient} client - live client.
 * @param {string[]} nasPaths - sources.
 * @param {string} to - destination directory.
 * @returns {Promise<void>} resolves when accepted.
 */
export async function copy(client, nasPaths, to) {
	for (const source of nasPaths) {
		const name = source.slice(source.lastIndexOf("/") + 1);
		const from = await toDavPath(client, source);
		const target = await toDavPath(client, `${to.replace(/\/+$/, "")}/${name}`);
		const response = await request(client, {
			method: "COPY",
			davPath: from,
			headers: { Destination: `${baseUrl(client)}${encodePath(target)}`, Overwrite: "F" },
		});
		if (response.status === 412) throw new ZSpaceError("N001212", `目标已存在：${to}/${name}`);
		await assertOk(response, `COPY ${source} -> ${to}`);
	}
}

/**
 * Delete paths (WebDAV DELETE — recycle-bin behaviour is the NAS's call).
 *
 * @param {import("../client.js").ZSpaceClient} client - live client.
 * @param {string[]} nasPaths - paths to delete.
 * @returns {Promise<void>} resolves when accepted.
 */
export async function remove(client, nasPaths) {
	for (const target of nasPaths) {
		const davPath = await toDavPath(client, target);
		const response = await request(client, { method: "DELETE", davPath });
		await assertOk(response, `DELETE ${target}`);
	}
}

/**
 * Download a file to a local directory.
 *
 * @param {import("../client.js").ZSpaceClient} client - live client.
 * @param {string} nasPath - NAS file.
 * @param {string} localDir - local destination directory.
 * @param {{name?: string}} [options] - name override.
 * @returns {Promise<{localPath: string, bytes: number}>} written file.
 */
export async function download(client, nasPath, localDir, options = {}) {
	const davPath = await toDavPath(client, nasPath);
	const response = await request(client, { method: "GET", davPath });
	await assertOk(response, `GET ${nasPath}`);
	if (!response.body) throw new ZSpaceError("EDAV", `WebDAV 未返回内容：${nasPath}`);
	const dest = path.join(localDir, options.name || path.posix.basename(nasPath));
	await fsp.mkdir(localDir, { recursive: true });
	try {
		await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(dest));
	} catch (error) {
		await fsp.rm(dest, { force: true });
		throw new ZSpaceError("EDOWNLOAD", `写入本地文件失败：${dest}（${error.message}）`, { cause: error });
	}
	const stat = await fsp.stat(dest);
	return { localPath: dest, bytes: stat.size };
}

/**
 * Read the head of a file into memory.
 *
 * @param {import("../client.js").ZSpaceClient} client - live client.
 * @param {string} nasPath - NAS file.
 * @param {{maxBytes?: number}} [options] - byte cap.
 * @returns {Promise<{buffer: Buffer, truncated: boolean, bytes: number}>} content.
 */
export async function readFile(client, nasPath, options = {}) {
	const maxBytes = options.maxBytes ?? 262_144;
	const davPath = await toDavPath(client, nasPath);
	const response = await request(client, { method: "GET", davPath, headers: { Range: `bytes=0-${maxBytes - 1}` } });
	await assertOk(response, `GET ${nasPath}`);
	if (!response.body) return { buffer: Buffer.alloc(0), truncated: false, bytes: 0 };
	const buffer = Buffer.from(await response.arrayBuffer());
	const truncated = response.status === 206 ? buffer.length >= maxBytes : buffer.length > maxBytes;
	return { buffer: buffer.subarray(0, maxBytes), truncated, bytes: Math.min(buffer.length, maxBytes) };
}

/**
 * Upload a local file (single PUT).
 *
 * @param {import("../client.js").ZSpaceClient} client - live client.
 * @param {string} localPath - local file.
 * @param {string} remoteDir - NAS destination directory.
 * @param {{name?: string}} [options] - name override.
 * @returns {Promise<{remotePath: string, bytes: number, method: "put"}>} upload result.
 */
export async function upload(client, localPath, remoteDir, options = {}) {
	const stat = await fsp.stat(localPath);
	const name = options.name || path.basename(localPath);
	const target = joinRemote(remoteDir, name);
	const davPath = await toDavPath(client, target);
	const response = await request(client, {
		method: "PUT",
		davPath,
		headers: { "Content-Type": "application/octet-stream", "Content-Length": String(stat.size) },
		body: Readable.toWeb(fs.createReadStream(localPath)),
	});
	await assertOk(response, `PUT ${target}`);
	return { remotePath: target, bytes: stat.size, method: "put" };
}

/**
 * Not used by the WebDAV transport (PUT is never sliced).
 *
 * @returns {Promise<never>} always throws.
 */
export async function uploadSliced() {
	throw new ZSpaceError("EDAV", "WebDAV 通道不使用分片上传");
}

/**
 * Not used by the WebDAV transport (download() opens its own request).
 *
 * @returns {Promise<never>} always throws.
 */
export async function openDownload() {
	throw new ZSpaceError("EDAV", "WebDAV 通道请使用 download()");
}
