/**
 * `zspace_write` — one atomic capability.
 *
 * @module dsh-zspace/tools
 */

import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { humanSize } from "../format.js";

export function createWriteTool(ctx) {
	const { config, getClient, guarded, resolve } = ctx;
	return {
		name: "zspace_write",
		description:
			"Write text straight to a file on the 极空间 / ZSpace NAS (跨网络可用) — no local temp file needed. Use it to park generated notes, reports or config onto the NAS. Overwrites an existing file by default; pass overwrite=false to refuse replacing one. Size is capped by the writeMaxBytes config.",
		parameters: {
			path: { type: "string", required: true, description: "Remote file path (absolute, home:/, public:/, or relative to the personal space)." },
			content: { type: "string", required: true, description: "UTF-8 text to write. Use zspace_upload for binary or large files." },
			overwrite: { type: "boolean", description: "Allow replacing an existing file (default true)." },
		},
		outputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				path: { type: "string", required: true },
				bytes: { type: "integer", required: true },
				method: { type: "string", required: true },
			},
		},
		call: (args) => ({ card: "generic", title: `zspace_write ${args.path}`, kind: "edit" }),
		render: (_args, value) => [
			{
				type: "text",
				text: `已写入 ${value.path}（${humanSize(value.bytes)}，${value.method === "sliced" ? "分片" : "单请求"}）`,
			},
		],
		execute: (args) =>
			guarded(async () => {
				const client = getClient();
				const target = await resolve(args.path);
				const content = String(args.content ?? "");
				const bytes = Buffer.byteLength(content, "utf8");
				if (bytes === 0) throw new Error("zspace_write: `content` 不能为空");
				if (bytes > config.writeMaxBytes) {
					throw new Error(`zspace_write: 内容 ${bytes} 字节超过 writeMaxBytes=${config.writeMaxBytes}；大文件请用 zspace_upload`);
				}
				if (args.overwrite === false) {
					const exists = await client
						.info(target)
						.then(() => true)
						.catch(() => false);
					if (exists) throw new Error(`zspace_write: ${target} 已存在（overwrite=false 时拒绝覆盖）`);
				}

				// 上传接口只吃本地文件，所以落一个临时文件再走同一条上传路径
				// （单请求 / 分片由 client.upload 自己决定），最后无论如何都清理。
				const staging = await fsp.mkdtemp(path.join(os.tmpdir(), "dsh-zspace-write-"));
				const name = path.posix.basename(target);
				const local = path.join(staging, name);
				try {
					await fsp.writeFile(local, content, "utf8");
					const remoteDir = target.slice(0, target.lastIndexOf("/")) || "/";
					const result = await client.upload(local, remoteDir, { name });
					return { path: target, bytes: result.bytes, method: result.method };
				} finally {
					await fsp.rm(staging, { recursive: true, force: true });
				}
			}),
	};
}
