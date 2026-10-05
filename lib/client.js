/**
 * Minimal, dependency-free ZSpace (极空间) NAS client.
 *
 * Everything goes through the **desktop client's local proxy**
 * (`http://127.0.0.1:13579`), which relays to the NAS over 极空间's cloud /
 * P2P channel. Working from another network therefore needs no LAN address,
 * no DDNS, no WebDAV share and no SSH — only a logged-in desktop client on the
 * machine that runs DSH.
 *
 * Protocol notes (community-reverse-engineered, verified against a live
 * Z4S / ZOS install on 2026-10-05):
 *
 * - POST `application/x-www-form-urlencoded`; auth via cookies
 *   (`token` / `zenithtoken` / `nas_id` / `nasid` / `device_id`) plus the
 *   `token` / `nasid` / `plat=web` / `version` / `device_id` / `_l` form fields.
 *   The common fields must ride in the **body**; putting them in the query
 *   string makes the NAS answer `N001212 参数有误`.
 * - Every URL carries `?&rnd=<ts>_<rand>&webagent=v2`.
 * - `/v2/file/list` returns at most 50 rows, so long directories are paged.
 * - `move` / `copy` / `remove` take repeated `paths[]` fields and a `to`.
 * - Small files upload through `/v2/file/create` with the target path in a
 *   **percent-encoded `path` header**; bodies above the local proxy's limit
 *   answer HTTP 413 and must use the desktop client's sliced
 *   `/v2/file/upload` protocol instead.
 *
 * @module dsh-zspace/client
 */

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import { DEFAULT_API_VERSION, loadCredentials, resolveBaseUrl } from "./auth.js";
import { joinRemote, splitRemote, toEntry } from "./format.js";

const FORM_TYPE = "application/x-www-form-urlencoded";
const DEFAULT_PAGE_SIZE = 50;

/**
 * Business codes the desktop client treats as fatal during sliced uploads —
 * retrying them only burns time (permission / conflicting dir / safe-box).
 */
const UPLOAD_FATAL_CODES = new Set(["N001302", "N001331", "N001603", "N001397"]);

/** Network errno values worth a retry; a down client is not among them. */
const RETRYABLE_ERRNOS = new Set(["ECONNRESET", "ETIMEDOUT", "EPIPE", "EAI_AGAIN", "ENETUNREACH"]);

/**
 * One ZSpace API or transport failure.
 *
 * `code` is the NAS business code (`N001411`, …) when the response parsed,
 * or a synthetic marker (`HTTP413`, `EPROXY`, …) otherwise.
 */
export class ZSpaceError extends Error {
	/**
	 * @param {string} code - NAS business code or synthetic marker.
	 * @param {string} message - human-readable message.
	 * @param {{endpoint?: string, cause?: unknown}} [options] - context.
	 */
	constructor(code, message, options = {}) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "ZSpaceError";
		this.code = String(code);
		this.endpoint = options.endpoint ?? "";
	}

	/**
	 * Actionable next step for known codes, or `undefined`.
	 *
	 * @returns {string|undefined} hint text.
	 */
	get hint() {
		const message = this.message;
		if (this.code === "N001411" || /无权限/.test(message)) {
			return "没有权限：确认该账号对目标路径可访问（「/」与裸盘根目录总是拒绝的，先 ls 已知的空间根，例如 home: 或 public:）。";
		}
		if (this.code === "N001315" || /不存在/.test(message)) {
			return "路径不存在：先列出上级目录确认拼写，注意大小写与中文全角字符。";
		}
		if (this.code === "N001212") {
			return "参数有误：路径必须以 / 开头（或用 home: / public: / 相对路径）。";
		}
		if (this.code === "HTTP413") {
			return "本地代理拒绝超大请求体：大文件会自动改走分片上传，若仍失败请降低分片大小。";
		}
		if (this.code === "EPROXY") {
			return "连不上极空间桌面客户端本地代理：确认客户端已安装、已登录并在运行（端口 13579）。";
		}
		return undefined;
	}
}

/**
 * Random token appended to every request URL.
 *
 * @returns {string} `?&rnd=` value.
 */
