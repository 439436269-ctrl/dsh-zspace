/**
 * ZSpace desktop-client credential discovery.
 *
 * ZSpace (极空间) has no official public API. Every community integration —
 * including the `zspace-cli` SDK and the published `zspace-*` skills — goes
 * through the **logged-in desktop client's local proxy**:
 *
 *   DSH plugin  →  http://127.0.0.1:13579  →  极空间桌面客户端  →  云中转/P2P  →  NAS
 *
 * That relay is what makes cross-network access work: the DSH host never needs
 * a LAN address, a port-forward, WebDAV or SSH, only a running, logged-in
 * desktop client on the same machine.
 *
 * The proxy authenticates from the client's own `vuex.json` login state, so
 * this module reads `token` / `nasId` / `deviceId` (plus the `device` and
 * `version` fields the sliced-upload protocol needs) from that file instead of
 * asking the user for a password.
 *
 * @module dsh-zspace/auth
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Default local proxy address of the ZSpace desktop client. */
export const DEFAULT_BASE_URL = "http://127.0.0.1:13579";

/**
 * NAS API version string sent as the `version` common parameter. This is the
 * desktop client's web-API version, not the client's own app version (which
 * `vuex.json` carries separately and which the sliced upload protocol wants).
 */
export const DEFAULT_API_VERSION = "2.3.2026042401";

/** Environment variable overriding the client config directory. */
export const CONFIG_DIR_ENV = "ZS_CONFIG_DIR";

/** Environment variable overriding the local proxy URL. */
export const BASE_URL_ENV = "ZS_BASE_URL";

const VUEX_FILENAME = "vuex.json";

/**
 * Raised when the desktop client's login state cannot be located or parsed.
 * The message is written for the model to act on, not just for a log.
 */
export class ZSpaceAuthError extends Error {
	/**
	 * @param message - actionable explanation.
	 * @param options - optional underlying cause.
	 */
	constructor(message, options) {
		super(message, options);
		this.name = "ZSpaceAuthError";
	}
}

/**
 * Candidate directories holding `vuex.json`, most likely first.
 *
 * macOS is where the desktop client is confirmed to store login state;
 * Windows/Linux paths mirror `zspace-cli` so the same plugin keeps working
 * when the DSH host runs there.
 *
 * @returns {string[]} absolute candidate directories.
 */
export function candidateConfigDirs() {
	const home = os.homedir();
	const dirs = [];
	if (process.platform === "win32") {
		for (const base of [process.env.APPDATA, process.env.LOCALAPPDATA, process.env.USERPROFILE]) {
			if (base) dirs.push(path.join(base, "zspace"));
		}
	} else if (process.platform === "darwin") {
		dirs.push(path.join(home, "Library", "Application Support", "zspace"));
	} else {
		dirs.push(path.join(home, ".zspace"), path.join(home, ".config", "zspace"), path.join(home, "zspace"));
	}
	// De-duplicate while preserving order (APPDATA and LOCALAPPDATA can alias).
	return [...new Set(dirs)];
}

/**
 * Locate `vuex.json`.
 *
 * Resolution order: the explicit `configDir` argument, then `$ZS_CONFIG_DIR`,
 * then the platform defaults.
 *
 * @param {string} [configDir] - explicit directory override.
 * @returns {string} path to `vuex.json`.
 * @throws {ZSpaceAuthError} when no candidate holds the file.
 */
export function locateVuex(configDir) {
	const candidates = configDir
		? [configDir]
		: process.env[CONFIG_DIR_ENV]
			? [process.env[CONFIG_DIR_ENV]]
			: candidateConfigDirs();
	for (const dir of candidates) {
		const file = path.join(dir, VUEX_FILENAME);
		if (fs.existsSync(file)) return file;
	}
	const tried = candidates.map(dir => `  - ${path.join(dir, VUEX_FILENAME)}`).join("\n");
	throw new ZSpaceAuthError(
		`极空间登录态未找到（vuex.json）。请确认极空间桌面客户端已安装、已登录并在运行；` +
			`或用环境变量 ${CONFIG_DIR_ENV} 指定配置目录。已尝试：\n${tried}`,
	);
}

/** Cache of parsed credentials keyed by vuex.json path. @type {Map<string, {stamp: string, creds: object}>} */
const credentialCache = new Map();

/**
 * Load the desktop client's login state.
 *
 * Parsed results are cached per file and invalidated when `vuex.json` changes
 * (re-login or token refresh), so a long-lived DSH session does not re-read
 * the file on every tool call.
 *
 * @param {string} [configDir] - explicit config directory override.
 * @returns {{token: string, nasId: string, deviceId: string, username: string, device: string, appVersion: string, vuexPath: string}}
 * @throws {ZSpaceAuthError} when the file is missing, unparseable or has no token.
 */
export function loadCredentials(configDir) {
	const vuexPath = locateVuex(configDir);
	const stat = fs.statSync(vuexPath);
	const stamp = `${stat.mtimeMs}:${stat.size}`;
	const cached = credentialCache.get(vuexPath);
	if (cached && cached.stamp === stamp) return cached.creds;

	let parsed;
	try {
		// The client writes a UTF-8 BOM on some versions.
		parsed = JSON.parse(fs.readFileSync(vuexPath, "utf8").replace(/^\uFEFF/, ""));
	} catch (error) {
		throw new ZSpaceAuthError(`极空间登录态无法解析：${vuexPath}（${error.message}）`, { cause: error });
	}
	const state = parsed.state ?? parsed;
	const user = state.user ?? {};
	const nas = state.nas ?? {};
	const app = state.app ?? {};
	if (!user.token) {
		throw new ZSpaceAuthError(`极空间登录态缺少 token（${vuexPath}）。请在桌面客户端重新登录后重试。`);
	}
	const creds = {
		token: user.token,
		nasId: nas.nasId ?? "",
		deviceId: app.deviceId ?? "",
		username: user.username ?? "",
		device: app.device ?? "",
		appVersion: app.version ?? "1.0",
		vuexPath,
	};
	credentialCache.set(vuexPath, { stamp, creds });
	return creds;
}

/**
 * Resolve the local proxy URL: explicit setting, then `$ZS_BASE_URL`, then the
 * default desktop-client port.
 *
 * @param {string} [configured] - value from the plugin config.
 * @returns {string} base URL without a trailing slash.
 */
export function resolveBaseUrl(configured) {
	const value = configured || process.env[BASE_URL_ENV] || DEFAULT_BASE_URL;
	return String(value).replace(/\/+$/, "");
}

/** Drop the credential cache (tests and explicit re-login recovery). */
export function clearCredentialCache() {
	credentialCache.clear();
}
