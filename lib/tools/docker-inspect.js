/**
 * `zspace_docker_inspect` — one atomic capability.
 *
 * @module dsh-zspace/tools
 */

import { inspectContainer, resolveContainer } from "../client/docker.js";

/**
 * Pick the parts of a raw `container_info` payload people actually act on.
 *
 * @param {Record<string, any>} info - raw inspect payload.
 * @returns {Record<string, any>} shaped result.
 */
function summarize(info) {
	const host = info?.HostConfig ?? {};
	const config = info?.Config ?? {};
	return {
		name: String(info?.Name ?? "").replace(/^\/+/, ""),
		id: String(info?.Id ?? ""),
		image: String(config.Image ?? ""),
		created: String(info?.Created ?? ""),
		state: String(info?.State?.Status ?? info?.State ?? ""),
		command: Array.isArray(config.Cmd) ? config.Cmd.join(" ") : "",
		entrypoint: Array.isArray(config.Entrypoint) ? config.Entrypoint.join(" ") : "",
		networkMode: String(host.NetworkMode ?? ""),
		restartPolicy: String(host.RestartPolicy?.Name ?? ""),
		env: (Array.isArray(config.Env) ? config.Env : []).map(String),
		mounts: (Array.isArray(info?.Mounts) ? info.Mounts : []).map(mount => ({
			destination: String(mount?.Destination ?? ""),
			source: String(mount?.Source ?? ""),
			type: String(mount?.Type ?? ""),
		})),
		ports: collectPorts(host),
	};
}

/**
 * Host-port bindings as readable `host->container` lines.
 *
 * @param {Record<string, any>} host - `HostConfig`.
 * @returns {string[]} port strings.
 */
function collectPorts(host) {
	const bindings = host?.PortBindings;
	if (!bindings || typeof bindings !== "object") return [];
	const ports = [];
	for (const [containerPort, hosts] of Object.entries(bindings)) {
		const list = Array.isArray(hosts) ? hosts : [];
		if (list.length === 0) {
			ports.push(containerPort);
			continue;
		}
		for (const binding of list) {
			const hostPort = String(binding?.HostPort ?? "");
			const hostIp = String(binding?.HostIp ?? "");
			ports.push(hostPort ? `${hostIp || "0.0.0.0"}:${hostPort}->${containerPort}` : containerPort);
		}
	}
	return ports;
}

export function createDockerInspectTool(ctx) {
	const { getClient, guarded } = ctx;
	return {
		name: "zspace_docker_inspect",
		description:
			"Show one 极空间 / ZSpace container's full configuration: image, command, entrypoint, env, bind mounts, port bindings, network mode and restart policy. Read-only — take this snapshot before recreating a container, since nothing else records how it was built.",
		parameters: {
			container: { type: "string", required: true, description: "Container name, full id, or a unique id prefix (see zspace_docker_list)." },
		},
		outputSchema: {
			type: "object",
			additionalProperties: false,
			properties: {
				name: { type: "string", required: true },
				id: { type: "string", required: true },
				image: { type: "string", required: true },
				created: { type: "string", required: true },
				state: { type: "string", required: true },
				command: { type: "string", required: true },
				entrypoint: { type: "string", required: true },
				networkMode: { type: "string", required: true },
				restartPolicy: { type: "string", required: true },
				env: { type: "array", required: true, items: { type: "string" } },
				mounts: {
					type: "array",
					required: true,
					items: {
						type: "object",
						additionalProperties: false,
						properties: {
							destination: { type: "string", required: true },
							source: { type: "string", required: true },
							type: { type: "string", required: true },
						},
					},
				},
				ports: { type: "array", required: true, items: { type: "string" } },
			},
		},
		call: (args) => ({ card: "generic", title: `zspace_docker_inspect ${args.container}`, kind: "search" }),
		render: (_args, value) => {
			const head = [
				`${value.name}  (${value.image})`,
				`id：${value.id.slice(0, 12)}   创建：${value.created}   状态：${value.state}`,
				`网络：${value.networkMode}   重启策略：${value.restartPolicy}`,
			];
			if (value.command) head.push(`Cmd：${value.command}`);
			if (value.entrypoint) head.push(`Entrypoint：${value.entrypoint}`);
			const mounts = value.mounts.length
				? value.mounts.map(mount => `  ${mount.destination}  ←  ${mount.source}${mount.type ? `  [${mount.type}]` : ""}`)
				: ["  (无)"];
			const ports = value.ports.length ? value.ports.map(port => `  ${port}`) : ["  (无)"];
			const env = value.env.length ? value.env.map(line => `  ${line}`) : ["  (无)"];
			return [
				{
					type: "text",
					text: [head.join("\n"), "挂载：", ...mounts, "端口：", ...ports, "环境变量：", ...env].join("\n"),
				},
			];
		},
		execute: (args) =>
			guarded(async () => {
				const client = getClient();
				const match = await resolveContainer(client, args.container);
				return summarize(await inspectContainer(client, match.id));
			}),
	};
}