function randomToken() {
	return `${Date.now()}${Math.floor(Math.random() * 9000 + 1000)}_${Math.floor(Math.random() * 9000 + 1000)}`;
}

/**
 * Percent-encode one value for a form field, query value or upload header.
 *
 * @param {unknown} value - value to encode.
 * @returns {string} encoded value.
 */
function percentEncode(value) {
	return encodeURIComponent(String(value));
}

/**
 * Whether a transport error is worth retrying.
 *
 * @param {unknown} error - thrown value.
 * @returns {boolean} true when a retry may succeed.
 */
function isRetryableTransportError(error) {
	const errno = /** @type {{code?: string, name?: string}} */ (error)?.code;
	if (errno === "ECONNREFUSED" || errno === "ENOTFOUND" || errno === "EHOSTUNREACH") return false;
	if (errno !== undefined && RETRYABLE_ERRNOS.has(errno)) return true;
	return false;
}

/**
 * Read a whole stream with a byte cap.
 *
 * @param {import("node:stream").Readable} stream - source stream.
 * @param {number} [maxBytes] - stop after this many bytes.
 * @returns {Promise<{buffer: Buffer, truncated: boolean}>} collected bytes.
 */
async function readStream(stream, maxBytes = Number.POSITIVE_INFINITY) {
	const chunks = [];
	let total = 0;
	let truncated = false;
	for await (const chunk of stream) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		if (total + buffer.length > maxBytes) {
			chunks.push(buffer.subarray(0, Math.max(0, maxBytes - total)));
			total = maxBytes;
			truncated = true;
			break;
		}
		chunks.push(buffer);
		total += buffer.length;
	}
	return { buffer: Buffer.concat(chunks), truncated };
}

/**
 * Cross-network ZSpace NAS client.
 */
export class ZSpaceClient {
	/**
	 * @param {object} [options] - client options.
	 * @param {string} [options.baseUrl] - desktop client proxy URL.
	 * @param {string} [options.configDir] - explicit directory holding `vuex.json`.
	 * @param {string} [options.apiVersion] - NAS web API version.
	 * @param {{token: string, nasId: string, deviceId: string, device?: string, appVersion?: string, username?: string}} [options.credentials]
	 *   explicit credentials (tests); otherwise read from `vuex.json`.
	 * @param {string} [options.homePath] - configured personal-space root.
	 * @param {string} [options.publicPath] - configured public-space root.
	 * @param {number} [options.timeoutMs] - per-request timeout.
	 * @param {number} [options.maxRetries] - retries for transient failures.
	 * @param {number} [options.pageSize] - directory page size (NAS caps at 50).
	 * @param {number} [options.listMaxEntries] - directory listing ceiling.
	 * @param {number} [options.smallUploadMaxBytes] - above this, upload sliced.
	 * @param {number} [options.sliceSize] - sliced upload chunk size.
	 */
	constructor(options = {}) {
		this.baseUrl = resolveBaseUrl(options.baseUrl);
		this.configDir = options.configDir;
		this.apiVersion = options.apiVersion || DEFAULT_API_VERSION;
		this.timeoutMs = options.timeoutMs ?? 60_000;
		this.maxRetries = options.maxRetries ?? 2;
		this.retryDelayMs = options.retryDelayMs ?? 300;
		this.pageSize = Math.min(options.pageSize ?? DEFAULT_PAGE_SIZE, DEFAULT_PAGE_SIZE);
		this.listMaxEntries = options.listMaxEntries ?? 2000;
		this.smallUploadMaxBytes = options.smallUploadMaxBytes ?? 8 * 1024 * 1024;
		this.sliceSize = options.sliceSize ?? 2 * 1024 * 1024;
		this.configuredHomePath = options.homePath || "";
		this.configuredPublicPath = options.publicPath || "";
		this._credentials = options.credentials ?? null;
		this._homePath = null;
		this._publicPath = null;
		this._pools = null;
	}

