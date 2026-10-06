/**
 * Uploads: single-request create plus the desktop client's sliced protocol for anything bigger.
 *
 * @module dsh-zspace/client
 */

import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { UPLOAD_FATAL_CODES, ZSpaceError } from "./errors.js";
import { percentEncode } from "./transport.js";
import { joinRemote } from "../format.js";

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
export async function upload(client, localPath, remoteDir, options = {}) {
	const stat = await fsp.stat(localPath);
	if (!stat.isFile()) throw new ZSpaceError("ENOTFILE", `本地路径不是文件：${localPath}`);
	const name = options.name || path.basename(localPath);
	const target = joinRemote(remoteDir, name);

	if (stat.size > client.smallUploadMaxBytes) {
		await client.uploadSliced(localPath, target, stat.size, stat, options.onProgress);
		return { remotePath: target, bytes: stat.size, method: "sliced" };
	}
	try {
		const response = await client.send({
			method: "POST",
			endpoint: "/v2/file/create",
			headers: { "Content-Type": "application/octet-stream", path: percentEncode(target) },
			filePath: localPath,
		});
		client.parse(response, "/v2/file/create");
		options.onProgress?.(stat.size, stat.size);
		return { remotePath: target, bytes: stat.size, method: "create" };
	} catch (error) {
		if (error instanceof ZSpaceError && error.code === "HTTP413") {
			await client.uploadSliced(localPath, target, stat.size, stat, options.onProgress);
			return { remotePath: target, bytes: stat.size, method: "sliced" };
		}
		throw error;
	}
}

/**
 * Sliced upload (`/v2/file/upload`), the protocol the desktop client uses
 * for anything the local proxy will not pass through in one request.
 *
 * @param {string} localPath - local file.
 * @param {string} target - absolute remote file path.
 * @param {number} total - total byte size.
 * @param {import("node:fs").Stats} stat - local file stat.
 * @param {(sent: number, total: number) => void} [onProgress] - progress callback.
 * @returns {Promise<void>} resolves when the last slice was accepted.
 */
export async function uploadSliced(client, localPath, target, total, stat, onProgress) {
	const creds = client.credentials;
	const mtimeMs = Math.ceil(stat.mtimeMs);
	const uuid = crypto.createHash("md5").update(`${mtimeMs + total}${target}`).digest("hex");
	const modifyTime = Math.ceil(mtimeMs / 1000);
	const handle = await fsp.open(localPath, "r");
	try {
		let sent = 0;
		while (sent < total) {
			const length = Math.min(client.sliceSize, total - sent);
			const buffer = Buffer.alloc(length);
			await handle.read(buffer, 0, length, sent);
			const params = {
				app: "file",
				path: percentEncode(target),
				size: total,
				uuid,
				seek: sent,
				crtime: "",
				modify_time: modifyTime,
				rename: 0,
				token: percentEncode(creds.token),
				plat: "pc",
				nasid: creds.nasId,
				version: creds.appVersion,
				device_id: creds.deviceId,
				device: percentEncode(creds.device),
				"request-purpose": 4,
				"remote-port": 8050,
				split: 1,
			};
			const headers = Object.fromEntries(Object.entries(params).map(([key, value]) => [key, String(value)]));
			headers.Cookie = Object.entries(params)
				.map(([key, value]) => `${key === "nasid" ? "nas_id" : key}=${percentEncode(value)}`)
				.join("; ");
			headers["Content-Type"] = "application/octet-stream";
			headers["Content-Length"] = String(length);
			const url = `${client.baseUrl}/v2/file/upload?remote_port=8050&drnd=${Date.now()}&uuid=${uuid}`;
			await client.retrying(
				async () => {
					const response = await client.send({ method: "POST", url, headers, body: buffer });
					client.parse(response, "/v2/file/upload");
				},
				error => !(error instanceof ZSpaceError && UPLOAD_FATAL_CODES.has(error.code)),
			);
			sent += length;
			onProgress?.(sent, total);
		}
	} finally {
		await handle.close();
	}
}
