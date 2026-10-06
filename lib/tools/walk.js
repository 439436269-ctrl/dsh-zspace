/**
 * Tree walking: depth-limited listing and bounded name search.
 *
 * @module dsh-zspace/tools
 */

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
export async function walkDirectory({ client, root, depth, showHidden, budget }) {
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
