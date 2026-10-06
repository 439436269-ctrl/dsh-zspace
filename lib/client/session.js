/**
 * Session view of the desktop client's login state: cookies, common params, safe identity.
 *
 * @module dsh-zspace/client
 */

/**
 * Auth cookies for every request.
 *
 * @returns {Record<string, string>} request headers carrying the session.
 */
export function authHeaders(client) {
	const creds = client.credentials;
	return {
		Cookie: [
			`token=${creds.token}`,
			`zenithtoken=${creds.token}`,
			`nas_id=${creds.nasId}`,
			`nasid=${creds.nasId}`,
			`device_id=${creds.deviceId}`,
		].join("; "),
	};
}

/**
 * Common form fields. These belong in the request **body**; the NAS rejects
 * them in the query string with `N001212`.
 *
 * @returns {Record<string, string>} common fields.
 */
export function commonParams(client) {
	const creds = client.credentials;
	return {
		token: creds.token,
		nasid: creds.nasId,
		plat: "web",
		version: client.apiVersion,
		device_id: creds.deviceId,
		_l: "zh_cn",
	};
}

/**
 * Build an endpoint URL with the mandatory random query suffix.
 *
 * @param {string} endpoint - API path, e.g. `/v2/file/list`.
 * @param {Record<string, unknown>} [query] - extra query values.
 * @returns {string} absolute URL.
 */

/**
 * Identity of the account this client acts as (no secrets).
 *
 * @returns {{username: string, nasId: string, deviceId: string, vuexPath: string}} safe identity fields.
 */
export function identity(client) {
	const creds = client.credentials;
	return {
		username: creds.username ?? "",
		nasId: creds.nasId ?? "",
		deviceId: creds.deviceId ?? "",
		vuexPath: creds.vuexPath ?? "",
	};
}

// ── transport ────────────────────────────────────────────────────────────

/**
 * Auth cookies for every request.
 *
 * @returns {Record<string, string>} request headers carrying the session.
 */
