/**
 * `zspace_docker_list` — one atomic capability.
 *
 * @module dsh-zspace/tools
 */

import { listContainers } from "../client/docker.js";

export function createDockerListTool(ctx) {
	const { getClient, guarded } = ctx;
	return {
		name: "zspace_docker_list",
		description:
			"List the containers on the 极空间 / ZSpace NAS: name, state, status string and id, plus how many are running. Read-only — run `zspace_docker_health` before any stop / remove, and use the exact name or id from here for the other docker tools.",
		parameters: {},
		outputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				count: { type: "integer", required: true },
				running: { type: "integer", required: true },
				containers: {
					type: "array",
					required: true,
					items: {
						type: "object",
						additionalProperties: false,
						properties: {
							name: { type: "string", required: true },
							state: { type: "string", required: true },
							status: { type: "string", required: true },
							id: { type: "string", required: true },
						},
					},
				},
			},
		},
		call: () => ({ card: "generic", title: "zspace_docker_list", kind: "search" }),
		render: (_args, value) => {
			const lines = value.containers.map(
				container => `  ${container.name.padEnd(24)} ${container.state.padEnd(10)} ${container.status}`,
			);
			return [
				{
					type: "text",
					text: `${value.running}/${value.count} 运行中\n${lines.join("\n") || "(没有容器)"}`,
				},
			];
		},
		execute: () =>
			guarded(async () => {
				const containers = await listContainers(getClient());
				return {
					count: containers.length,
					running: containers.filter(container => container.state.toLowerCase() === "running").length,
					containers,
				};
			}),
	};
}
