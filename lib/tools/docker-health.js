/**
 * `zspace_docker_health` — one atomic capability.
 *
 * The whole point of this tool is that the obvious health check **lies**:
 * `container_top` answers `container <id> is not running` for a stopped
 * container without ever touching containerd, so "it answered" is not health.
 * Only a real `Processes` array counts, and the socket-timeout text is wedge.
 *
 * @module dsh-zspace/tools
 */

import { engineHealth, listContainers, matchContainer, serviceStatus } from "../client/docker.js";

/** Icons for the verdicts this tool can return. */
const ICONS = {
	healthy: "✅",
	"containerd-wedged": "❌",
	"container-not-running": "⚠️",
	"service-off": "⏸️",
	error: "⚠️",
};

export function createDockerHealthTool(ctx) {
	const { getClient, guarded } = ctx;
	return {
		name: "zspace_docker_health",
		description:
			"Diagnose whether the 极空间 / ZSpace Docker engine is really healthy. `verdict` is one of: `healthy` (container_top returned a real process list, so containerd works), `containerd-wedged` (containerd socket timeout — every container start/stop/remove will silently fail and only a whole-NAS reboot fixes it), `container-not-running` (the probe container is stopped, so container_top proves nothing), `service-off` (Docker service is off), `error`. Run this before zspace_docker_op whenever anything looked odd.",
		parameters: {
			container: {
				type: "string",
				description: "Optional probe container (name or id). Must be running to be meaningful; omit to use the first running container, which is the normal case.",
			},
		},
		outputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				service: { type: "string", required: true },
				verdict: { type: "string", required: true },
				probeContainer: { type: "string", required: true },
				processCount: { type: "integer", required: true },
				detail: { type: "string", required: true },
			},
		},
		call: () => ({ card: "generic", title: "zspace_docker_health", kind: "execute" }),
		render: (_args, value) => {
			const lines = [
				`${ICONS[value.verdict] ?? "⚠️"} 引擎判据：${value.verdict}`,
				`Docker 服务：${value.service || "(未报告)"}`,
				`探针容器：${value.probeContainer || "(无运行中的容器)"}`,
				value.processCount ? `进程数：${value.processCount}` : "",
				value.detail ? `细节：${value.detail}` : "",
			];
			if (value.verdict === "containerd-wedged") {
				lines.push("→ containerd 卡死：container_op 全部无效，system_restart 只重启 dockerd 救不了 —— 只能 `zspace_system_reboot`（整机重启，约 7~8 分钟）。");
			}
			if (value.verdict === "container-not-running") {
				lines.push("→ 探针容器没在运行，container_top 根本不会碰 containerd，这个结论不可信：换一个正在运行的容器再探。");
			}
			if (value.verdict === "service-off") {
				lines.push("→ Docker 服务是关的：先开服务，任何容器操作都不会成功。");
			}
			return [{ type: "text", text: lines.filter(Boolean).join("\n") }];
		},
		execute: (args) =>
			guarded(async () => {
				const client = getClient();
				const notes = [];
				let service = "";
				try {
					service = await serviceStatus(client);
				} catch (error) {
					notes.push(`服务状态读取失败：${error.message}`);
				}

				let containers;
				try {
					containers = await listContainers(client);
				} catch (error) {
					return {
						service,
						verdict: "error",
						probeContainer: "",
						processCount: 0,
						detail: [...notes, `容器列表读取失败：${error.message}`].join("；").slice(0, 300),
					};
				}

				if (service === "off") {
					return {
						service,
						verdict: "service-off",
						probeContainer: "",
						processCount: 0,
						detail: [...notes, "Docker 服务当前是 off"].join("；").slice(0, 300),
					};
				}

				const wanted = String(args.container ?? "").trim();
				const probe = wanted ? matchContainer(containers, wanted) : containers.find(item => item.state.toLowerCase() === "running");
				if (!probe) {
					return {
						service,
						verdict: "container-not-running",
						probeContainer: "",
						processCount: 0,
						detail: [...notes, wanted ? `没有找到容器「${wanted}」` : "没有任何容器在运行，container_top 会短路，无法证明引擎健康"]
							.join("；")
							.slice(0, 300),
					};
				}
				if (probe.state.toLowerCase() !== "running") {
					return {
						service,
						verdict: "container-not-running",
						probeContainer: probe.name,
						processCount: 0,
						detail: [...notes, `探针容器当前状态 ${probe.state || "(未知)"}，container_top 不碰 containerd，结论不可信`]
							.join("；")
							.slice(0, 300),
					};
				}

				const health = await engineHealth(client, probe.id);
				return {
					service,
					verdict: health.verdict,
					probeContainer: probe.name,
					processCount: health.processCount,
					detail: [...notes, health.detail].filter(Boolean).join("；").slice(0, 300),
				};
			}),
	};
}
