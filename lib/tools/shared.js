/**
 * Small helpers every tool file shares: argument clamping, error hints, one listing line.
 *
 * @module dsh-zspace/tools
 */

import { humanSize } from "../format.js";

/**
 * Clamp a numeric argument.
 *
 * @param {unknown} value - candidate value.
 * @param {number} fallback - default when absent/invalid.
 * @param {number} min - lower bound.
 * @param {number} max - upper bound.
 * @returns {number} clamped integer.
 */
export function clampInt(value, fallback, min, max) {
	const numeric = Number(value);
	if (!Number.isFinite(numeric)) return fallback;
	return Math.min(Math.max(Math.trunc(numeric), min), max);
}

/**
 * Format one entry as a listing line.
 *
 * @param {Record<string, any>} entry - normalized entry (optionally with `depth`).
 * @param {boolean} [showDepth] - indent by `entry.depth`.
 * @returns {string} display line.
 */
export function entryLine(entry, showDepth = false) {
	const indent = showDepth ? "  ".repeat(Number(entry.depth ?? 0)) : "";
	const size = entry.dir ? "" : `  ${humanSize(entry.size)}`;
	const when = entry.modified ? `  ${entry.modified}` : "";
	return `${indent}${entry.dir ? "📁" : "📄"} ${entry.name}${size}${when}`;
}

/**
 * Wrap a tool body so ZSpace failures carry their actionable hint.
 *
 * @param {() => Promise<any>} body - tool body.
 * @returns {Promise<any>} body result.
 */
export async function guarded(body) {
	try {
		return await body();
	} catch (error) {
		const hint = /** @type {{hint?: string}} */ (error)?.hint;
		if (hint) throw new Error(`${error.message} — ${hint}`);
		throw error;
	}
}
