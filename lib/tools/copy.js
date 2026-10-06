/**
 * `zspace_copy` — one atomic capability.
 *
 * @module dsh-zspace/tools
 */

export function createCopyTool(ctx) {
	const { getClient, guarded, resolve } = ctx;
	return {
		name: "zspace_copy",
		description: "Copy files or directories into another directory on the 极空间 / ZSpace NAS (server-side copy, no download).",
		parameters: {
			paths: { type: "array", required: true, items: { type: "string" }, description: "Source paths." },
			to: { type: "string", required: true, description: "Destination directory." },
		},
		outputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				ok: { type: "boolean", required: true },
				count: { type: "integer", required: true },
				to: { type: "string", required: true },
			},
		},
		call: (args) => ({ card: "generic", title: `zspace_copy ${(args.paths ?? []).length} 项`, kind: "edit" }),
		render: (_args, value) => [{ type: "text", text: `已复制 ${value.count} 项 → ${value.to}` }],
		execute: (args) =>
			guarded(async () => {
				const client = getClient();
				const sources = await Promise.all((args.paths ?? []).map(item => resolve(item)));
				if (sources.length === 0) throw new Error("zspace_copy: `paths` must not be empty");
				const destination = await resolve(args.to);
				await client.copy(sources, destination);
				return { ok: true, count: sources.length, to: destination };
			}),
	};
}
