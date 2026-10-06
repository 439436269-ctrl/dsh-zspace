/**
 * Server-side mutations: mkdir, rename, move, copy, remove.
 *
 * @module dsh-zspace/client
 */

import { splitRemote, toEntry } from "../format.js";

/**
 * Create one directory.
 *
 * @param {string} remotePath - absolute path of the new directory.
 * @returns {Promise<ReturnType<typeof toEntry>>} the created entry.
 */
export async function mkdir(client, remotePath) {
	const { parent, name } = splitRemote(remotePath);
	const data = await client.post("/v2/file/newdir", { parent, name, rename: "0" });
	return toEntry(data ?? {});
}

/**
 * Rename a file or directory in place.
 *
 * @param {string} remotePath - absolute current path.
 * @param {string} newName - new base name (no directory part).
 * @returns {Promise<ReturnType<typeof toEntry>>} the renamed entry.
 */

/**
 * Rename a file or directory in place.
 *
 * @param {string} remotePath - absolute current path.
 * @param {string} newName - new base name (no directory part).
 * @returns {Promise<ReturnType<typeof toEntry>>} the renamed entry.
 */
export async function rename(client, remotePath, newName) {
	const data = await client.post("/v2/file/modify", { path: remotePath, newname: newName });
	return toEntry(data ?? {});
}

/**
 * Move files or directories into a target directory.
 *
 * @param {string[]} remotePaths - absolute source paths.
 * @param {string} to - absolute destination directory.
 * @returns {Promise<void>} resolves when the NAS accepted the move.
 */

/**
 * Move files or directories into a target directory.
 *
 * @param {string[]} remotePaths - absolute source paths.
 * @param {string} to - absolute destination directory.
 * @returns {Promise<void>} resolves when the NAS accepted the move.
 */
export async function move(client, remotePaths, to) {
	await client.post("/v2/file/move", { paths: remotePaths, to });
}

/**
 * Copy files or directories into a target directory.
 *
 * @param {string[]} remotePaths - absolute source paths.
 * @param {string} to - absolute destination directory.
 * @returns {Promise<void>} resolves when the NAS accepted the copy.
 */

/**
 * Copy files or directories into a target directory.
 *
 * @param {string[]} remotePaths - absolute source paths.
 * @param {string} to - absolute destination directory.
 * @returns {Promise<void>} resolves when the NAS accepted the copy.
 */
export async function copy(client, remotePaths, to) {
	await client.post("/v2/file/copy", { paths: remotePaths, to });
}

/**
 * Delete files or directories (the NAS moves them to its recycle bin).
 *
 * @param {string[]} remotePaths - absolute paths to remove.
 * @returns {Promise<void>} resolves when the NAS accepted the deletion.
 */

/**
 * Delete files or directories (the NAS moves them to its recycle bin).
 *
 * @param {string[]} remotePaths - absolute paths to remove.
 * @returns {Promise<void>} resolves when the NAS accepted the deletion.
 */
export async function remove(client, remotePaths) {
	await client.post("/v2/file/remove", { paths: remotePaths });
}

/**
 * Download one file to a local directory.
 *
 * @param {string} remotePath - absolute remote file.
 * @param {string} localDir - local destination directory (created if needed).
 * @param {{name?: string}} [options] - destination name override.
 * @returns {Promise<{localPath: string, bytes: number}>} written file.
 */
