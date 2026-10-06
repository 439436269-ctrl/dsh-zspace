/**
 * `zspace_find` — one atomic capability.
 *
 * @module dsh-zspace/tools
 */

export function createFindTool(ctx) {
	const { clampInt, entryLine, findByName, getClient, guarded, resolve } = ctx;
	return {
		name: "zspace_find",
		description:
			"Find files or folders by name inside the 极空间 / ZSpace tree (case-insensitive substring). It scans directories, so it is bounded: pass `path` to narrow the search, and raise `depth` / `scanLimit` when you need more coverage. The result reports how many entries were inspected and whether the scan stopped early — always mention that when reporting a negative result.",
		parameters: {
			keyword: { type: "string", required: true, description: "Name fragment to look for (case-insensitive)." },
			path: { type: "string", description: "Directory to scan (absolute, home:/, public:/, or relative). Default: scan both the personal space and the public space." },
			depth: { type: "integer", description: "Maximum recursion depth, 1-8 (default 4)." },
			limit: { type: "integer", description: "Maximum matches to return, 1-500 (default 50)." },
			scanLimit: { type: "integer", description: "Maximum entries to inspect, 1-20000 (default 2000)." },
		},
		outputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				keyword: { type: "string", required: true },
				roots: { type: "array", required: true, items: { type: "string" } },
				matches: {
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
						},
					},
				},
				scanned: { type: "integer", required: true },
				truncated: { type: "boolean", required: true },
			},
		},
		call: (args) => ({ card: "generic", title: `zspace_find ${args.keyword}`, kind: "search" }),
		render: (_args, value) => {
			const scope = value.roots.join("、");
			const tail = value.truncated ? `（已扫 ${value.scanned} 项后停止，结果可能不完整）` : `（已扫 ${value.scanned} 项）`;
			return [
				{
					type: "text",
					text:
						value.matches.length === 0
							? `在 ${scope} 中没有找到名称含「${value.keyword}」的文件 ${tail}`
							: `${value.matches.map(entry => entryLine(entry)).join("\n")}\n共 ${value.matches.length} 项，范围 ${scope} ${tail}`,
				},
			];
		},
		execute: (args) =>
			guarded(async () => {
				const client = getClient();
				const keyword = String(args.keyword ?? "").trim();
				if (keyword === "") throw new Error("zspace_find: `keyword` must not be blank");
				const roots = args.path ? [await resolve(args.path)] : [await client.homePath(), await client.publicPath()];
				const { matches, scanned, truncated } = await findByName({
					client,
					roots,
					keyword,
					depth: clampInt(args.depth, 4, 1, 8),
					limit: clampInt(args.limit, 50, 1, 500),
					scanLimit: clampInt(args.scanLimit, 2000, 1, 20_000),
				});
				return { keyword, roots, matches, scanned, truncated };
			}),
	};
}
