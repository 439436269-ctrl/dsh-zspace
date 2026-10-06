/**
 * `zspace_remove` — one atomic capability.
 *
 * @module dsh-zspace/tools
 */

export function createRemoveTool(ctx) {
	const { getClient, guarded, resolve } = ctx;
	return {
		name: "zspace_remove",
		description:
			"Delete files or directories from the 极空间 / ZSpace NAS. The NAS moves them to its recycle bin. Requires confirm=true so a bulk delete can never be a slip; ask the user before removing anything they did not name explicitly.",
		parameters: {
			paths: { type: "array", required: true, items: { type: "string" }, description: "Paths to delete." },
			confirm: { type: "boolean", required: true, description: "Must be true — explicit confirmation that these paths should be deleted." },
		},
		outputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				ok: { type: "boolean", required: true },
				count: { type: "integer", required: true },
				paths: { type: "array", required: true, items: { type: "string" } },
			},
		},
		call: (args) => ({ card: "generic", title: `zspace_remove ${(args.paths ?? []).length} 项`, kind: "edit" }),
		render: (_args, value) => [{ type: "text", text: `已删除 ${value.count} 项（进回收站）：\n${value.paths.join("\n")}` }],
		execute: (args) =>
			guarded(async () => {
				if (args.confirm !== true) {
					throw new Error("zspace_remove: 需要 confirm=true 才会执行删除（这是防止误删的保护）。");
				}
				const client = getClient();
				const targets = await Promise.all((args.paths ?? []).map(item => resolve(item)));
				if (targets.length === 0) throw new Error("zspace_remove: `paths` must not be empty");
				await client.remove(targets);
				return { ok: true, count: targets.length, paths: targets };
			}),
	};
}
