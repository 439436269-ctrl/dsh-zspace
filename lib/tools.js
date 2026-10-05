/**
 * Tool specs for the ZSpace plugin.
 *
 * This module is deliberately free of `@deepseek-ai/*` imports: it describes
 * each tool as data (`parameters` / `outputSchema` in the DSH spec form) plus
 * an `execute`, so the whole tool layer stays unit-testable under plain Node.
 * `lib/index.js` is the thin adapter that turns these specs into host tools.
 *
 * @module dsh-zspace/tools
 */

import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { humanSize, joinRemote } from "./format.js";

/** Remote path prefixes users can type instead of an absolute NAS path. */
const HOME_PREFIXES = ["home:", "my:", "个人空间:"];
const PUBLIC_PREFIXES = ["public:", "share:", "公共空间:"];

/**
 * Collapse redundant slashes and strip a trailing slash (except for root).
 *
 * @param {string} remotePath - raw remote path.
 * @returns {string} normalized path.
 */
export function normalizeRemote(remotePath) {
	const collapsed = String(remotePath).replace(/\/{2,}/g, "/");
	if (collapsed.length > 1 && collapsed.endsWith("/")) return collapsed.replace(/\/+$/, "");
	return collapsed;
}

/**
 * Build the remote-path resolver for one plugin instance.
 *
 * Accepted forms:
 * - empty / omitted → personal-space root
 * - `home:` / `my:` → personal space
 * - `public:` / `share:` → public space
 * - a relative path → resolved against the personal space
 * - an absolute `/...` path → used as-is
 *
 * @param {{client: import("./client.js").ZSpaceClient}} context - plugin context.
 * @returns {(input?: string) => Promise<string>} resolver.
 */
export function createResolver({ client }) {
	return async (input) => {
		const raw = String(input ?? "").trim();
		if (raw === "") return await client.homePath();
		if (raw.startsWith("/")) return normalizeRemote(raw);
		for (const prefix of HOME_PREFIXES) {
			if (raw.toLowerCase().startsWith(prefix)) {
				return normalizeRemote(joinRemote(await client.homePath(), raw.slice(prefix.length)));
			}
		}
		for (const prefix of PUBLIC_PREFIXES) {
			if (raw.toLowerCase().startsWith(prefix)) {
				return normalizeRemote(joinRemote(await client.publicPath(), raw.slice(prefix.length)));
			}
		}
		return normalizeRemote(joinRemote(await client.homePath(), raw));
	};
}

/**
 * Clamp a numeric argument.
 *
 * @param {unknown} value - candidate value.
 * @param {number} fallback - default when absent/invalid.
 * @param {number} min - lower bound.
 * @param {number} max - upper bound.
 * @returns {number} clamped integer.
 */
function clampInt(value, fallback, min, max) {
	const numeric = Number(value);
	if (!Number.isFinite(numeric)) return fallback;
	return Math.min(Math.max(Math.trunc(numeric), min), max);
}

/**
 * Resolve a local path argument.
 *
 * The plugin runs inside the DSH host process, so a relative path resolves
 * against that process's working directory — **not** the agent's session
 * workspace. `~/` is expanded so a model can still say `~/Downloads`.
 *
 * @param {unknown} input - caller-provided path.
 * @returns {string} absolute local path ("" for blank input).
 */
function expandLocalPath(input) {
	const raw = String(input ?? "").trim();
	if (raw === "") return "";
	if (raw === "~") return os.homedir();
	if (raw.startsWith("~/")) return path.join(os.homedir(), raw.slice(2));
	return path.resolve(raw);
}

/**
 * Format one entry as a listing line.
 *
 * @param {Record<string, any>} entry - normalized entry (optionally with `depth`).
 * @param {boolean} [showDepth] - indent by `entry.depth`.
 * @returns {string} display line.
 */
function entryLine(entry, showDepth = false) {
	const indent = showDepth ? "  ".repeat(Number(entry.depth ?? 0)) : "";
	const size = entry.dir ? "" : `  ${humanSize(entry.size)}`;
	const when = entry.modified ? `  ${entry.modified}` : "";
	return `${indent}${entry.dir ? "📁" : "📄"} ${entry.name}${size}${when}`;
}

