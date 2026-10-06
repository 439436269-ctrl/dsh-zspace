/**
 * Read-only directory access: paged listing and single-entry metadata.
 *
 * @module dsh-zspace/client
 */

import { toEntry } from "../format.js";

/**
 * List one directory, paging until the NAS has no more rows.
 *
 * @param {string} remotePath - absolute remote directory.
 * @param {{showHidden?: boolean, maxEntries?: number}} [options] - listing options.
 * @returns {Promise<{entries: Array<ReturnType<typeof toEntry>>, truncated: boolean}>} listing.
 */
export async function list(client, remotePath, options = {}) {
	const maxEntries = options.maxEntries ?? client.listMaxEntries;
	/** @type {Array<ReturnType<typeof toEntry>>} */
	const entries = [];
	let start = 0;
	let truncated = false;
	for (;;) {
		const data = await client.post("/v2/file/list", {
			path: remotePath,
			show_hidden: options.showHidden ? "1" : "0",
			start: String(start),
			limit: String(client.pageSize),
		});
		const page = Array.isArray(data?.list) ? data.list : [];
		for (const row of page) entries.push(toEntry(row));
		if (page.length < client.pageSize) break;
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
export async function info(client, remotePath) {
	const data = await client.post("/v2/file/info", { path: remotePath });
	return toEntry(data ?? {});
}

/**
 * Create one directory.
 *
 * @param {string} remotePath - absolute path of the new directory.
 * @returns {Promise<ReturnType<typeof toEntry>>} the created entry.
 */
