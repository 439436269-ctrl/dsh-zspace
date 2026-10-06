/**
 * Downloads: streamed file download and capped reads into memory.
 *
 * @module dsh-zspace/client
 */

import fsp from "node:fs/promises";
import fs from "node:fs";
import https from "node:https";
import http from "node:http";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { ZSpaceError } from "./errors.js";
import { readStream } from "./transport.js";

/**
 * Download one file to a local directory.
 *
 * @param {string} remotePath - absolute remote file.
 * @param {string} localDir - local destination directory (created if needed).
 * @param {{name?: string}} [options] - destination name override.
 * @returns {Promise<{localPath: string, bytes: number}>} written file.
 */
export async function download(client, remotePath, localDir, options = {}) {
	const name = options.name || path.posix.basename(remotePath);
	const dest = path.join(localDir, name);
	await fsp.mkdir(localDir, { recursive: true });
	const response = await client.openDownload(remotePath);

	const status = response.statusCode ?? 0;
	const contentType = String(response.headers["content-type"] ?? "");
	if (status >= 400 || contentType.includes("json")) {
		const { buffer } = await readStream(response);
		client.parse({ status, text: buffer.toString("utf8") }, "/v2/file/download");
	}
	try {
		await pipeline(response, fs.createWriteStream(dest));
	} catch (error) {
		await fsp.rm(dest, { force: true });
		throw new ZSpaceError("EDOWNLOAD", `写入本地文件失败：${dest}（${error.message}）`, { cause: error });
	}
	const stat = await fsp.stat(dest);
	return { localPath: dest, bytes: stat.size };
}

/**
 * Read the head of a remote file into memory.
 *
 * @param {string} remotePath - absolute remote file.
 * @param {{maxBytes?: number}} [options] - byte cap.
 * @returns {Promise<{buffer: Buffer, truncated: boolean, bytes: number}>} content.
 */

/**
 * Read the head of a remote file into memory.
 *
 * @param {string} remotePath - absolute remote file.
 * @param {{maxBytes?: number}} [options] - byte cap.
 * @returns {Promise<{buffer: Buffer, truncated: boolean, bytes: number}>} content.
 */
export async function readFile(client, remotePath, options = {}) {
	const maxBytes = options.maxBytes ?? 262_144;
	const response = await client.openDownload(remotePath);
	const status = response.statusCode ?? 0;
	const contentType = String(response.headers["content-type"] ?? "");
	if (status >= 400 || contentType.includes("json")) {
		const { buffer } = await readStream(response);
		client.parse({ status, text: buffer.toString("utf8") }, "/v2/file/download");
	}
	const { buffer, truncated } = await readStream(response, maxBytes);
	response.destroy();
	return { buffer, truncated, bytes: buffer.length };
}

/**
 * Open a download response, retrying transient proxy failures.
 *
 * @param {string} remotePath - absolute remote file.
 * @returns {Promise<import("node:http").IncomingMessage>} the open response (caller consumes it).
 */

/**
 * Open a download response, retrying transient proxy failures.
 *
 * @param {string} remotePath - absolute remote file.
 * @returns {Promise<import("node:http").IncomingMessage>} the open response (caller consumes it).
 */
export async function openDownload(client, remotePath) {
	const url = client.endpointUrl("/v2/file/download", { path: remotePath, remote_port: "8050" });
	return await client.retrying(
		() =>
			new Promise((resolve, reject) => {
				const request = (client.baseUrl.startsWith("https:") ? https : http).request(
					url,
					{ method: "GET", headers: client.authHeaders() },
					(response) => {
						const status = response.statusCode ?? 0;
						if (status >= 500 || status === 429) {
							response.resume();
							reject(new ZSpaceError(`HTTP${status}`, `HTTP ${status} 下载失败：${remotePath}`, { endpoint: "/v2/file/download" }));
							return;
						}
						resolve(response);
					},
				);
				request.setTimeout(client.timeoutMs, () => request.destroy(new ZSpaceError("ETIMEDOUT", `下载超时：${remotePath}`)));
				request.on("error", (error) => {
					if (error instanceof ZSpaceError) reject(error);
					else reject(new ZSpaceError("EPROXY", `下载失败（${remotePath}）：${error.message}`, { endpoint: "/v2/file/download" }));
				});
				request.end();
			}),
		error =>
			error instanceof ZSpaceError &&
			(error.code === "ETIMEDOUT" || error.code === "EPROXY" || /^HTTP(5\d\d|429)$/.test(error.code)),
	);
}

/**
 * Upload a local file into a remote directory.
 *
 * Files at or below `smallUploadMaxBytes` use `/v2/file/create`; larger ones
 * (and any request the local proxy rejects with HTTP 413) use the desktop
 * client's sliced `/v2/file/upload` protocol.
 *
 * @param {string} localPath - local file.
 * @param {string} remoteDir - absolute remote directory.
 * @param {{name?: string, onProgress?: (sent: number, total: number) => void}} [options] - upload options.
 * @returns {Promise<{remotePath: string, bytes: number, method: "create"|"sliced"}>} upload result.
 */