/**
 * Wrap a tool body so ZSpace failures carry their actionable hint.
 *
 * @param {() => Promise<any>} body - tool body.
 * @returns {Promise<any>} body result.
 */
async function guarded(body) {
	try {
		return await body();
	} catch (error) {
		const hint = /** @type {{hint?: string}} */ (error)?.hint;
		if (hint) throw new Error(`${error.message} — ${hint}`);
		throw error;
	}
}

/**
 * Recursively collect a directory listing up to `depth` levels.
 *
 * @param {object} options - walk options.
 * @param {import("./client.js").ZSpaceClient} options.client - NAS client.
 * @param {string} options.root - absolute remote directory.
 * @param {number} options.depth - remaining depth (1 = direct children).
 * @param {boolean} options.showHidden - include hidden entries.
 * @param {number} options.budget - entry ceiling.
 * @returns {Promise<{entries: Array<Record<string, any>>, truncated: boolean}>} flattened tree.
 */
async function walkDirectory({ client, root, depth, showHidden, budget }) {
	/** @type {Array<Record<string, any>>} */
	const collected = [];
	let truncated = false;

	/**
	 * @param {string} dir - directory to list.
	 * @param {number} level - current depth (0 for direct children of root).
	 * @returns {Promise<void>} resolves after the subtree is walked.
	 */
	async function visit(dir, level) {
		if (truncated || level >= depth) return;
		const { entries, truncated: pageTruncated } = await client.list(dir, {
			showHidden,
			maxEntries: Math.max(budget - collected.length, 1),
		});
		for (const entry of entries) {
			if (collected.length >= budget) {
				truncated = true;
				return;
			}
			// Trim to exactly the declared output fields: the host validates tool
			// output against the schema with `additionalProperties: false`.
			collected.push({
				name: entry.name,
				path: entry.path,
				dir: entry.dir,
				size: entry.size,
				modified: entry.modified,
				depth: level,
			});
			if (entry.dir && level + 1 < depth) await visit(entry.path, level + 1);
		}
		if (pageTruncated) truncated = true;
	}

	await visit(root, 0);
	return { entries: collected, truncated };
}

/**
 * Walk a directory tree and collect name matches.
 *
 * The NAS web layer's own search endpoint (`/file_search/file_search`) ignores
 * the keyword on current ZOS firmware — it answers the same 100 generic rows
 * for any query — so the plugin does an honest, bounded client-side walk
 * instead and reports exactly how much of the tree it saw.
 *
 * @param {object} options - search options.
 * @param {import("./client.js").ZSpaceClient} options.client - NAS client.
 * @param {string[]} options.roots - absolute directories to scan.
 * @param {string} options.keyword - case-insensitive name substring.
 * @param {number} options.depth - maximum recursion depth.
 * @param {number} options.limit - maximum matches.
 * @param {number} options.scanLimit - maximum entries to inspect.
 * @returns {Promise<{matches: Array<Record<string, any>>, scanned: number, truncated: boolean}>} matches.
 */
export async function findByName({ client, roots, keyword, depth, limit, scanLimit }) {
	const needle = keyword.toLowerCase();
	/** @type {Array<Record<string, any>>} */
	const matches = [];
	/** @type {Array<{dir: string, level: number}>} */
	const queue = roots.map(dir => ({ dir, level: 0 }));
	let scanned = 0;
	let truncated = false;

	while (queue.length > 0) {
		if (matches.length >= limit || scanned >= scanLimit) {
			truncated = true;
			break;
		}
		const { dir, level } = queue.shift();
		let listing;
		try {
			listing = await client.list(dir, { maxEntries: Math.max(scanLimit - scanned, 1) });
		} catch {
			// Unreadable directory (permissions, removed mid-walk): skip it.
			continue;
		}
		if (listing.truncated) truncated = true;
		for (const entry of listing.entries) {
			if (scanned >= scanLimit || matches.length >= limit) {
				truncated = true;
				break;
			}
			scanned += 1;
			if (entry.name.toLowerCase().includes(needle)) {
				matches.push({
					name: entry.name,
					path: entry.path,
					dir: entry.dir,
					size: entry.size,
					modified: entry.modified,
				});
			}
			if (entry.dir && level + 1 < depth) queue.push({ dir: entry.path, level: level + 1 });
		}
	}
	return { matches, scanned, truncated };
}

