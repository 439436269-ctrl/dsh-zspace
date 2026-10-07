/**
 * Relay transport: everything through the desktop client's local proxy.
 *
 * This is the original (cross-network) path, kept as one uniform surface so the
 * router can treat it and the WebDAV transport interchangeably. Each function
 * here is a straight re-export of the capability module that implements it.
 *
 * @module dsh-zspace/client/relay
 */

export { check, homePath, isDirectory, pools, publicPath } from "./spaces.js";
export { info, list } from "./browse.js";
export { copy, mkdir, move, remove, rename } from "./mutate.js";
export { upload, uploadSliced } from "./upload.js";
export { download, openDownload, readFile } from "./download.js";

/** Transport name used by the router and status output. */
export const name = "relay";

/**
 * How to probe this transport. The relay is "up" when the desktop client's
 * local proxy answers — the same check the plugin has always used.
 *
 * @param {import("../client.js").ZSpaceClient} client - live client.
 * @returns {Promise<boolean>} whether the proxy answers.
 */
export async function probe(client) {
	const { check } = await import("./spaces.js");
	return await check(client);
}
