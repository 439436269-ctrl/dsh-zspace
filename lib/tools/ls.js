/**
 * `zspace_ls` — one atomic capability.
 *
 * @module dsh-zspace/tools
 */

export function createLsTool(ctx) {
	const { clampInt, config, entryLine, getClient, guarded, resolve, walkDirectory } = ctx;
	return {
		name: "zspace_ls",
		description:
			"List a 极空间 / ZSpace NAS directory (跨网络可用). `path` accepts an absolute NAS path, `home:` / `public:` prefixes, or a path relative to the personal space; omit it for the personal-space root. Set `depth` > 1 to walk a subtree. Large directories are paged automatically.",
		parameters: {
			path: { type: "string", description: "Remote directory. Absolute (/sata1/my/data/…), home:/…, public:/…, or relative to the personal space. Omit for the personal-space root." },
			depth: { type: "integer", description: "How many levels to list, 1-6 (default 1)." },
			showHidden: { type: "boolean", description: "Include hidden entries (default false)." },
			limit: { type: "integer", description: `Maximum entries to return (default 200, cap ${config.listMaxEntries}).` },
		},
		outputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				root: { type: "string", required: true },
				entries: {
					type: "array",
					required: true,
					items: {
						type: "object",
						additionalProperties: false,
						properties: {
							name: { type: "string", required: true },
							path: { type: "string", required: true },
							dir: { type: "boolean", required: true },
							size: { type: "integer", required: true },
							modified: { type: "string", required: true },
							depth: { type: "integer", required: true },
						},
					},
				},
				count: { type: "integer", required: true },
				truncated: { type: "boolean", required: true },
			},
		},
		call: (args) => ({ card: "generic", title: `zspace_ls ${args.path ?? "home:"}`, kind: "search" }),
		render: (_args, value) => {
			const lines = value.entries.map(entry => entryLine(entry, true));
			const tail = value.truncated ? `\n… 结果被截断（只显示前 ${value.count} 项，可提高 limit 或缩小范围）` : "";
			return [
				{
					type: "text",
					text: `${value.root}（${value.count} 项）\n${lines.join("\n") || "(空目录)"}${tail}`,
				},
			];
		},
		presentationMeta: (_args, value) => ({ count: value.count }),
		execute: (args) =>
			guarded(async () => {
				const client = getClient();
				const root = await resolve(args.path);
				const depth = clampInt(args.depth, 1, 1, 6);
				const budget = clampInt(args.limit, 200, 1, config.listMaxEntries);
				const { entries, truncated } = await walkDirectory({
					client,
					root,
					depth,
					showHidden: args.showHidden === true,
					budget,
				});
				return { root, entries, count: entries.length, truncated };
			}),
	};
}
