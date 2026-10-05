/**
 * Small formatting helpers shared by the ZSpace client and the tool layer.
 * No host imports — this module stays runnable under plain Node.
 *
 * @module dsh-zspace/format
 */

/**
 * Whether an API flag field means "yes". The NAS returns `is_dir` and `type`
 * as **strings** (`"0"` / `"1"`), so a plain truthiness test would classify
 * every file as a directory.
 *
 * @param {unknown} value - raw flag value.
 * @returns {boolean} true for true / 1 / "1" / "true".
 */
export function isTruthyFlag(value) {
	return value === true || value === 1 || String(value) === "1" || String(value).toLowerCase() === "true";
}

/**
 * Normalize one raw `/v2/file/list` or `/v2/file/info` row.
 *
 * @param {Record<string, unknown>} raw - API row.
 * @returns {{name: string, path: string, dir: boolean, size: number, modified: string, created: string, ext: string}}
 */
export function toEntry(raw) {
	const size = Number(raw?.size ?? 0);
	return {
		name: String(raw?.name ?? ""),
		path: String(raw?.path ?? ""),
		dir: raw?.is_dir !== undefined ? isTruthyFlag(raw.is_dir) : isTruthyFlag(raw?.type),
		size: Number.isFinite(size) ? size : 0,
		modified: formatTime(raw?.modify_time),
		created: formatTime(raw?.crtime),
		ext: String(raw?.ext ?? ""),
	};
}

/**
 * Format an API timestamp (seconds since epoch, usually a string) as local
 * `YYYY-MM-DD HH:mm`. Zero, empty and unparseable values become `""`.
 *
 * @param {unknown} seconds - API timestamp.
 * @returns {string} local timestamp or an empty string.
 */
export function formatTime(seconds) {
	const value = Number(seconds);
	if (!Number.isFinite(value) || value <= 0) return "";
	const date = new Date(value * 1000);
	const pad = part => String(part).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Human-readable byte size (binary units).
 *
 * @param {number} bytes - size in bytes.
 * @returns {string} e.g. `4.0 MB`.
 */
export function humanSize(bytes) {
	const value = Number(bytes);
	if (!Number.isFinite(value) || value <= 0) return "0 B";
	const units = ["B", "KB", "MB", "GB", "TB", "PB"];
	const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
	const scaled = value / 1024 ** exponent;
	return `${exponent === 0 ? scaled : scaled.toFixed(scaled >= 100 ? 0 : 1)} ${units[exponent]}`;
}

/**
 * Join a remote directory and a child name with single slashes.
 *
 * @param {string} dir - remote directory (POSIX style).
 * @param {string} name - child name.
 * @returns {string} joined remote path.
 */
export function joinRemote(dir, name) {
	return `${String(dir).replace(/\/+$/, "")}/${String(name).replace(/^\/+/, "")}`;
}

/**
 * Split a remote file path into its parent directory and base name.
 *
 * @param {string} remotePath - absolute remote path.
 * @returns {{parent: string, name: string}} parent directory and base name.
 */
export function splitRemote(remotePath) {
	const normalized = String(remotePath).replace(/\/+$/, "");
	const index = normalized.lastIndexOf("/");
	if (index <= 0) return { parent: "/", name: normalized.slice(1) };
	return { parent: normalized.slice(0, index), name: normalized.slice(index + 1) };
}
