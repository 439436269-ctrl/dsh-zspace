#!/usr/bin/env node
/**
 * Live smoke test for the Docker / system capabilities against a real 极空间 NAS.
 *
 * It talks to the NAS exactly the way the tools do — through
 * `lib/client/docker.js` over the desktop client's local proxy — and **never**
 * performs a lifecycle action or a reboot: everything here is read-only, so it
 * is safe to run on a box that is hosting something.
 *
 *   node scripts/docker-selftest.js
 *
 * Checks: login state → Docker service → container list → inspect → logs
 * (non-empty) → engine-health verdict. Exits non-zero when a check fails.
 */

import process from "node:process";

import { ZSpaceClient } from "../lib/client.js";
import {
	containerLogs,
	engineHealth,
	inspectContainer,
	listContainers,
	serviceStatus,
} from "../lib/client/docker.js";

const client = new ZSpaceClient({ timeoutMs: 30_000 });

/** @type {number} */
let failures = 0;

/**
 * Print one check.
 *
 * @param {string} name - what was checked.
 * @param {boolean} ok - outcome.
 * @param {string} [detail] - extra context.
 * @returns {void}
 */
function check(name, ok, detail = "") {
	console.log(`${ok ? "  ✅" : "  ❌"} ${name}${detail ? `  ${detail}` : ""}`);
	if (!ok) failures += 1;
}

/**
 * First line of an error message.
 *
 * @param {unknown} error - thrown value.
 * @returns {string} one-line message.
 */
function oneLine(error) {
	return String(error?.message ?? error).split("\n")[0];
}

console.log("=== 1) 登录态发现 ===");
try {
	const identity = client.identity;
	check("找到 vuex.json", Boolean(identity.vuexPath), identity.vuexPath);
	check("拿到 token（不打印）", Boolean(client.credentials.token));
	check("nasId 非空", Boolean(identity.nasId), identity.nasId ? `${identity.nasId.slice(0, 6)}…` : "");
} catch (error) {
	check("登录态", false, oneLine(error));
	process.exit(1);
}

console.log("\n=== 2) Docker 服务状态 ===");
let service = "";
try {
	service = await serviceStatus(client);
	check("system_status 可读", service === "on" || service === "off", `status=${service || "(空)"}`);
} catch (error) {
	check("system_status 可读", false, oneLine(error));
}

console.log("\n=== 3) 容器列表（GET /zdocker/container_list） ===");
let containers = [];
try {
	containers = await listContainers(client);
	check("container_list 有返回", containers.length > 0, `${containers.length} 个`);
	for (const container of containers) {
		console.log(`     ${container.name.padEnd(24)} ${container.state.padEnd(10)} ${container.status}`);
	}
	check(
		"每行都有 name/state/id",
		containers.every(item => item.name && item.state && item.id),
	);
} catch (error) {
	check("container_list 有返回", false, oneLine(error));
}

console.log("\n=== 4) 详情与日志（挑一个运行中的容器） ===");
const running = containers.find(item => item.state.toLowerCase() === "running");
const probe = running ?? containers[0];
if (!probe) {
	console.log("  ⚠️ 没有容器可探，跳过第 4、5 步");
} else {
	try {
		const info = await inspectContainer(client, probe.id);
		const image = String(info?.Config?.Image ?? "");
		check("container_info 有镜像", Boolean(image), image);
		check("container_info 有 HostConfig/Config", Boolean(info?.HostConfig && info?.Config));
		console.log(
			`     ${String(info?.Name ?? probe.name).replace(/^\/+/, "")}  mounts=${(info?.Mounts ?? []).length}  env=${(info?.Config?.Env ?? []).length}`,
		);
	} catch (error) {
		check("container_info", false, oneLine(error));
	}

	try {
		// 有的容器（如 ddns-go）日志稀疏，逐个试到非空为止，避免把"这个容器没日志"误判成协议失败。
		let log = "";
		let used = "";
		for (const candidate of [probe, ...containers.filter(item => item.id !== probe.id)]) {
			const text = await containerLogs(client, candidate.id, 20);
			if (text.trim() !== "") {
				log = text;
				used = candidate.name;
				break;
			}
		}
		check("container_logs 有内容", log.trim() !== "", used ? `${used} / ${log.split("\n").length} 行` : "所有容器都不足 20 行");
		if (log.trim() !== "") {
			const tail = log.trim().split("\n").slice(-3).join("\n       ");
			console.log(`     尾部：${tail}`);
		}
	} catch (error) {
		check("container_logs", false, oneLine(error));
	}
}

console.log("\n=== 5) 引擎健康判据（本次最关键） ===");
if (!running) {
	console.log("  ⚠️ 没有运行中的容器：container_top 会短路，结论不可信 —— 跳过");
} else {
	try {
		const health = await engineHealth(client, running.id);
		check(
			"判据返回合法枚举",
			["healthy", "containerd-wedged", "container-not-running", "error"].includes(health.verdict),
			`verdict=${health.verdict}  processes=${health.processCount}`,
		);
		check("本次要求 healthy", health.verdict === "healthy", health.verdict === "healthy" ? "" : "引擎当前不是 healthy，见下方细节");
		if (health.verdict === "healthy") check("healthy 时进程数 > 0", health.processCount > 0, `${health.processCount} 个进程`);
		if (health.detail) console.log(`     细节：${health.detail.slice(0, 200)}`);
	} catch (error) {
		check("引擎健康判据", false, oneLine(error));
	}
}

console.log(`\n${failures === 0 ? "★★★ 全部通过" : `✗ ${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
