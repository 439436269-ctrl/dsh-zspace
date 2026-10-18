/**
 * `zspace_docker_op` — one atomic capability.
 *
 * The endpoint behind it is **GET** `/zdocker/container_op`; POST answers
 * `404 page not found`. Because that is the namespace's most expensive trap,
 * the method choice lives in `../client/docker.js` and is never a tool argument.
 *
 * @module dsh-zspace/tools
 */

import { CONTAINER_ACTIONS, containerOp, resolveContainer } from "../client/docker.js";

export function createDockerOpTool(ctx) {
	const { getClient, guarded } = ctx;
	return {
		name: "zspace_docker_op",
		description:
			"Run one lifecycle action on a 极空间 / ZSpace container: start / stop / restart / remove / pause. These ZSpace endpoints are GET (POST would 404) — that is handled for you. `remove` deletes the container (bind-mounted data on the NAS survives) and therefore requires confirm=true; run `zspace_docker_health` first, because on a wedged engine every action silently does nothing.",
		parameters: {
			container: { type: "string", required: true, description: "Container name, full id, or a unique id prefix (see zspace_docker_list)." },
			action: { type: "string", required: true, description: `One of ${CONTAINER_ACTIONS.join(" / ")}.` },
			confirm: { type: "boolean", description: "Required for remove: explicit confirmation that this container should be deleted." },
		},
		outputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				container: { type: "string", required: true },
				action: { type: "string", required: true },
				ok: { type: "boolean", required: true },
			},
		},
		call: (args) => ({ card: "generic", title: `zspace_docker_op ${args.action} ${args.container}`, kind: "edit" }),
		render: (_args, value) => [
			{ type: "text", text: `✅ 已提交：${value.container} → ${value.action}（极空间接口只表示命令已受理，状态请用 zspace_docker_list 复核）` },
		],
		execute: (args) =>
			guarded(async () => {
				const action = String(args.action ?? "").toLowerCase();
				if (!CONTAINER_ACTIONS.includes(action)) {
					throw new Error(`zspace_docker_op: 不支持的 action「${action}」，只允许 ${CONTAINER_ACTIONS.join(" / ")}`);
				}
				if (action === "remove" && args.confirm !== true) {
					throw new Error("zspace_docker_op: remove 会删除容器（挂载数据保留），需要 confirm=true 才会执行。");
				}
				const client = getClient();
				const match = await resolveContainer(client, args.container);
				await containerOp(client, match.id, action);
				return { container: match.name, action, ok: true };
			}),
	};
}