	/**
	 * Desktop-client credentials, loaded lazily and re-read when `vuex.json` changes.
	 *
	 * @returns {{token: string, nasId: string, deviceId: string, username: string, device: string, appVersion: string, vuexPath?: string}}
	 */
	get credentials() {
		if (this._credentials === null) this._credentials = loadCredentials(this.configDir);
		return this._credentials;
	}

	/**
	 * Identity of the account this client acts as (no secrets).
	 *
	 * @returns {{username: string, nasId: string, deviceId: string, vuexPath: string}} safe identity fields.
	 */
	get identity() {
		const creds = this.credentials;
		return {
			username: creds.username ?? "",
			nasId: creds.nasId ?? "",
			deviceId: creds.deviceId ?? "",
			vuexPath: creds.vuexPath ?? "",
		};
	}

	// ── transport ────────────────────────────────────────────────────────────

	/**
	 * Auth cookies for every request.
	 *
	 * @returns {Record<string, string>} request headers carrying the session.
	 */
	authHeaders() {
		const creds = this.credentials;
		return {
			Cookie: [
				`token=${creds.token}`,
				`zenithtoken=${creds.token}`,
				`nas_id=${creds.nasId}`,
				`nasid=${creds.nasId}`,
				`device_id=${creds.deviceId}`,
			].join("; "),
		};
	}

	/**
	 * Common form fields. These belong in the request **body**; the NAS rejects
	 * them in the query string with `N001212`.
	 *
	 * @returns {Record<string, string>} common fields.
	 */
	commonParams() {
		const creds = this.credentials;
		return {
			token: creds.token,
			nasid: creds.nasId,
			plat: "web",
			version: this.apiVersion,
			device_id: creds.deviceId,
			_l: "zh_cn",
		};
	}

	/**
	 * Build an endpoint URL with the mandatory random query suffix.
	 *
	 * @param {string} endpoint - API path, e.g. `/v2/file/list`.
	 * @param {Record<string, unknown>} [query] - extra query values.
	 * @returns {string} absolute URL.
	 */
	endpointUrl(endpoint, query) {
		let url = `${this.baseUrl}${endpoint}?&rnd=${randomToken()}&webagent=v2`;
		for (const [key, value] of Object.entries(query ?? {})) {
			if (value === undefined || value === null) continue;
			url += `&${key}=${percentEncode(value)}`;
		}
		return url;
	}

	/**
	 * Encode form fields, expanding arrays into repeated `key[]` entries.
	 *
	 * @param {Record<string, unknown>} fields - form fields.
	 * @returns {string} urlencoded body.
	 */
	formBody(fields) {
		const parts = [];
		for (const [key, value] of Object.entries({ ...this.commonParams(), ...fields })) {
			if (value === undefined || value === null) continue;
			if (Array.isArray(value)) {
				for (const item of value) parts.push(`${percentEncode(key)}%5B%5D=${percentEncode(item)}`);
			} else {
				parts.push(`${percentEncode(key)}=${percentEncode(value)}`);
			}
		}
		return parts.join("&");
	}

	/**
	 * Retry a transport call with exponential backoff.
	 *
	 * @template T
	 * @param {() => Promise<T>} attempt - one attempt.
	 * @param {(error: unknown) => boolean} shouldRetry - retry predicate.
	 * @returns {Promise<T>} the first successful result.
	 */
	async retrying(attempt, shouldRetry) {
		let lastError;
		for (let index = 0; index <= this.maxRetries; index += 1) {
			try {
				return await attempt();
			} catch (error) {
				lastError = error;
				if (index >= this.maxRetries || !shouldRetry(error)) throw error;
				await new Promise(resolve => setTimeout(resolve, Math.min(this.retryDelayMs * 2 ** index, 2000)));
			}
		}
		throw lastError;
	}

