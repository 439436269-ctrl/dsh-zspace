/**
 * `zspace_status` — one atomic capability.
 *
 * @module dsh-zspace/tools
 */

import { humanSize } from "../format.js";

export function createStatusTool(ctx) {
	const { config, getClient, guarded } = ctx;
	return {
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
	};
}
