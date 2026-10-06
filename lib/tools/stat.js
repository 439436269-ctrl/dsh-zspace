/**
 * `zspace_stat` — one atomic capability.
 *
 * @module dsh-zspace/tools
 */

import { humanSize } from "../format.js";

export function createStatTool(ctx) {
	const { getClient, guarded, resolve } = ctx;
	return {
		name: "zspace_stat",
		description:
			"Show metadata (type, size, modified/created time) for one 极空间 / ZSpace path, without downloading it.",
		parameters: {
			path: { type: "string", required: true, description: "Remote file or directory (absolute, home:/, public:/, or relative to the personal space)." },
		},
		outputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				name: { type: "string", required: true },
				path: { type: "string", required: true },
				dir: { type: "boolean", required: true },
				size: { type: "integer", required: true },
				modified: { type: "string", required: true },
				created: { type: "string", required: true },
				ext: { type: "string", required: true },
			},
		},
		call: (args) => ({ card: "generic", title: `zspace_stat ${args.path}`, kind: "search" }),
		render: (_args, value) => [
			{
				type: "text",
				text: [
					`${value.dir ? "📁" : "📄"} ${value.name}`,
					`路径：${value.path}`,
					value.dir ? "类型：目录" : `大小：${humanSize(value.size)}（${value.size} 字节）`,
					value.modified ? `修改：${value.modified}` : "",
					value.created ? `创建：${value.created}` : "",
				]
					.filter(Boolean)
					.join("\n"),
			},
		],
		execute: (args) =>
			guarded(async () => {
				const client = getClient();
				const target = await resolve(args.path);
				return await client.info(target);
			}),
	};
}
