/**
 * `zspace_status` — one atomic capability.
 *
 * @module dsh-zspace/tools
 */

import { humanSize } from "../format.js";
import { webdavUrl } from "../client/webdav.js";

export function createStatusTool(ctx) {
	const { config, getClient, guarded } = ctx;
	return {
		name: "zspace_status",
		description:
			"Check the 极空间 / ZSpace NAS link behind this plugin. Reports which transport is in use (direct WebDAV on the same network, or the desktop client's cloud relay when away), probes the relay, resolves the personal-space and public-space roots, reports storage pools with free space, and lists both roots once. Run it first when another zspace_* tool fails.",
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
				transport: { type: "string", required: true },
				webdavUrl: { type: "string", required: true },
				webdavProbe: { type: "string", required: true },
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
						`极空间在线：${value.username || "(未知账号)"} @ ${value.nasId}`,
						value.transport === "webdav"
							? `通道：WebDAV 直连（${value.webdavUrl}）— 同网络快路径`
							: `通道：桌面客户端云中转（${value.baseUrl}）${value.webdavUrl ? `；WebDAV 未启用：${value.webdavProbe}` : ""}`,
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
				const transport = await client.transportReport();
				const webdavProbe = transport.probe?.reason ?? (transport.configured ? "尚未探测" : `未完整配置（需要 webdavUrl + ZS_WEBDAV_PASSWORD）`);
				const reachable = await client.check().catch(() => false);
				if (!reachable) {
					return {
						ok: false,
						baseUrl,
						transport: transport.transport,
						webdavUrl: webdavUrl(client),
						webdavProbe,
						username: "",
						nasId: "",
						homePath: "",
						publicPath: "",
						homeEntries: 0,
						publicEntries: 0,
						pools: [],
						message:
							`两条通道都不可用：WebDAV ${client.webdavUrl ? webdavProbe : "未配置"}；桌面客户端本地代理 ${baseUrl} 无响应。` +
							" 同网络时请在极空间开启 WebDAV 并设置 ZS_WEBDAV_PASSWORD；跨网络时需要桌面客户端已登录并运行。",
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
					transport: transport.transport,
					webdavUrl: webdavUrl(client),
					webdavProbe,
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