	/**
	 * Send one buffered request.
	 *
	 * @param {object} options - request options.
	 * @param {"GET"|"POST"} [options.method] - HTTP method.
	 * @param {string} options.endpoint - API path.
	 * @param {Record<string, unknown>} [options.query] - extra query values.
	 * @param {Record<string, unknown>} [options.form] - form fields (merged with common params).
	 * @param {Record<string, unknown>} [options.fields] - raw fields appended without common params.
	 * @param {Buffer} [options.body] - raw request body.
	 * @param {string} [options.filePath] - stream this file as the request body.
	 * @param {Record<string, string>} [options.headers] - extra headers (override auth).
	 * @param {string} [options.url] - absolute URL override (sliced upload).
	 * @param {number} [options.timeoutMs] - per-attempt timeout.
	 * @returns {Promise<{status: number, headers: import("node:http").IncomingHttpHeaders, text: string}>} response.
	 */
	async send(options) {
		const attempt = async () => {
			const url = options.url ?? this.endpointUrl(options.endpoint, options.query);
			const headers = { ...this.authHeaders(), ...(options.headers ?? {}) };
			let payload;
			if (options.form !== undefined || options.fields !== undefined) {
				payload = Buffer.from(
					options.form !== undefined
						? this.formBody(options.form)
						: Object.entries(options.fields ?? {})
								.map(([key, value]) => `${percentEncode(key)}=${percentEncode(value)}`)
								.join("&"),
					"utf8",
				);
				headers["Content-Type"] = headers["Content-Type"] ?? FORM_TYPE;
				headers["Content-Length"] = String(payload.length);
			} else if (options.filePath !== undefined) {
				const stat = await fsp.stat(options.filePath);
				headers["Content-Length"] = String(stat.size);
			} else if (options.body !== undefined) {
				payload = options.body;
				headers["Content-Length"] = headers["Content-Length"] ?? String(payload.length);
			}

			return await new Promise((resolve, reject) => {
				const parsed = new URL(url);
				const transport = parsed.protocol === "https:" ? https : http;
				const request = transport.request(
					url,
					{ method: options.method ?? "POST", headers },
					(response) => {
						readStream(response, 64 * 1024 * 1024).then(
							({ buffer }) => {
								const status = response.statusCode ?? 0;
								// 5xx/429 mean the proxy hiccuped, not that the call was
								// wrong — surface them as retryable failures here, where the
								// retry loop can still see them.
								if (status >= 500 || status === 429) {
									reject(
										new ZSpaceError(`HTTP${status}`, `HTTP ${status} on ${options.endpoint ?? url}: ${buffer.toString("utf8").slice(0, 200)}`, {
											endpoint: options.endpoint ?? url,
										}),
									);
									return;
								}
								resolve({ status, headers: response.headers, text: buffer.toString("utf8") });
							},
							reject,
						);
					},
				);
				request.setTimeout(options.timeoutMs ?? this.timeoutMs, () => {
					request.destroy(new ZSpaceError("ETIMEDOUT", `请求超时（${options.endpoint ?? options.url}）`));
				});
				request.on("error", (error) => {
					if (error instanceof ZSpaceError) {
						reject(error);
						return;
					}
					reject(
						new ZSpaceError("EPROXY", `无法访问极空间桌面客户端代理 ${this.baseUrl}：${error.message}`, {
							endpoint: options.endpoint ?? url,
							cause: error,
						}),
					);
				});
				if (options.filePath !== undefined) {
					const source = fs.createReadStream(options.filePath);
					source.on("error", reject);
					source.pipe(request);
				} else {
					request.end(payload);
				}
			});
		};

		return await this.retrying(attempt, error => {
			if (error instanceof ZSpaceError) {
				if (error.code === "ETIMEDOUT") return true;
				if (error.code === "EPROXY") return isRetryableTransportError(error.cause);
				// The desktop proxy hiccups with 5xx/429 now and then; the NAS's
				// business codes (N00…) are deterministic and never retried here.
				return /^HTTP(5\d\d|429)$/.test(error.code);
			}
			return isRetryableTransportError(error);
		});
	}

