/**
 * 极空间 (ZSpace) NAS client — the public entry point.
 *
 * Every call rides the **desktop client's local proxy** (`http://127.0.0.1:13579`),
 * which relays to the NAS over 极空间's cloud/P2P channel, so the plugin works
 * from any network without a LAN address, WebDAV or SSH.
 *
 * This file is a thin facade: it owns the mutable session state (base URL,
 * timeouts, cached space roots) and delegates each capability to one focused
 * module under `./client/`:
 *
 * | module | capability |
 * |---|---|
 * | `client/errors.js` | NAS business codes and the error type |
 * | `client/transport.js` | URL shaping, form encoding, retries, response validation |
 * | `client/session.js` | cookies, common params, safe identity |
 * | `client/spaces.js` | proxy probe, storage pools, space roots |
 * | `client/browse.js` | paged listing, entry metadata |
 * | `client/mutate.js` | mkdir / rename / move / copy / remove |
 * | `client/upload.js` | single-request and sliced uploads |
 * | `client/download.js` | streamed download, capped reads |
 *
 * @module dsh-zspace/client
 */

import { DEFAULT_API_VERSION, loadCredentials, resolveBaseUrl } from "./auth.js";
import { authHeaders, commonParams, identity } from "./client/session.js";
import { DEFAULT_PAGE_SIZE, endpointUrl, formBody, parse, post, retrying, send } from "./client/transport.js";
import { uploadSliced } from "./client/upload.js";
import { openDownload } from "./client/download.js";
import { dispatch, transportReport } from "./client/router.js";
import * as webdav from "./client/webdav.js";
export { ZSpaceError } from "./client/errors.js";

export class ZSpaceClient {
	/**
	 * @param {object} [options] - client options.
	 * @param {string} [options.baseUrl] - desktop client proxy URL.
	 * @param {string} [options.configDir] - explicit directory holding `vuex.json`.
	 * @param {string} [options.apiVersion] - NAS web API version.
	 * @param {{token: string, nasId: string, deviceId: string, device?: string, appVersion?: string, username?: string}} [options.credentials]
	 *   explicit credentials (tests); otherwise read from `vuex.json`.
	 * @param {string} [options.homePath] - configured personal-space root.
	 * @param {string} [options.publicPath] - configured public-space root.
	 * @param {number} [options.timeoutMs] - per-request timeout.
	 * @param {number} [options.maxRetries] - retries for transient failures.
	 * @param {number} [options.pageSize] - directory page size (NAS caps at 50).
	 * @param {number} [options.listMaxEntries] - directory listing ceiling.
	 * @param {number} [options.smallUploadMaxBytes] - above this, upload sliced.
	 * @param {number} [options.sliceSize] - sliced upload chunk size.
	 * @param {"auto"|"webdav"|"relay"} [options.transportMode] - transport preference (default `auto`).
	 * @param {string} [options.webdavUrl] - WebDAV base URL, e.g. `http://<nas-ip>:5005/`.
	 * @param {string} [options.webdavUser] - WebDAV user (NAS account); password from `ZS_WEBDAV_PASSWORD`.
	 * @param {string} [options.webdavHomePath] - DAV path mapped to the personal space (default `/`).
	 * @param {string} [options.webdavPublicPath] - DAV path mapped to the public space (empty = not exposed).
	 * @param {number} [options.webdavProbeTimeoutMs] - LAN probe timeout (default 1500).
	 */
	constructor(options = {}) {
		this.baseUrl = resolveBaseUrl(options.baseUrl);
		this.configDir = options.configDir;
		this.apiVersion = options.apiVersion || DEFAULT_API_VERSION;
		this.timeoutMs = options.timeoutMs ?? 60_000;
		this.maxRetries = options.maxRetries ?? 2;
		this.retryDelayMs = options.retryDelayMs ?? 300;
		this.pageSize = Math.min(options.pageSize ?? DEFAULT_PAGE_SIZE, DEFAULT_PAGE_SIZE);
		this.listMaxEntries = options.listMaxEntries ?? 2000;
		this.smallUploadMaxBytes = options.smallUploadMaxBytes ?? 8 * 1024 * 1024;
		this.sliceSize = options.sliceSize ?? 2 * 1024 * 1024;
		this.transportMode = options.transportMode || "auto";
		this.webdavUrl = options.webdavUrl || "";
		this.webdavUser = options.webdavUser || "";
		this.webdavPassword = options.webdavPassword || "";
		this.webdavHomePath = options.webdavHomePath || "/";
		this.webdavPublicPath = options.webdavPublicPath || "";
		this.webdavProbeTimeoutMs = options.webdavProbeTimeoutMs ?? 1500;
		this.configuredHomePath = options.homePath || "";
		this.configuredPublicPath = options.publicPath || "";
		this._credentials = options.credentials ?? null;
		this._homePath = null;
		this._publicPath = null;
		this._pools = null;
		this._webdavProbe = null;
		this._webdavDownUntil = 0;
		this._davRoots = null;
	}

