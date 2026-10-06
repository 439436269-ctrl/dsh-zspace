/**
 * `zspace_rename` — one atomic capability.
 *
 * @module dsh-zspace/tools
 */

export function createRenameTool(ctx) {
	const { getClient, guarded, resolve } = ctx;
	return {
		name: "zspace_rename",
		description: "Rename a file or directory in place on the 极空间 / ZSpace NAS.",
		parameters: {
			path: { type: "string", required: true, description: "Remote path to rename." },
			newName: { type: "string", required: true, description: "New base name only (no directory part)." },
		},
		outputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				ok: { type: "boolean", required: true },
				path: { type: "string", required: true },
				name: { type: "string", required: true },
			},
		},
		call: (args) => ({ card: "generic", title: `zspace_rename ${args.path}`, kind: "edit" }),
		render: (_args, value) => [{ type: "text", text: `已重命名 → ${value.name}（${value.path}）` }],
		execute: (args) =>
			guarded(async () => {
				const client = getClient();
				const target = await resolve(args.path);
				const newName = String(args.newName ?? "").trim();
				if (newName === "" || newName.includes("/")) {
					throw new Error("zspace_rename: `newName` 必须是纯文件名（不含 /）");
				}
				await client.rename(target, newName);
				return { ok: true, path: target, name: newName };
			}),
	};
}
