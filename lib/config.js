/**
 * Plugin configuration: the schema the host validates against, the code-side
 * defaults (so direct construction works without the loader), and the bounds
 * check that fails at load time instead of at the first tool call.
 *
 * @module dsh-zspace/config
 */

import z from "@deepseek-ai/schemastery";

import { DEFAULT_API_VERSION, DEFAULT_BASE_URL } from "./auth.js";

/**
 * Code-side defaults.
 *
 * The Cordis loader already applies `Config`'s defaults, but `apply` is also
 * reachable through direct construction (tests, tooling), so the plugin
 * resolves its own defaults instead of trusting the caller.
 *
 * @type {Record<string, any>}
 */
const DEFAULTS = Object.freeze({
	baseUrl: DEFAULT_BASE_URL,
	configDir: "",
	apiVersion: DEFAULT_API_VERSION,
	homePath: "",
	publicPath: "",
	downloadDir: "",
	readMaxBytes: 262_144,
	writeMaxBytes: 5 * 1024 * 1024,
	listMaxEntries: 2000,
	timeoutMs: 60_000,
	maxRetries: 2,
	smallUploadMaxBytes: 8 * 1024 * 1024,
	sliceSize: 2 * 1024 * 1024,
	transportMode: "auto",
	webdavUrl: "",
	webdavUser: "",
	webdavPassword: "",
	webdavHomePath: "/",
	webdavPublicPath: "",
	webdavProbeTimeoutMs: 1500,
	promptEnabled: true,
	promptOrder: 60,
});

export const Config = z.object({
	/** Desktop client local proxy. */
	baseUrl: z.string().default(DEFAULT_BASE_URL),
	/** Explicit directory holding `vuex.json`; empty means auto-detect. */
	configDir: z.string().default(""),
	/** NAS web API version sent as the `version` parameter. */
	apiVersion: z.string().default(DEFAULT_API_VERSION),
	/** Personal-space root override; empty means discover from storage pools. */
	homePath: z.string().default(""),
	/** Public-space root override; empty means discover from storage pools. */
	publicPath: z.string().default(""),
	/** Default local directory for downloads; empty means `~/Downloads/zspace`. */
	downloadDir: z.string().default(""),
	/** Byte cap for `zspace_read`. */
	readMaxBytes: z.natural().default(262_144),
	/** Byte cap for `zspace_write` text content (bigger writes belong in `zspace_upload`). */
	writeMaxBytes: z.natural().default(5 * 1024 * 1024),
	/** Entry ceiling for one listing/tree call. */
	listMaxEntries: z.natural().default(2000),
	/** Per-request timeout in milliseconds. */
	timeoutMs: z.natural().default(60_000),
	/** Retries for transient transport/5xx failures. */
	maxRetries: z.natural().default(2),
	/** Files above this size upload with the sliced protocol. */
	smallUploadMaxBytes: z.natural().default(8 * 1024 * 1024),
	/** Slice size for the sliced upload protocol (NAS remote mode caps at 2 MB). */
	sliceSize: z.natural().default(2 * 1024 * 1024),
	/** Transport preference: `auto` (LAN WebDAV when reachable), `webdav`, or `relay`. */
	transportMode: z.string().default("auto"),
	/** WebDAV base URL, e.g. `http://<nas-ip>:5005/`; empty disables the fast path. */
	webdavUrl: z.string().default(""),
	/** WebDAV user (the NAS account). The password belongs in `ZS_WEBDAV_PASSWORD`, not here. */
	webdavUser: z.string().default(""),
	/** WebDAV password fallback; prefer the `ZS_WEBDAV_PASSWORD` environment variable. */
	webdavPassword: z.string().default(""),
	/** DAV path that maps to the personal space (default `/` = WebDAV root). */
	webdavHomePath: z.string().default("/"),
	/** DAV path that maps to the public space; empty means it is not exposed over WebDAV. */
	webdavPublicPath: z.string().default(""),
	/** LAN probe timeout in milliseconds. */
	webdavProbeTimeoutMs: z.natural().default(1500),
	/** Whether to contribute the NAS guide to the system prompt. */
	promptEnabled: z.boolean().default(true),
	/** Ordering of that section. */
	promptOrder: z.natural().default(60),
});

/**
 * Merge caller config over the defaults, ignoring explicit `undefined`.
 *
 * @param {Record<string, any>|undefined} config - caller config.
 * @returns {Record<string, any>} effective config.
 */
export function resolveConfig(config) {
	const given = Object.fromEntries(Object.entries(config ?? {}).filter(([, value]) => value !== undefined));
	return { ...DEFAULTS, ...given };
}

/**
 * Reject unusable configuration at load time instead of at the first tool call.
 *
 * @param {Record<string, any>} config - schema-validated config.
 * @throws {Error} when a numeric bound is not a positive integer.
 */
export function validateConfig(config) {
	const bounds = [
		["readMaxBytes", config.readMaxBytes],
		["writeMaxBytes", config.writeMaxBytes],
		["listMaxEntries", config.listMaxEntries],
		["timeoutMs", config.timeoutMs],
		["maxRetries", config.maxRetries],
		["smallUploadMaxBytes", config.smallUploadMaxBytes],
		["sliceSize", config.sliceSize],
		["webdavProbeTimeoutMs", config.webdavProbeTimeoutMs],
		["promptOrder", config.promptOrder],
	];
	for (const [field, value] of bounds) {
		if (!Number.isInteger(value) || value < 0 || (field !== "maxRetries" && value < 1)) {
			throw new Error(`zspace: 配置项 ${field}=${value} 必须是非负整数（maxRetries 可为 0，其余至少为 1）`);
		}
	}
	if (!["auto", "webdav", "relay"].includes(config.transportMode)) {
		throw new Error(`zspace: transportMode=${config.transportMode} 必须是 auto / webdav / relay 之一`);
	}
	if (config.transportMode === "webdav" && !config.webdavUrl) {
		throw new Error("zspace: transportMode=webdav 时必须配置 webdavUrl");
	}
	if (config.webdavUrl && !/^https?:\/\//.test(config.webdavUrl)) {
		throw new Error(`zspace: webdavUrl 必须以 http:// 或 https:// 开头（当前 ${config.webdavUrl}）`);
	}
	if (!config.webdavHomePath.startsWith("/")) {
		throw new Error(`zspace: webdavHomePath 必须以 / 开头（当前 ${config.webdavHomePath}）`);
	}
	if (!/^https?:\/\//.test(config.baseUrl)) {
		throw new Error(`zspace: baseUrl 必须以 http:// 或 https:// 开头（当前 ${config.baseUrl}）`);
	}
}
