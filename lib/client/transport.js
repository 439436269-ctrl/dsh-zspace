/**
 * HTTP transport to the desktop-client proxy: URL shaping, form encoding, retries, response validation.
 *
 * @module dsh-zspace/client
 */

import fsp from "node:fs/promises";
import fs from "node:fs";
import https from "node:https";
import http from "node:http";
import { ZSpaceError } from "./errors.js";

const FORM_TYPE = "application/x-www-form-urlencoded";

export const DEFAULT_PAGE_SIZE = 50;

/** Network errno values worth a retry; a down client is not among them. */
const RETRYABLE_ERRNOS = new Set(["ECONNRESET", "ETIMEDOUT", "EPIPE", "EAI_AGAIN", "ENETUNREACH"]);

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
export function percentEncode(value) {
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
export async function readStream(stream, maxBytes = Number.POSITIVE_INFINITY) {
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
 * Build an endpoint URL with the mandatory random query suffix.
 *
 * @param {string} endpoint - API path, e.g. `/v2/file/list`.
 * @param {Record<string, unknown>} [query] - extra query values.
 * @returns {string} absolute URL.
 */
export function endpointUrl(client, endpoint, query) {
	let url = `${client.baseUrl}${endpoint}?&rnd=${randomToken()}&webagent=v2`;
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
export function formBody(client, fields) {
	const parts = [];
	for (const [key, value] of Object.entries({ ...client.commonParams(), ...fields })) {
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
export async function retrying(client, attempt, shouldRetry) {
	let lastError;
	for (let index = 0; index <= client.maxRetries; index += 1) {
		try {
			return await attempt();
		} catch (error) {
			lastError = error;
			if (index >= client.maxRetries || !shouldRetry(error)) throw error;
			await new Promise(resolve => setTimeout(resolve, Math.min(client.retryDelayMs * 2 ** index, 2000)));
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
export async function send(client, options) {
	const attempt = async () => {
		const url = options.url ?? client.endpointUrl(options.endpoint, options.query);
		const headers = { ...client.authHeaders(), ...(options.headers ?? {}) };
		let payload;
		if (options.form !== undefined || options.fields !== undefined) {
			payload = Buffer.from(
				options.form !== undefined
					? client.formBody(options.form)
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
			request.setTimeout(options.timeoutMs ?? client.timeoutMs, () => {
				request.destroy(new ZSpaceError("ETIMEDOUT", `请求超时（${options.endpoint ?? options.url}）`));
			});
			request.on("error", (error) => {
				if (error instanceof ZSpaceError) {
					reject(error);
					return;
				}
				reject(
					new ZSpaceError("EPROXY", `无法访问极空间桌面客户端代理 ${client.baseUrl}：${error.message}`, {
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

	return await client.retrying(attempt, error => {
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
export function parse(client, response, endpoint) {
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
export async function post(client, endpoint, fields) {
	const response = await client.send({ method: "POST", endpoint, form: fields ?? {} });
	return client.parse(response, endpoint);
}

// ── connectivity and spaces ──────────────────────────────────────────────

/**
 * Probe the desktop client proxy.
 *
 * @returns {Promise<boolean>} true when the proxy answers below 500.
 */
