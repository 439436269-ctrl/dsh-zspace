/**
 * Path conventions: remote prefixes, remote resolution, local path expansion.
 *
 * @module dsh-zspace/tools
 */

import os from "node:os";
import path from "node:path";
import { joinRemote } from "../format.js";

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
 * Resolve a local path argument.
 *
 * The plugin runs inside the DSH host process, so a relative path resolves
 * against that process's working directory — **not** the agent's session
 * workspace. `~/` is expanded so a model can still say `~/Downloads`.
 *
 * @param {unknown} input - caller-provided path.
 * @returns {string} absolute local path ("" for blank input).
 */
export function expandLocalPath(input) {
	const raw = String(input ?? "").trim();
	if (raw === "") return "";
	if (raw === "~") return os.homedir();
	if (raw.startsWith("~/")) return path.join(os.homedir(), raw.slice(2));
	return path.resolve(raw);
}

/**
 * Default local directory for downloads when none is configured.
 *
 * @param {Record<string, any>} config - plugin config.
 * @returns {string} absolute local directory.
 */
export function defaultDownloadDir(config) {
	return config.downloadDir || path.join(os.homedir(), "Downloads", "zspace");
}
