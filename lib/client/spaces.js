/**
 * Proxy liveness and NAS space discovery: storage pools, personal-space and public-space roots.
 *
 * @module dsh-zspace/client
 */

import https from "node:https";
import http from "node:http";
import { ZSpaceError } from "./errors.js";

/**
 * Probe the desktop client proxy.
 *
 * @returns {Promise<boolean>} true when the proxy answers below 500.
 */
export async function check(client) {
	const url = `${client.baseUrl}/home/`;
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
export async function pools(client) {
	if (client._pools !== null) return client._pools;
	const data = await client.post("/zspool/info", {});
	const list = Array.isArray(data?.pool_list) ? data.pool_list : [];
	client._pools = list.map((pool) => ({
		name: String(pool.name ?? ""),
		status: String(pool.status ?? ""),
		totalSize: Number(pool.total_size ?? 0),
		freeSize: Number(pool.free_size ?? 0),
	}));
	return client._pools;
}

/**
 * Whether a remote directory can be listed.
 *
 * @param {string} remotePath - absolute remote path.
 * @returns {Promise<boolean>} true when listing succeeds.
 */
export async function isDirectory(client, remotePath) {
	try {
		await client.post("/v2/file/list", { path: remotePath, show_hidden: "0", start: "0", limit: "1" });
		return true;
	} catch {
		return false;
	}
}

/**
 * Locate the personal-space root, e.g. `/<pool>/my/data`.
 *
 * Uses the configured path when set, otherwise tries `/<pool>/my/data` for
 * every storage pool and falls back to the historical `/sata11/my/data`.
 *
 * @returns {Promise<string>} personal-space root.
 * @throws {ZSpaceError} when no candidate is listable.
 */
export async function homePath(client) {
	if (client._homePath !== null) return client._homePath;
	const candidates = [];
	if (client.configuredHomePath) {
		candidates.push(client.configuredHomePath);
	} else {
		for (const pool of await client.pools().catch(() => [])) candidates.push(`/${pool.name}/my/data`);
		candidates.push("/sata11/my/data", "/sata1/my/data");
	}
	for (const candidate of [...new Set(candidates)]) {
		if (await client.isDirectory(candidate)) {
			client._homePath = candidate;
			return candidate;
		}
	}
	throw new ZSpaceError("NOHOME", `无法定位个人空间根目录，已尝试：${candidates.join("、")}`);
}

/**
 * Locate the public-space root, e.g. `/<pool>/public`.
 *
 * @returns {Promise<string>} public-space root.
 * @throws {ZSpaceError} when no candidate is listable (account may lack access).
 */
export async function publicPath(client) {
	if (client._publicPath !== null) return client._publicPath;
	const candidates = [];
	if (client.configuredPublicPath) {
		candidates.push(client.configuredPublicPath);
	} else {
		for (const pool of await client.pools().catch(() => [])) candidates.push(`/${pool.name}/public`);
		candidates.push("/public", "/sata1/public");
	}
	for (const candidate of [...new Set(candidates)]) {
		if (await client.isDirectory(candidate)) {
			client._publicPath = candidate;
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