	/**
	 * Validate a buffered JSON response and unwrap its `data`.
	 *
	 * @param {{status: number, text: string}} response - raw response.
	 * @param {string} endpoint - endpoint for error context.
	 * @returns {any} the response `data` (or the whole body when it has none).
	 * @throws {ZSpaceError} on HTTP failures, HTTP 413 and non-200 business codes.
	 */
	parse(response, endpoint) {
		const { status, text } = response;
		if (status === 413) {
			throw new ZSpaceError("HTTP413", `本地代理拒绝该请求体（HTTP 413）`, { endpoint });
		}
		if (status >= 400) {
			throw new ZSpaceError(`HTTP${status}`, `HTTP ${status} on ${endpoint}: ${text.slice(0, 200)}`, { endpoint });
		}
		let body;
		try {
			body = JSON.parse(text);
		} catch {
			throw new ZSpaceError("BAD_JSON", `${endpoint} 返回了非 JSON 内容：${text.slice(0, 200)}`, { endpoint });
		}
		const code = body.code ?? body.errcode;
		if (code !== undefined && String(code) !== "200") {
			throw new ZSpaceError(String(code), `${body.msg ?? body.message ?? "error"}（${endpoint}）`, { endpoint });
		}
		return body.data !== undefined ? body.data : body;
	}

	/**
	 * POST form fields and return the unwrapped `data`.
	 *
	 * @param {string} endpoint - API path.
	 * @param {Record<string, unknown>} [fields] - form fields.
	 * @returns {Promise<any>} response data.
	 */
	async post(endpoint, fields) {
		const response = await this.send({ method: "POST", endpoint, form: fields ?? {} });
		return this.parse(response, endpoint);
	}

	// ── connectivity and spaces ──────────────────────────────────────────────

	/**
	 * Probe the desktop client proxy.
	 *
	 * @returns {Promise<boolean>} true when the proxy answers below 500.
	 */
	async check() {
		const url = `${this.baseUrl}/home/`;
		return await new Promise((resolve) => {
			const parsed = new URL(url);
			const transport = parsed.protocol === "https:" ? https : http;
			const request = transport.get(url, { timeout: 3000 }, (response) => {
				response.resume();
				resolve((response.statusCode ?? 500) < 500);
			});
			request.setTimeout(3000, () => request.destroy());
			request.on("error", () => resolve(false));
		});
	}

	/**
	 * Storage pools (`/zspool/info`), cached per client.
	 *
	 * @returns {Promise<Array<{name: string, status: string, totalSize: number, freeSize: number}>>} pools.
	 */
	async pools() {
		if (this._pools !== null) return this._pools;
		const data = await this.post("/zspool/info", {});
		const list = Array.isArray(data?.pool_list) ? data.pool_list : [];
		this._pools = list.map((pool) => ({
			name: String(pool.name ?? ""),
			status: String(pool.status ?? ""),
			totalSize: Number(pool.total_size ?? 0),
			freeSize: Number(pool.free_size ?? 0),
		}));
		return this._pools;
	}

