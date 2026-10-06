/**
 * `zspace_mkdir` — one atomic capability.
 *
 * @module dsh-zspace/tools
 */

export function createMkdirTool(ctx) {
	const { getClient, guarded, resolve } = ctx;
	return {
		name: "zspace_mkdir",
		description: "Create one directory on the 极空间 / ZSpace NAS.",
		parameters: {
			path: { type: "string", required: true, description: "Remote directory to create (absolute, home:/, public:/, or relative to the personal space)." },
		},
		outputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				ok: { type: "boolean", required: true },
				path: { type: "string", required: true },
			},
		},
		call: (args) => ({ card: "generic", title: `zspace_mkdir ${args.path}`, kind: "edit" }),
		render: (_args, value) => [{ type: "text", text: `已创建目录 ${value.path}` }],
		execute: (args) =>
			guarded(async () => {
				const client = getClient();
				const target = await resolve(args.path);
				if (target === "/") throw new Error("zspace_mkdir: 不能创建根目录");
				await client.mkdir(target);
				return { ok: true, path: target };
			}),
	};
}
