/**
 * `zspace_read` — one atomic capability.
 *
 * @module dsh-zspace/tools
 */

import path from "node:path";

export function createReadTool(ctx) {
	const { clampInt, config, getClient, guarded, resolve } = ctx;
	return {
		name: "zspace_read",
		description:
			"Read the beginning of a small remote text file into context (default cap 256 KB). Use zspace_download for anything large or binary.",
		parameters: {
			path: { type: "string", required: true, description: "Remote file path." },
			maxBytes: { type: "integer", description: `Byte cap (default ${config.readMaxBytes}, hard cap ${config.readMaxBytes}).` },
		},
		outputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				path: { type: "string", required: true },
				bytes: { type: "integer", required: true },
				truncated: { type: "boolean", required: true },
				binary: { type: "boolean", required: true },
				content: { type: "string", required: true },
			},
		},
		call: (args) => ({ card: "generic", title: `zspace_read ${args.path}`, kind: "search" }),
		render: (_args, value) => [
			{
				type: "text",
				text: value.binary
					? `${value.path}：看起来是二进制文件（${value.bytes} 字节），未按文本渲染。可用 zspace_download 取到本地处理。`
					: `${value.path}${value.truncated ? `（已截断到 ${value.bytes} 字节）` : ""}：\n${value.content}`,
			},
		],
		execute: (args) =>
			guarded(async () => {
				const client = getClient();
				const target = await resolve(args.path);
				const maxBytes = clampInt(args.maxBytes, config.readMaxBytes, 1, config.readMaxBytes);
				const { buffer, truncated, bytes } = await client.readFile(target, { maxBytes });
				const binary = buffer.includes(0);
				return {
					path: target,
					bytes,
					truncated,
					binary,
					content: binary ? "" : buffer.toString("utf8"),
				};
			}),
	};
}