	/**
	 * Whether a remote directory can be listed.
	 *
	 * @param {string} remotePath - absolute remote path.
	 * @returns {Promise<boolean>} true when listing succeeds.
	 */
	async isDirectory(remotePath) {
		try {
			await this.post("/v2/file/list", { path: remotePath, show_hidden: "0", start: "0", limit: "1" });
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Locate the personal-space root, e.g. `/sata1/my/data`.
	 *
	 * Uses the configured path when set, otherwise tries `/<pool>/my/data` for
	 * every storage pool and falls back to the historical `/sata11/my/data`.
	 *
	 * @returns {Promise<string>} personal-space root.
	 * @throws {ZSpaceError} when no candidate is listable.
	 */
	async homePath() {
		if (this._homePath !== null) return this._homePath;
		const candidates = [];
		if (this.configuredHomePath) {
			candidates.push(this.configuredHomePath);
		} else {
			for (const pool of await this.pools().catch(() => [])) candidates.push(`/${pool.name}/my/data`);
			candidates.push("/sata11/my/data", "/sata1/my/data");
		}
		for (const candidate of [...new Set(candidates)]) {
			if (await this.isDirectory(candidate)) {
				this._homePath = candidate;
				return candidate;
			}
		}
		throw new ZSpaceError("NOHOME", `无法定位个人空间根目录，已尝试：${candidates.join("、")}`);
	}

	/**
	 * Locate the public-space root, e.g. `/sata1/public`.
	 *
	 * @returns {Promise<string>} public-space root.
	 * @throws {ZSpaceError} when no candidate is listable (account may lack access).
	 */
	async publicPath() {
		if (this._publicPath !== null) return this._publicPath;
		const candidates = [];
		if (this.configuredPublicPath) {
			candidates.push(this.configuredPublicPath);
		} else {
			for (const pool of await this.pools().catch(() => [])) candidates.push(`/${pool.name}/public`);
			candidates.push("/public", "/sata1/public");
		}
		for (const candidate of [...new Set(candidates)]) {
			if (await this.isDirectory(candidate)) {
				this._publicPath = candidate;
				return candidate;
			}
		}
		throw new ZSpaceError("NOPUBLIC", `无法定位公共空间（账号可能没有公共空间权限），已尝试：${candidates.join("、")}`);
	}

	// ── file operations ──────────────────────────────────────────────────────

	/**
	 * List one directory, paging until the NAS has no more rows.
	 *
	 * @param {string} remotePath - absolute remote directory.
	 * @param {{showHidden?: boolean, maxEntries?: number}} [options] - listing options.
	 * @returns {Promise<{entries: Array<ReturnType<typeof toEntry>>, truncated: boolean}>} listing.
	 */
	async list(remotePath, options = {}) {
		const maxEntries = options.maxEntries ?? this.listMaxEntries;
		/** @type {Array<ReturnType<typeof toEntry>>} */
		const entries = [];
		let start = 0;
		let truncated = false;
		for (;;) {
			const data = await this.post("/v2/file/list", {
				path: remotePath,
				show_hidden: options.showHidden ? "1" : "0",
				start: String(start),
				limit: String(this.pageSize),
			});
			const page = Array.isArray(data?.list) ? data.list : [];
			for (const row of page) entries.push(toEntry(row));
			if (page.length < this.pageSize) break;
			start += page.length;
			if (entries.length >= maxEntries) {
				truncated = true;
				break;
			}
		}
		if (entries.length > maxEntries) return { entries: entries.slice(0, maxEntries), truncated: true };
		return { entries, truncated };
	}

	/**
	 * File or directory metadata.
	 *
	 * @param {string} remotePath - absolute remote path.
	 * @returns {Promise<ReturnType<typeof toEntry>>} normalized entry.
	 */
	async info(remotePath) {
		const data = await this.post("/v2/file/info", { path: remotePath });
		return toEntry(data ?? {});
	}

	/**
	 * Create one directory.
	 *
	 * @param {string} remotePath - absolute path of the new directory.
	 * @returns {Promise<ReturnType<typeof toEntry>>} the created entry.
	 */
	async mkdir(remotePath) {
		const { parent, name } = splitRemote(remotePath);
		const data = await this.post("/v2/file/newdir", { parent, name, rename: "0" });
		return toEntry(data ?? {});
	}

	/**
	 * Rename a file or directory in place.
	 *
	 * @param {string} remotePath - absolute current path.
	 * @param {string} newName - new base name (no directory part).
	 * @returns {Promise<ReturnType<typeof toEntry>>} the renamed entry.
	 */
	async rename(remotePath, newName) {
		const data = await this.post("/v2/file/modify", { path: remotePath, newname: newName });
		return toEntry(data ?? {});
	}

	/**
	 * Move files or directories into a target directory.
	 *
	 * @param {string[]} remotePaths - absolute source paths.
	 * @param {string} to - absolute destination directory.
	 * @returns {Promise<void>} resolves when the NAS accepted the move.
	 */
	async move(remotePaths, to) {
		await this.post("/v2/file/move", { paths: remotePaths, to });
	}

	/**
	 * Copy files or directories into a target directory.
	 *
	 * @param {string[]} remotePaths - absolute source paths.
	 * @param {string} to - absolute destination directory.
	 * @returns {Promise<void>} resolves when the NAS accepted the copy.
	 */
	async copy(remotePaths, to) {
		await this.post("/v2/file/copy", { paths: remotePaths, to });
	}

	/**
	 * Delete files or directories (the NAS moves them to its recycle bin).
	 *
	 * @param {string[]} remotePaths - absolute paths to remove.
	 * @returns {Promise<void>} resolves when the NAS accepted the deletion.
	 */
	async remove(remotePaths) {
		await this.post("/v2/file/remove", { paths: remotePaths });
	}

	/**
	 * Download one file to a local directory.
	 *
	 * @param {string} remotePath - absolute remote file.
	 * @param {string} localDir - local destination directory (created if needed).
	 * @param {{name?: string}} [options] - destination name override.
	 * @returns {Promise<{localPath: string, bytes: number}>} written file.
	 */
	async download(remotePath, localDir, options = {}) {
		const name = options.name || path.posix.basename(remotePath);
		const dest = path.join(localDir, name);
		await fsp.mkdir(localDir, { recursive: true });
		const response = await this.openDownload(remotePath);

		const status = response.statusCode ?? 0;
		const contentType = String(response.headers["content-type"] ?? "");
		if (status >= 400 || contentType.includes("json")) {
			const { buffer } = await readStream(response);
			this.parse({ status, text: buffer.toString("utf8") }, "/v2/file/download");
		}
		try {
			await pipeline(response, fs.createWriteStream(dest));
		} catch (error) {
			await fsp.rm(dest, { force: true });
			throw new ZSpaceError("EDOWNLOAD", `写入本地文件失败：${dest}（${error.message}）`, { cause: error });
		}
		const stat = await fsp.stat(dest);
		return { localPath: dest, bytes: stat.size };
	}

	/**
	 * Read the head of a remote file into memory.
	 *
	 * @param {string} remotePath - absolute remote file.
	 * @param {{maxBytes?: number}} [options] - byte cap.
	 * @returns {Promise<{buffer: Buffer, truncated: boolean, bytes: number}>} content.
	 */
	async readFile(remotePath, options = {}) {
		const maxBytes = options.maxBytes ?? 262_144;
		const response = await this.openDownload(remotePath);
		const status = response.statusCode ?? 0;
		const contentType = String(response.headers["content-type"] ?? "");
		if (status >= 400 || contentType.includes("json")) {
			const { buffer } = await readStream(response);
			this.parse({ status, text: buffer.toString("utf8") }, "/v2/file/download");
		}
		const { buffer, truncated } = await readStream(response, maxBytes);
		response.destroy();
		return { buffer, truncated, bytes: buffer.length };
	}

	/**
	 * Open a download response, retrying transient proxy failures.
	 *
	 * @param {string} remotePath - absolute remote file.
	 * @returns {Promise<import("node:http").IncomingMessage>} the open response (caller consumes it).
	 */
	async openDownload(remotePath) {
		const url = this.endpointUrl("/v2/file/download", { path: remotePath, remote_port: "8050" });
		return await this.retrying(
			() =>
				new Promise((resolve, reject) => {
					const request = (this.baseUrl.startsWith("https:") ? https : http).request(
						url,
						{ method: "GET", headers: this.authHeaders() },
						(response) => {
							const status = response.statusCode ?? 0;
							if (status >= 500 || status === 429) {
								response.resume();
								reject(new ZSpaceError(`HTTP${status}`, `HTTP ${status} 下载失败：${remotePath}`, { endpoint: "/v2/file/download" }));
								return;
							}
							resolve(response);
						},
					);
					request.setTimeout(this.timeoutMs, () => request.destroy(new ZSpaceError("ETIMEDOUT", `下载超时：${remotePath}`)));
					request.on("error", (error) => {
						if (error instanceof ZSpaceError) reject(error);
						else reject(new ZSpaceError("EPROXY", `下载失败（${remotePath}）：${error.message}`, { endpoint: "/v2/file/download" }));
					});
					request.end();
				}),
			error =>
				error instanceof ZSpaceError &&
				(error.code === "ETIMEDOUT" || error.code === "EPROXY" || /^HTTP(5\d\d|429)$/.test(error.code)),
		);
	}

	/**
	 * Upload a local file into a remote directory.
	 *
	 * Files at or below `smallUploadMaxBytes` use `/v2/file/create`; larger ones
	 * (and any request the local proxy rejects with HTTP 413) use the desktop
	 * client's sliced `/v2/file/upload` protocol.
	 *
	 * @param {string} localPath - local file.
	 * @param {string} remoteDir - absolute remote directory.
	 * @param {{name?: string, onProgress?: (sent: number, total: number) => void}} [options] - upload options.
	 * @returns {Promise<{remotePath: string, bytes: number, method: "create"|"sliced"}>} upload result.
	 */
	async upload(localPath, remoteDir, options = {}) {
		const stat = await fsp.stat(localPath);
		if (!stat.isFile()) throw new ZSpaceError("ENOTFILE", `本地路径不是文件：${localPath}`);
		const name = options.name || path.basename(localPath);
		const target = joinRemote(remoteDir, name);

		if (stat.size > this.smallUploadMaxBytes) {
			await this.uploadSliced(localPath, target, stat.size, stat, options.onProgress);
			return { remotePath: target, bytes: stat.size, method: "sliced" };
		}
		try {
			const response = await this.send({
				method: "POST",
				endpoint: "/v2/file/create",
				headers: { "Content-Type": "application/octet-stream", path: percentEncode(target) },
				filePath: localPath,
			});
			this.parse(response, "/v2/file/create");
			options.onProgress?.(stat.size, stat.size);
			return { remotePath: target, bytes: stat.size, method: "create" };
		} catch (error) {
			if (error instanceof ZSpaceError && error.code === "HTTP413") {
				await this.uploadSliced(localPath, target, stat.size, stat, options.onProgress);
				return { remotePath: target, bytes: stat.size, method: "sliced" };
			}
			throw error;
		}
	}

	/**
	 * Sliced upload (`/v2/file/upload`), the protocol the desktop client uses
	 * for anything the local proxy will not pass through in one request.
	 *
	 * @param {string} localPath - local file.
	 * @param {string} target - absolute remote file path.
	 * @param {number} total - total byte size.
	 * @param {import("node:fs").Stats} stat - local file stat.
	 * @param {(sent: number, total: number) => void} [onProgress] - progress callback.
	 * @returns {Promise<void>} resolves when the last slice was accepted.
	 */
	async uploadSliced(localPath, target, total, stat, onProgress) {
		const creds = this.credentials;
		const mtimeMs = Math.ceil(stat.mtimeMs);
		const uuid = crypto.createHash("md5").update(`${mtimeMs + total}${target}`).digest("hex");
		const modifyTime = Math.ceil(mtimeMs / 1000);
		const handle = await fsp.open(localPath, "r");
		try {
			let sent = 0;
			while (sent < total) {
				const length = Math.min(this.sliceSize, total - sent);
				const buffer = Buffer.alloc(length);
				await handle.read(buffer, 0, length, sent);
				const params = {
					app: "file",
					path: percentEncode(target),
					size: total,
					uuid,
					seek: sent,
					crtime: "",
					modify_time: modifyTime,
					rename: 0,
					token: percentEncode(creds.token),
					plat: "pc",
					nasid: creds.nasId,
					version: creds.appVersion,
					device_id: creds.deviceId,
					device: percentEncode(creds.device),
					"request-purpose": 4,
					"remote-port": 8050,
					split: 1,
				};
				const headers = Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value)]));
				headers.Cookie = Object.entries(params)
					.map(([key, value]) => `${key === "nasid" ? "nas_id" : key}=${percentEncode(value)}`)
					.join("; ");
				headers["Content-Type"] = "application/octet-stream";
				headers["Content-Length"] = String(length);
				const url = `${this.baseUrl}/v2/file/upload?remote_port=8050&drnd=${Date.now()}&uuid=${uuid}`;
				await this.retrying(
					async () => {
						const response = await this.send({ method: "POST", url, headers, body: buffer });
						this.parse(response, "/v2/file/upload");
					},
					error => !(error instanceof ZSpaceError && UPLOAD_FATAL_CODES.has(error.code)),
				);
				sent += length;
				onProgress?.(sent, total);
			}
		} finally {
			await handle.close();
		}
	}
}