	/**
	 * Desktop-client credentials, loaded lazily and re-read when `vuex.json` changes.
	 *
	 * @returns {{token: string, nasId: string, deviceId: string, username: string, device: string, appVersion: string, vuexPath?: string}}
	 */
	get credentials() {
		if (this._credentials === null) this._credentials = loadCredentials(this.configDir);
		return this._credentials;
	}

	/**
	 * Identity of the account this client acts as (no secrets).
	 *
	 * @returns {{username: string, nasId: string, deviceId: string, vuexPath: string}} safe identity fields.
	 */

	get identity() {
		return identity(this);
	}

	authHeaders() {
		return authHeaders(this);
	}

	commonParams() {
		return commonParams(this);
	}

	async check() {
		return await dispatch(this, "check", []);
	}

	async pools() {
		return await dispatch(this, "pools", []);
	}

	async isDirectory(remotePath) {
		return await dispatch(this, "isDirectory", [remotePath]);
	}

	async homePath() {
		return await dispatch(this, "homePath", []);
	}

	async publicPath() {
		return await dispatch(this, "publicPath", []);
	}

	async list(remotePath, options = {}) {
		return await dispatch(this, "list", [remotePath, options]);
	}

	async info(remotePath) {
		return await dispatch(this, "info", [remotePath]);
	}

	async mkdir(remotePath) {
		return await dispatch(this, "mkdir", [remotePath]);
	}

	async rename(remotePath, newName) {
		return await dispatch(this, "rename", [remotePath, newName]);
	}

	async move(remotePaths, to) {
		return await dispatch(this, "move", [remotePaths, to]);
	}

	async copy(remotePaths, to) {
		return await dispatch(this, "copy", [remotePaths, to]);
	}

	async remove(remotePaths) {
		return await dispatch(this, "remove", [remotePaths]);
	}

	async upload(localPath, remoteDir, options = {}) {
		return await dispatch(this, "upload", [localPath, remoteDir, options]);
	}

	/**
	 * Probe the WebDAV fast path (reachability + credentials), as reported by `zspace_status`.
	 *
	 * @returns {Promise<{reachable: boolean, usable: boolean, status?: number, reason: string}>} probe result.
	 */
	async probeWebdav() {
		return await webdav.probe(this);
	}

	/**
	 * Which transport the next call will use, plus the last probe result.
	 *
	 * @returns {Promise<{transport: string, configured: boolean, probe: Record<string, any>|null}>} transport report.
	 */
	async transportReport() {
		return await transportReport(this);
	}

	async uploadSliced(localPath, target, total, stat, onProgress) {
		return await uploadSliced(this, localPath, target, total, stat, onProgress);
	}

	async download(remotePath, localDir, options = {}) {
		return await dispatch(this, "download", [remotePath, localDir, options]);
	}

	async readFile(remotePath, options = {}) {
		return await dispatch(this, "readFile", [remotePath, options]);
	}

	async openDownload(remotePath) {
		return await openDownload(this, remotePath);
	}

	endpointUrl(endpoint, query) {
		return endpointUrl(this, endpoint, query);
	}

	formBody(fields) {
		return formBody(this, fields);
	}

	async retrying(attempt, shouldRetry) {
		return await retrying(this, attempt, shouldRetry);
	}

	async send(options) {
		return await send(this, options);
	}

	parse(response, endpoint) {
		return parse(this, response, endpoint);
	}

	async post(endpoint, fields) {
		return await post(this, endpoint, fields);
	}
}
