/**
 * dsh-zspace — 极空间 (ZSpace) NAS tools for DeepSeek Harness.
 *
 * Cross-network by construction: every call rides the desktop client's local
 * proxy, which relays to the NAS over 极空间's cloud/P2P channel. No LAN
 * address, no DDNS, no WebDAV, no SSH, no Python.
 *
 * This module is the thin host adapter: it validates config, owns the client
 * lifecycle, contributes one system-prompt section, and converts the plain
 * tool specs from `./tools.js` into registered host tools.
 *
 * @module dsh-zspace
 */

import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";

import { DEFAULT_API_VERSION, DEFAULT_BASE_URL } from "./auth.js";
import { ZSpaceClient } from "./client.js";
import { createToolSpecs } from "./tools.js";

export const name = "zspace";

export const inject = ["tools", "systemPrompt"];

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
	/** Whether to contribute the NAS guide to the system prompt. */
	promptEnabled: z.boolean().default(true),
	/** Ordering of that section. */
	promptOrder: z.natural().default(60),
});

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
	listMaxEntries: 2000,
	timeoutMs: 60_000,
	maxRetries: 2,
	smallUploadMaxBytes: 8 * 1024 * 1024,
	sliceSize: 2 * 1024 * 1024,
	promptEnabled: true,
	promptOrder: 60,
});

/**
 * Merge caller config over the defaults, ignoring explicit `undefined`.
 *
 * @param {Record<string, any>|undefined} config - caller config.
 * @returns {Record<string, any>} effective config.
 */
function resolveConfig(config) {
	const given = Object.fromEntries(Object.entries(config ?? {}).filter(([, value]) => value !== undefined));
	return { ...DEFAULTS, ...given };
}

/**
 * Reject unusable configuration at load time instead of at the first tool call.
 *
 * @param {Record<string, any>} config - schema-validated config.
 * @throws {Error} when a numeric bound is not a positive integer.
 */
function validateConfig(config) {
	const bounds = [
		["readMaxBytes", config.readMaxBytes],
		["listMaxEntries", config.listMaxEntries],
		["timeoutMs", config.timeoutMs],
		["maxRetries", config.maxRetries],
		["smallUploadMaxBytes", config.smallUploadMaxBytes],
		["sliceSize", config.sliceSize],
		["promptOrder", config.promptOrder],
	];
	for (const [field, value] of bounds) {
		if (!Number.isInteger(value) || value < 0 || (field !== "maxRetries" && value < 1)) {
			throw new Error(`zspace: 配置项 ${field}=${value} 必须是非负整数（maxRetries 可为 0，其余至少为 1）`);
		}
	}
	if (!/^https?:\/\//.test(config.baseUrl)) {
		throw new Error(`zspace: baseUrl 必须以 http:// 或 https:// 开头（当前 ${config.baseUrl}）`);
	}
}

/**
 * The system-prompt section describing the NAS and its path conveniences.
 *
 * @param {Record<string, any>} config - plugin config.
 * @returns {string} guide text.
 */
function guideText(config) {
	const down = config.downloadDir || "~/Downloads/zspace";
	return [
		"### 极空间 NAS（dsh-zspace）",
		"已通过极空间桌面客户端的本地代理接入这台 NAS，**跨网络可用**（不需要同一局域网、WebDAV 或 SSH，仅要求本机桌面客户端保持登录）。",
		"- 远程路径写法：`home:`＝个人空间根、`public:`＝公共空间根、相对路径＝相对个人空间、以 `/` 开头＝NAS 绝对路径；两个根的真实位置先跑 `zspace_status` 查看。",
		"- 只读：`zspace_ls`（支持 depth 递归）、`zspace_stat`、`zspace_find`（按名称在目录树里遍历查找，受 depth/scanLimit 预算限制，结果里会报告扫了多少项）、`zspace_read`（小文本读入上下文）、`zspace_download`（下载到本机，默认 " +
			down +
			"）。",
		"- 写入：`zspace_upload`（大文件自动分片、支持中文名）、`zspace_mkdir`、`zspace_rename`、`zspace_move`、`zspace_copy`、`zspace_remove`（进回收站，必须显式 confirm=true）。",
		"- 删除/移动/重命名属于破坏性操作：先用 `zspace_ls` 或 `zspace_stat` 核实目标，再执行；批量删除前先向用户确认。",
	].join("\n");
}

/**
 * Mount the plugin: own the client lifecycle, add the guide section, register
 * every tool.
 *
 * @param {import("@deepseek-ai/cordis").Context} ctx - plugin context.
 * @param {Record<string, any>} config - validated config.
 * @returns {void}
 */
export function apply(ctx, config) {
	const settings = resolveConfig(config);
	validateConfig(settings);

	/** @type {ZSpaceClient|undefined} */
	let client;
	ctx.effect(() => {
		client = new ZSpaceClient({
			baseUrl: settings.baseUrl,
			configDir: settings.configDir || undefined,
			apiVersion: settings.apiVersion,
			homePath: settings.homePath,
			publicPath: settings.publicPath,
			timeoutMs: settings.timeoutMs,
			maxRetries: settings.maxRetries,
			listMaxEntries: settings.listMaxEntries,
			smallUploadMaxBytes: settings.smallUploadMaxBytes,
			sliceSize: settings.sliceSize,
		});
		return () => {
			client = undefined;
		};
	});

	/**
	 * The live client, or a loud failure — reached only while the fiber is active.
	 *
	 * @returns {ZSpaceClient} live client.
	 */
	const getClient = () => {
		if (!client) throw new Error("zspace: client is not available");
		return client;
	};

	if (settings.promptEnabled) {
		ctx.systemPrompt.section({
			name: "zspace:guide",
			order: settings.promptOrder,
			text: () => guideText(settings),
		});
	}

	for (const spec of createToolSpecs({ getClient, config: settings })) {
		ctx.tools.register(
			defineTool({
				name: spec.name,
				description: spec.description,
				parameters: spec.parameters,
				output: {
					schema: spec.outputSchema,
					render: spec.render,
					...(spec.presentationMeta ? { presentationMeta: spec.presentationMeta } : {}),
				},
				...(spec.call ? { presentCall: spec.call } : {}),
				execute: spec.execute,
			}),
		);
	}
}
