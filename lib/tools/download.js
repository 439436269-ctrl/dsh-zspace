/**
 * `zspace_download` — one atomic capability.
 *
 * @module dsh-zspace/tools
 */

import path from "node:path";
import { humanSize } from "../format.js";

export function createDownloadTool(ctx) {
	const { config, downloadDir, expandLocalPath, getClient, guarded, resolve } = ctx;
	return {
		name: "zspace_download",
		description:
			"Download one file from the 极空间 / ZSpace NAS to this machine (跨网络可用). Returns the absolute local path. Default local directory: " +
			`${config.downloadDir || "~/Downloads/zspace"}.`,
		parameters: {
			path: { type: "string", required: true, description: "Remote file path." },
			dir: { type: "string", description: "Local destination directory. Pass an absolute path or `~/…` (a plain relative path resolves against the DSH host process directory). Default: the configured download directory." },
			name: { type: "string", description: "Local file name override (default: the remote base name)." },
		},
		outputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				remotePath: { type: "string", required: true },
				localPath: { type: "string", required: true },
				bytes: { type: "integer", required: true },
			},
		},
		call: (args) => ({ card: "generic", title: `zspace_download ${args.path}`, kind: "edit" }),
		render: (_args, value) => [
			{ type: "text", text: `已下载 ${value.remotePath} → ${value.localPath}（${humanSize(value.bytes)}）` },
		],
		execute: (args) =>
			guarded(async () => {
				const client = getClient();
				const target = await resolve(args.path);
				const localDir = expandLocalPath(args.dir) || downloadDir();
				const result = await client.download(target, localDir, { name: args.name });
				return { remotePath: target, localPath: result.localPath, bytes: result.bytes };
			}),
	};
}
