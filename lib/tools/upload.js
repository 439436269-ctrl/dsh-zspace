/**
 * `zspace_upload` — one atomic capability.
 *
 * @module dsh-zspace/tools
 */

import fsp from "node:fs/promises";
import { humanSize } from "../format.js";

export function createUploadTool(ctx) {
	const { expandLocalPath, getClient, guarded, resolve } = ctx;
	return {
		name: "zspace_upload",
		description:
			"Upload one local file to the 极空间 / ZSpace NAS (跨网络可用). Small files go in one request; larger ones automatically use the desktop client's sliced upload protocol. Chinese file names are supported.",
		parameters: {
			localPath: {
				type: "string",
				required: true,
				description:
					"Local file to upload. Pass an absolute path or `~/…` — the plugin resolves plain relative paths against the DSH host process directory, not the agent workspace.",
			},
			remoteDir: { type: "string", description: "Remote destination directory (default: the personal-space root)." },
			name: { type: "string", description: "Remote file name override (default: the local base name)." },
		},
		outputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				localPath: { type: "string", required: true },
				remotePath: { type: "string", required: true },
				bytes: { type: "integer", required: true },
				method: { type: "string", required: true },
			},
		},
		call: (args) => ({ card: "generic", title: `zspace_upload ${args.localPath}`, kind: "edit" }),
		render: (_args, value) => [
			{
				type: "text",
				text: `已上传 ${value.localPath} → ${value.remotePath}（${humanSize(value.bytes)}，${value.method === "sliced" ? "分片" : "单请求"}）`,
			},
		],
		execute: (args) =>
			guarded(async () => {
				const client = getClient();
				const localPath = expandLocalPath(args.localPath);
				if (localPath === "") throw new Error("zspace_upload: `localPath` is required");
				await fsp.access(localPath).catch(() => {
					throw new Error(
						`zspace_upload: 本地文件不存在：${localPath}（相对路径按 DSH 宿主进程目录解析，建议传绝对路径或用 ~/ 开头）`,
					);
				});
				const remoteDir = await resolve(args.remoteDir);
				const result = await client.upload(localPath, remoteDir, { name: args.name });
				return { localPath, remotePath: result.remotePath, bytes: result.bytes, method: result.method };
			}),
	};
}
