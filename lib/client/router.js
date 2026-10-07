/**
 * Transport router — WebDAV fast path vs. desktop-client relay.
 *
 * The plugin always speaks the same tool surface; this module decides which
 * transport serves a call:
 *
 * | mode | behaviour |
 * |---|---|
 * | `auto` (default) | probe WebDAV once per minute; usable → WebDAV, otherwise relay |
 * | `webdav` | always WebDAV (failures surface loudly) |
 * | `relay` | always the desktop-client relay (previous behaviour) |
 *
 * "Same network" is decided by **reachability**, not by comparing IP prefixes:
 * a machine on `192.168.31.x` may still route straight to a NAS on
 * `<nas-ip>`, and a machine on the NAS's own subnet may have WebDAV
 * disabled. A 1.5s PROPFIND answers that question directly.
 *
 * Runtime failures on the WebDAV path (timeouts, refused connections, 5xx)
 * mark it down for a cooldown and retry the same call over the relay, so losing
 * the LAN mid-session only costs latency — never a failed tool call. Business
 * errors (401/403/404/405/409, `N00…` codes) are *not* transport failures and
 * are returned as-is.
 *
 * @module dsh-zspace/client/router
 */

import * as relay from "./relay.js";
import { ZSpaceError } from "./errors.js";
import * as webdav from "./webdav.js";

/** How long a probe result is trusted. */
const PROBE_TTL_MS = 60_000;

/** How long to stay on the relay after a WebDAV runtime failure. */
const DOWN_COOLDOWN_MS = 30_000;

/** Methods served by a transport (the rest are relay internals). */
export const ROUTED_METHODS = [
	"check",
	"pools",
	"isDirectory",
	"homePath",
	"publicPath",
	"list",
	"info",
	"mkdir",
	"rename",
	"move",
	"copy",
	"remove",
	"download",
	"readFile",
	"upload",
];

/**
 * Whether an error means "this transport is unusable right now" (as opposed to
 * a legitimate answer about the path or the credentials).
 *
 * @param {unknown} error - thrown value.
 * @returns {boolean} true when falling back to the relay is the right move.
 */
export function isTransportFailure(error) {
	const code = String(/** @type {{code?: string}} */ (error)?.code ?? "");
	if (["ETIMEDOUT", "EDAV", "EPROXY", "ECONNREFUSED", "ECONNRESET", "ENETUNREACH", "EAI_AGAIN"].includes(code)) return true;
	if (/^HTTP(5\d\d)$/.test(code)) return true;
	return error instanceof TypeError; // undici network failures
}

/**
 * Which transport should serve the next call.
 *
 * @param {import("../client.js").ZSpaceClient} client - live client.
 * @returns {Promise<"webdav"|"relay">} chosen transport.
 */
export async function selectTransport(client) {
	const mode = client.transportMode || "auto";
	if (mode !== "webdav" && mode !== "auto") return "relay";
	if (!webdav.configured(client)) return "relay";
	if (mode === "webdav") return "webdav";
	if (client._webdavDownUntil && Date.now() < client._webdavDownUntil) return "relay";

	const cached = client._webdavProbe;
	if (cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.usable ? "webdav" : "relay";

	const result = await webdav.probe(client);
	client._webdavProbe = { at: Date.now(), ...result };
	return result.usable ? "webdav" : "relay";
}

/**
 * Human-readable transport state for `zspace_status`.
 *
 * @param {import("../client.js").ZSpaceClient} client - live client.
 * @returns {Promise<{transport: string, configured: boolean, probe: Record<string, any>|null}>} report.
 */
export async function transportReport(client) {
	const transport = await selectTransport(client);
	return {
		transport,
		configured: webdav.configured(client),
		probe: client._webdavProbe ?? null,
	};
}

/**
 * Run one capability through the selected transport, with relay fallback.
 *
 * @param {import("../client.js").ZSpaceClient} client - live client.
 * @param {string} method - capability name (see {@link ROUTED_METHODS}).
 * @param {unknown[]} args - arguments after the client.
 * @returns {Promise<any>} capability result.
 */
export async function dispatch(client, method, args) {
	const transport = await selectTransport(client);
	const implementation = transport === "webdav" ? webdav : relay;
	const fn = /** @type {Record<string, Function>} */ (implementation)[method];
	if (typeof fn !== "function") throw new ZSpaceError("ENOTIMPL", `传输 ${transport} 未实现 ${method}`);
	try {
		return await fn(client, ...args);
	} catch (error) {
		if (transport !== "webdav" || client.transportMode === "webdav" || !isTransportFailure(error)) throw error;
		client._webdavDownUntil = Date.now() + DOWN_COOLDOWN_MS;
		client._webdavProbe = {
			at: Date.now(),
			reachable: false,
			usable: false,
			reason: `运行中失败，${Math.round(DOWN_COOLDOWN_MS / 1000)}s 内走中转：${error?.message ?? error}`,
		};
		return await /** @type {Record<string, Function>} */ (relay)[method](client, ...args);
	}
}
