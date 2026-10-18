/**
 * `zspace_docker_logs` — one atomic capability.
 *
 * @module dsh-zspace/tools
 */

import { containerLogs, resolveContainer } from "../client/docker.js";

export function createDockerLogsTool(ctx) {
	const { clampInt, getClient, guarded } = ctx;
	return {
		name: "zspace_docker_logs",
		description:
			"Read the tail of a 极空间 / ZSpace container's log. Read-only. Control bytes from Docker's multiplexed stream are stripped, so the text is directly readable; raise `tail` when the failure is further up than the last 200 lines.",
		parameters: {
			container: { type: "string", required: true, description: "Container name, full id, or a unique id prefix (see zspace_docker_list)." },
			tail: { type: "integer", description: "How many trailing lines to read (default 200, cap 2000)." },
		},
		outputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				container: { type: "string", required: true },
				lines: { type: "integer", required: true },
				log: { type: "string", required: true },
			},
		},
		call: (args) => ({ card: "generic", title: `zspace_docker_logs ${args.container}`, kind: "search" }),
		render: (_args, value) => [
			{
				type: "text",
				text: `=== ${value.container} 最近 ${value.lines} 行 ===\n${value.log || "(日志为空)"}`,
			},
		],
		execute: (args) =>
			guarded(async () => {
				const client = getClient();
				const match = await resolveContainer(client, args.container);
				const tail = clampInt(args.tail, 200, 1, 2000);
				const log = await containerLogs(client, match.id, tail);
				return {
					container: match.name,
					lines: log === "" ? 0 : log.split("\n").length,
					log,
				};
			}),
	};
}