/**
 * Build every tool spec for one plugin instance.
 *
 * @param {object} context - plugin context.
 * @param {() => import("./client.js").ZSpaceClient} context.getClient - live client accessor.
 * @param {object} context.config - plugin config.
 * @param {string} context.promptGuide - guide text shared with the model.
 * @returns {Array<Record<string, any>>} tool specs.
 */
export function createToolSpecs({ getClient, config }) {
	const resolve = (input) => createResolver({ client: getClient() })(input);

	/**
	 * Default local directory for downloads.
	 *
	 * @returns {string} absolute local directory.
	 */
	function downloadDir() {
		return config.downloadDir || path.join(os.homedir(), "Downloads", "zspace");
	}

	return [
		{
			name: "zspace_status",
			description:
				"Check the 极空间 / ZSpace NAS link behind this plugin. Probes the desktop client's local proxy, resolves the personal-space and public-space roots, reports storage pools with free space, and lists both roots once. Run it first when another zspace_* tool fails, or to confirm cross-network access (no LAN/WebDAV/SSH needed).",
			parameters: {},
			outputSchema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: { type: "boolean", required: true },
					baseUrl: { type: "string", required: true },
					username: { type: "string", required: true },
					nasId: { type: "string", required: true },
					homePath: { type: "string", required: true },
					publicPath: { type: "string", required: true },
					homeEntries: { type: "integer", required: true },
					publicEntries: { type: "integer", required: true },
					pools: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								name: { type: "string", required: true },
								status: { type: "string", required: true },
								totalSize: { type: "integer", required: true },
								freeSize: { type: "integer", required: true },
							},
						},
					},
					message: { type: "string", required: true },
				},
			},
			call: { card: "generic", title: "zspace_status", kind: "execute" },
			render: (_args, value) => {
				if (!value.ok) return [{ type: "text", text: `极空间连接不可用：${value.message}` }];
				const pools = value.pools
					.map(pool => `  - ${pool.name}（${pool.status}）剩余 ${humanSize(pool.freeSize)} / 共 ${humanSize(pool.totalSize)}`)
					.join("\n");
				return [
					{
						type: "text",
						text: [
							`极空间在线：${value.username || "(未知账号)"} @ ${value.nasId}，代理 ${value.baseUrl}`,
							`个人空间 ${value.homePath}（${value.homeEntries} 项）`,
							`公共空间 ${value.publicPath}（${value.publicEntries} 项）`,
							pools ? `存储池：\n${pools}` : "存储池：未获取到",
						].join("\n"),
					},
				];
			},
			execute: () =>
				guarded(async () => {
					const client = getClient();
					const baseUrl = client.baseUrl;
					const proxy = await client.check();
					if (!proxy) {
						return {
							ok: false,
							baseUrl,
							username: "",
							nasId: "",
							homePath: "",
							publicPath: "",
							homeEntries: 0,
							publicEntries: 0,
							pools: [],
							message: `连不上极空间桌面客户端本地代理 ${baseUrl}：请确认桌面客户端已安装、已登录并在运行（跨网络访问也依赖它做云中转）。`,
						};
					}
					const identity = client.identity;
					const safe = async (body, fallback) => {
						try {
							return { value: await body(), error: "" };
						} catch (error) {
							return { value: fallback, error: error.message };
						}
					};
					const pools = await safe(() => client.pools(), []);
					const home = await safe(async () => {
						const root = await client.homePath();
						const listing = await client.list(root, { maxEntries: config.listMaxEntries });
						return { root, count: listing.entries.length };
					}, { root: "", count: 0 });
					const publicSpace = await safe(async () => {
						const root = await client.publicPath();
						const listing = await client.list(root, { maxEntries: config.listMaxEntries });
						return { root, count: listing.entries.length };
					}, { root: "", count: 0 });
					const problems = [pools.error, home.error, publicSpace.error].filter(Boolean);
					return {
						ok: home.error === "" || publicSpace.error === "",
						baseUrl,
						username: identity.username,
						nasId: identity.nasId,
						homePath: home.value.root,
						publicPath: publicSpace.value.root,
						homeEntries: home.value.count,
						publicEntries: publicSpace.value.count,
						pools: pools.value,
						message: problems.length === 0 ? "正常" : problems.join("；"),
					};
				}),
		},
		{
			name: "zspace_ls",
			description:
				"List a 极空间 / ZSpace NAS directory (跨网络可用). `path` accepts an absolute NAS path, `home:` / `public:` prefixes, or a path relative to the personal space; omit it for the personal-space root. Set `depth` > 1 to walk a subtree. Large directories are paged automatically.",
			parameters: {
				path: { type: "string", description: "Remote directory. Absolute (/sata1/my/data/…), home:/…, public:/…, or relative to the personal space. Omit for the personal-space root." },
				depth: { type: "integer", description: "How many levels to list, 1-6 (default 1)." },
				showHidden: { type: "boolean", description: "Include hidden entries (default false)." },
				limit: { type: "integer", description: `Maximum entries to return (default 200, cap ${config.listMaxEntries}).` },
			},
			outputSchema: {
				type: "object",
				additionalProperties: false,
				properties: {
					root: { type: "string", required: true },
					entries: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								name: { type: "string", required: true },
								path: { type: "string", required: true },
								dir: { type: "boolean", required: true },
								size: { type: "integer", required: true },
								modified: { type: "string", required: true },
								depth: { type: "integer", required: true },
							},
						},
					},
					count: { type: "integer", required: true },
					truncated: { type: "boolean", required: true },
				},
			},
			call: (args) => ({ card: "generic", title: `zspace_ls ${args.path ?? "home:"}`, kind: "search" }),
			render: (_args, value) => {
				const lines = value.entries.map(entry => entryLine(entry, true));
				const tail = value.truncated ? `\n… 结果被截断（只显示前 ${value.count} 项，可提高 limit 或缩小范围）` : "";
				return [
					{
						type: "text",
						text: `${value.root}（${value.count} 项）\n${lines.join("\n") || "(空目录)"}${tail}`,
					},
				];
			},
			presentationMeta: (_args, value) => ({ count: value.count }),
			execute: (args) =>
				guarded(async () => {
					const client = getClient();
					const root = await resolve(args.path);
					const depth = clampInt(args.depth, 1, 1, 6);
					const budget = clampInt(args.limit, 200, 1, config.listMaxEntries);
					const { entries, truncated } = await walkDirectory({
						client,
						root,
						depth,
						showHidden: args.showHidden === true,
						budget,
					});
					return { root, entries, count: entries.length, truncated };
				}),
		},
		{
			name: "zspace_stat",
			description:
				"Show metadata (type, size, modified/created time) for one 极空间 / ZSpace path, without downloading it.",
			parameters: {
				path: { type: "string", required: true, description: "Remote file or directory (absolute, home:/, public:/, or relative to the personal space)." },
			},
			outputSchema: {
				type: "object",
				additionalProperties: false,
				properties: {
					name: { type: "string", required: true },
					path: { type: "string", required: true },
					dir: { type: "boolean", required: true },
					size: { type: "integer", required: true },
					modified: { type: "string", required: true },
					created: { type: "string", required: true },
					ext: { type: "string", required: true },
				},
			},
			call: (args) => ({ card: "generic", title: `zspace_stat ${args.path}`, kind: "search" }),
			render: (_args, value) => [
				{
					type: "text",
					text: [
						`${value.dir ? "📁" : "📄"} ${value.name}`,
						`路径：${value.path}`,
						value.dir ? "类型：目录" : `大小：${humanSize(value.size)}（${value.size} 字节）`,
						value.modified ? `修改：${value.modified}` : "",
						value.created ? `创建：${value.created}` : "",
					]
						.filter(Boolean)
						.join("\n"),
				},
			],
			execute: (args) =>
				guarded(async () => {
					const client = getClient();
					const target = await resolve(args.path);
					return await client.info(target);
				}),
		},
		{
			name: "zspace_find",
			description:
				"Find files or folders by name inside the 极空间 / ZSpace tree (case-insensitive substring). It scans directories, so it is bounded: pass `path` to narrow the search, and raise `depth` / `scanLimit` when you need more coverage. The result reports how many entries were inspected and whether the scan stopped early — always mention that when reporting a negative result.",
			parameters: {
				keyword: { type: "string", required: true, description: "Name fragment to look for (case-insensitive)." },
				path: { type: "string", description: "Directory to scan (absolute, home:/, public:/, or relative). Default: scan both the personal space and the public space." },
				depth: { type: "integer", description: "Maximum recursion depth, 1-8 (default 4)." },
				limit: { type: "integer", description: "Maximum matches to return, 1-500 (default 50)." },
				scanLimit: { type: "integer", description: "Maximum entries to inspect, 1-20000 (default 2000)." },
			},
			outputSchema: {
				type: "object",
				additionalProperties: false,
				properties: {
					keyword: { type: "string", required: true },
					roots: { type: "array", required: true, items: { type: "string" } },
					matches: {
						type: "array",
						required: true,
						items: {
							type: "object",
							additionalProperties: false,
							properties: {
								name: { type: "string", required: true },
								path: { type: "string", required: true },
								dir: { type: "boolean", required: true },
								size: { type: "integer", required: true },
								modified: { type: "string", required: true },
							},
						},
					},
					scanned: { type: "integer", required: true },
					truncated: { type: "boolean", required: true },
				},
			},
			call: (args) => ({ card: "generic", title: `zspace_find ${args.keyword}`, kind: "search" }),
			render: (_args, value) => {
				const scope = value.roots.join("、");
				const tail = value.truncated ? `（已扫 ${value.scanned} 项后停止，结果可能不完整）` : `（已扫 ${value.scanned} 项）`;
				return [
					{
						type: "text",
						text:
							value.matches.length === 0
								? `在 ${scope} 中没有找到名称含「${value.keyword}」的文件 ${tail}`
								: `${value.matches.map(entry => entryLine(entry)).join("\n")}\n共 ${value.matches.length} 项，范围 ${scope} ${tail}`,
					},
				];
			},
			execute: (args) =>
				guarded(async () => {
					const client = getClient();
					const keyword = String(args.keyword ?? "").trim();
					if (keyword === "") throw new Error("zspace_find: `keyword` must not be blank");
					const roots = args.path ? [await resolve(args.path)] : [await client.homePath(), await client.publicPath()];
					const { matches, scanned, truncated } = await findByName({
						client,
						roots,
						keyword,
						depth: clampInt(args.depth, 4, 1, 8),
						limit: clampInt(args.limit, 50, 1, 500),
						scanLimit: clampInt(args.scanLimit, 2000, 1, 20_000),
					});
					return { keyword, roots, matches, scanned, truncated };
				}),
		},
		{
			name: "zspace_read",
			description:
				"Read the beginning of a small remote text file into context (default cap 256 KB). Use zspace_download for anything large or binary.",
			parameters: {
				path: { type: "string", required: true, description: "Remote file path." },
				maxBytes: { type: "integer", description: `Byte cap (default ${config.readMaxBytes}, hard cap ${config.readMaxBytes}).` },
			},
			outputSchema: {
				type: "object",
				additionalProperties: false,
				properties: {
					path: { type: "string", required: true },
					bytes: { type: "integer", required: true },
					truncated: { type: "boolean", required: true },
					binary: { type: "boolean", required: true },
					content: { type: "string", required: true },
				},
			},
			call: (args) => ({ card: "generic", title: `zspace_read ${args.path}`, kind: "search" }),
			render: (_args, value) => [
				{
					type: "text",
					text: value.binary
						? `${value.path}：看起来是二进制文件（${value.bytes} 字节），未按文本渲染。可用 zspace_download 取到本地处理。`
						: `${value.path}${value.truncated ? `（已截断到 ${value.bytes} 字节）` : ""}：\n${value.content}`,
				},
			],
			execute: (args) =>
				guarded(async () => {
					const client = getClient();
					const target = await resolve(args.path);
					const maxBytes = clampInt(args.maxBytes, config.readMaxBytes, 1, config.readMaxBytes);
					const { buffer, truncated, bytes } = await client.readFile(target, { maxBytes });
					const binary = buffer.includes(0);
					return {
						path: target,
						bytes,
						truncated,
						binary,
						content: binary ? "" : buffer.toString("utf8"),
					};
				}),
		},
		{
			name: "zspace_download",
			description:
				"Download one file from the 极空间 / ZSpace NAS to this machine (跨网络可用). Returns the absolute local path. Default local directory: " +
				`${config.downloadDir || "~/Downloads/zspace"}.`,
			parameters: {
				path: { type: "string", required: true, description: "Remote file path." },
				dir: { type: "string", description: "Local destination directory. Pass an absolute path or `~/…` (a plain relative path resolves against the DSH host process directory). Default: the configured download directory." },
				name: { type: "string", description: "Local file name override (default: the remote base name)." },
			},
			outputSchema: {
				type: "object",
				additionalProperties: false,
				properties: {
					remotePath: { type: "string", required: true },
					localPath: { type: "string", required: true },
					bytes: { type: "integer", required: true },
				},
			},
			call: (args) => ({ card: "generic", title: `zspace_download ${args.path}`, kind: "edit" }),
			render: (_args, value) => [
				{ type: "text", text: `已下载 ${value.remotePath} → ${value.localPath}（${humanSize(value.bytes)}）` },
			],
			execute: (args) =>
				guarded(async () => {
					const client = getClient();
					const target = await resolve(args.path);
					const localDir = expandLocalPath(args.dir) || downloadDir();
					const result = await client.download(target, localDir, { name: args.name });
					return { remotePath: target, localPath: result.localPath, bytes: result.bytes };
				}),
		},
		{
			name: "zspace_upload",
			description:
				"Upload one local file to the 极空间 / ZSpace NAS (跨网络可用). Small files go in one request; larger ones automatically use the desktop client's sliced upload protocol. Chinese file names are supported.",
			parameters: {
				localPath: {
					type: "string",
					required: true,
					description:
						"Local file to upload. Pass an absolute path or `~/…` — the plugin resolves plain relative paths against the DSH host process directory, not the agent workspace.",
				},
				remoteDir: { type: "string", description: "Remote destination directory (default: the personal-space root)." },
				name: { type: "string", description: "Remote file name override (default: the local base name)." },
			},
			outputSchema: {
				type: "object",
				additionalProperties: false,
				properties: {
					localPath: { type: "string", required: true },
					remotePath: { type: "string", required: true },
					bytes: { type: "integer", required: true },
					method: { type: "string", required: true },
				},
			},
			call: (args) => ({ card: "generic", title: `zspace_upload ${args.localPath}`, kind: "edit" }),
			render: (_args, value) => [
				{
					type: "text",
					text: `已上传 ${value.localPath} → ${value.remotePath}（${humanSize(value.bytes)}，${value.method === "sliced" ? "分片" : "单请求"}）`,
				},
			],
			execute: (args) =>
				guarded(async () => {
					const client = getClient();
					const localPath = expandLocalPath(args.localPath);
					if (localPath === "") throw new Error("zspace_upload: `localPath` is required");
					await fsp.access(localPath).catch(() => {
						throw new Error(
							`zspace_upload: 本地文件不存在：${localPath}（相对路径按 DSH 宿主进程目录解析，建议传绝对路径或用 ~/ 开头）`,
						);
					});
					const remoteDir = await resolve(args.remoteDir);
					const result = await client.upload(localPath, remoteDir, { name: args.name });
					return { localPath, remotePath: result.remotePath, bytes: result.bytes, method: result.method };
				}),
		},
		{
			name: "zspace_mkdir",
			description: "Create one directory on the 极空间 / ZSpace NAS.",
			parameters: {
				path: { type: "string", required: true, description: "Remote directory to create (absolute, home:/, public:/, or relative to the personal space)." },
			},
			outputSchema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: { type: "boolean", required: true },
					path: { type: "string", required: true },
				},
			},
			call: (args) => ({ card: "generic", title: `zspace_mkdir ${args.path}`, kind: "edit" }),
			render: (_args, value) => [{ type: "text", text: `已创建目录 ${value.path}` }],
			execute: (args) =>
				guarded(async () => {
					const client = getClient();
					const target = await resolve(args.path);
					if (target === "/") throw new Error("zspace_mkdir: 不能创建根目录");
					await client.mkdir(target);
					return { ok: true, path: target };
				}),
		},
		{
			name: "zspace_rename",
			description: "Rename a file or directory in place on the 极空间 / ZSpace NAS.",
			parameters: {
				path: { type: "string", required: true, description: "Remote path to rename." },
				newName: { type: "string", required: true, description: "New base name only (no directory part)." },
			},
			outputSchema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: { type: "boolean", required: true },
					path: { type: "string", required: true },
					name: { type: "string", required: true },
				},
			},
			call: (args) => ({ card: "generic", title: `zspace_rename ${args.path}`, kind: "edit" }),
			render: (_args, value) => [{ type: "text", text: `已重命名 → ${value.name}（${value.path}）` }],
			execute: (args) =>
				guarded(async () => {
					const client = getClient();
					const target = await resolve(args.path);
					const newName = String(args.newName ?? "").trim();
					if (newName === "" || newName.includes("/")) {
						throw new Error("zspace_rename: `newName` 必须是纯文件名（不含 /）");
					}
					await client.rename(target, newName);
					return { ok: true, path: target, name: newName };
				}),
		},
		{
			name: "zspace_move",
			description: "Move files or directories into another directory on the 极空间 / ZSpace NAS.",
			parameters: {
				paths: { type: "array", required: true, items: { type: "string" }, description: "Source paths (absolute, home:/, public:/, or relative)." },
				to: { type: "string", required: true, description: "Destination directory." },
			},
			outputSchema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: { type: "boolean", required: true },
					count: { type: "integer", required: true },
					to: { type: "string", required: true },
				},
			},
			call: (args) => ({ card: "generic", title: `zspace_move ${(args.paths ?? []).length} 项`, kind: "edit" }),
			render: (_args, value) => [{ type: "text", text: `已移动 ${value.count} 项 → ${value.to}` }],
			execute: (args) =>
				guarded(async () => {
					const client = getClient();
					const sources = await Promise.all((args.paths ?? []).map(item => resolve(item)));
					if (sources.length === 0) throw new Error("zspace_move: `paths` must not be empty");
					const destination = await resolve(args.to);
					await client.move(sources, destination);
					return { ok: true, count: sources.length, to: destination };
				}),
		},
		{
			name: "zspace_copy",
			description: "Copy files or directories into another directory on the 极空间 / ZSpace NAS (server-side copy, no download).",
			parameters: {
				paths: { type: "array", required: true, items: { type: "string" }, description: "Source paths." },
				to: { type: "string", required: true, description: "Destination directory." },
			},
			outputSchema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: { type: "boolean", required: true },
					count: { type: "integer", required: true },
					to: { type: "string", required: true },
				},
			},
			call: (args) => ({ card: "generic", title: `zspace_copy ${(args.paths ?? []).length} 项`, kind: "edit" }),
			render: (_args, value) => [{ type: "text", text: `已复制 ${value.count} 项 → ${value.to}` }],
			execute: (args) =>
				guarded(async () => {
					const client = getClient();
					const sources = await Promise.all((args.paths ?? []).map(item => resolve(item)));
					if (sources.length === 0) throw new Error("zspace_copy: `paths` must not be empty");
					const destination = await resolve(args.to);
					await client.copy(sources, destination);
					return { ok: true, count: sources.length, to: destination };
				}),
		},
		{
			name: "zspace_remove",
			description:
				"Delete files or directories from the 极空间 / ZSpace NAS. The NAS moves them to its recycle bin. Requires confirm=true so a bulk delete can never be a slip; ask the user before removing anything they did not name explicitly.",
			parameters: {
				paths: { type: "array", required: true, items: { type: "string" }, description: "Paths to delete." },
				confirm: { type: "boolean", required: true, description: "Must be true — explicit confirmation that these paths should be deleted." },
			},
			outputSchema: {
				type: "object",
				additionalProperties: false,
				properties: {
					ok: { type: "boolean", required: true },
					count: { type: "integer", required: true },
					paths: { type: "array", required: true, items: { type: "string" } },
				},
			},
			call: (args) => ({ card: "generic", title: `zspace_remove ${(args.paths ?? []).length} 项`, kind: "edit" }),
			render: (_args, value) => [{ type: "text", text: `已删除 ${value.count} 项（进回收站）：\n${value.paths.join("\n")}` }],
			execute: (args) =>
				guarded(async () => {
					if (args.confirm !== true) {
						throw new Error("zspace_remove: 需要 confirm=true 才会执行删除（这是防止误删的保护）。");
					}
					const client = getClient();
					const targets = await Promise.all((args.paths ?? []).map(item => resolve(item)));
					if (targets.length === 0) throw new Error("zspace_remove: `paths` must not be empty");
					await client.remove(targets);
					return { ok: true, count: targets.length, paths: targets };
				}),
		},
	];
}
