/**
 * `zspace_system_reboot` — one atomic capability.
 *
 * It gets its own file for the same reason the protocol note exists: this is the
 * **only** API-level recovery for a wedged containerd, and it lives outside the
 * `/zdocker` namespace (`POST /system/reboot`), so a scan of `/zdocker/*` will
 * never find it. `/zdocker/system_restart` restarts dockerd and does not help.
 *
 * @module dsh-zspace/tools
 */

import { rebootNas } from "../client/docker.js";

export function createSystemRebootTool(ctx) {
	const { getClient, guarded } = ctx;
	return {
		name: "zspace_system_reboot",
		description:
			"Reboot the whole 极空间 / ZSpace NAS (POST /system/reboot). This is the ONLY recovery for a wedged containerd — the Docker-engine restart only restarts dockerd and cannot help. Takes about 7-8 minutes; every container with a restart policy comes back on its own. Requires confirm=true.",
		parameters: {
			confirm: { type: "boolean", required: true, description: "Must be true — explicit confirmation that the whole NAS should reboot (all services drop for ~7-8 minutes)." },
		},
		outputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				ok: { type: "boolean", required: true },
				message: { type: "string", required: true },
			},
		},
		call: () => ({ card: "generic", title: "zspace_system_reboot", kind: "edit" }),
		render: (_args, value) => [{ type: "text", text: value.ok ? `🔁 ${value.message}` : `❌ ${value.message}` }],
		execute: (args) =>
			guarded(async () => {
				if (args.confirm !== true) {
					throw new Error("zspace_system_reboot: 整机重启会让所有服务中断 7~8 分钟，必须显式传 confirm=true（先用 zspace_docker_health 确认真的 wedge 了）。");
				}
				await rebootNas(getClient());
				return {
					ok: true,
					message: "已提交整机重启（POST /system/reboot）。NAS 约 7~8 分钟后回来，容器按各自 restart 策略自动拉起。",
				};
			}),
	};
}
