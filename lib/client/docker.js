/**
 * Docker / 整机能力：容器列表、详情、日志、生命周期、引擎健康判据、整机重启。
 *
 * 这里只负责 **URL 形状 + 响应语义**；鉴权（Cookie）与 HTTP 发送全部复用
 * `./transport.js`（`endpointUrl` / `client.send`）与 `./session.js`（`authHeaders`），
 * 不重复实现 fetch、超时与重试。
 *
 * 四条协议事实（2026-10-18 真机实测，写进代码就是不想再踩一遍）：
 *
 * 1. **方法不对称**：`/zdocker/container_op`（start/stop/restart/remove/pause）是
 *    **GET**；`/zdocker/system_restart` 与 `/system/reboot` 是 **POST**。传错方法
 *    一律 `404 page not found`（openresty 的纯文本，不是 JSON 包封）。
 * 2. **HTTP 200 ≠ 成功**：业务失败时 HTTP 仍是 200，但 `code` 字段是**错误文本本身**
 *    （`Error response from daemon: ...`）。只看状态码会把失败当成功，必须解析 `code`。
 * 3. **`/system/reboot` 不在 `/zdocker` 命名空间下**：它重启整台 NAS，是 containerd
 *    卡死时**唯一**能救的手段（`/zdocker/system_restart` 只重启 dockerd，救不了）。
 * 4. **`container_top` 当健康检查有陷阱**：容器没运行时它直接返回
 *    `container <id> is not running`，**根本不碰 containerd** —— 所以它报「正常」
 *    不能证明引擎健康。只有返回真实 `Processes` 数组才算 healthy；报
 *    `dial unix:///run/containerd/containerd.sock: timeout` 才是 wedge。
 *
 * 为什么不用 `commonParams`：那些（`token` / `nasid` / `plat` …）属于 `/v2/file/*`
 * 的 **form body**，塞进 query 会被 NAS 判成 `N001212`；`/zdocker/*` 的实测请求
 * 只带 Cookie + `?&rnd=…&webagent=v2`，所以这里显式只带 `authHeaders`。
 *
 * @module dsh-zspace/client/docker
 */

import { endpointUrl } from "./transport.js";
import { authHeaders } from "./session.js";
import { ZSpaceError } from "./errors.js";

/** 业务成功的 `code`（字符串，不是数字）。 */
const OK_CODE = "200";

/** 容器生命周期动作 —— 全部挂在 GET `/zdocker/container_op` 的 `action` 上。 */
export const CONTAINER_ACTIONS = ["start", "stop", "restart", "remove", "pause"];

/** 日志里多路复用流的控制字节（`\x01`、长度前缀）：读之前必须洗掉。 */
const CONTROL_BYTES = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g;

/**
 * Docker 多路复用流的一帧开头的 8 字节头：1 字节流类型（1=stdout, 2=stderr）
 * + 3 个 0 + 4 字节大端长度。JSON 里长度字节可能已被 UTF-8 解码成 U+FFFD，
 * 仍按「4 个字符」吃掉，否则长度末字节会以 `j`、`;`、`�` 之类的形式串到日志行首
 * （2026-10-18 真机实测就是这个形状）。
 */
const MUX_FRAME_HEADER = /[\x01\x02]\x00\x00\x00[\s\S]{4}/g;

/**
 * One Docker-namespace failure, with the next actionable step attached.
 */
export class ZSpaceDockerError extends ZSpaceError {
	/**
	 * @param {string} code - daemon error text or synthetic marker (`HTTP404`, `EBADDOCKERJSON`).
	 * @param {string} message - human-readable message.
	 * @param {{endpoint?: string, cause?: unknown}} [options] - context.
	 */
	constructor(code, message, options = {}) {
		super(String(code), message, options);
		this.name = "ZSpaceDockerError";
	}

	/**
	 * Actionable next step for the failures this namespace actually produces.
	 *
	 * @returns {string|undefined} hint text.
	 */
	get hint() {
		const text = `${this.code} ${this.message}`;
		if (this.code === "HTTP404" || /404 page not found/i.test(text)) {
			return "404 基本都是**方法传错**：container_op 是 GET，system_restart 与 /system/reboot 是 POST。";
		}
		if (/dial unix:\/\/\/run\/containerd\/containerd\.sock: timeout/i.test(text)) {
			return "containerd 卡死了：此时任何 container_op 都不会生效，system_restart 也救不了 —— 只能整机重启（zspace_system_reboot，约 7~8 分钟）。";
		}
		if (/is not running/i.test(text)) {
			return "该容器当前没在运行：先用 zspace_docker_list 看 state，需要时用 zspace_docker_op 的 action=start。";
		}
		if (/No such container/i.test(text)) {
			return "容器名/id 不对：先用 zspace_docker_list 拿到准确的名字或 id。";
		}
		if (/driver failed programming external connectivity/i.test(text)) {
			return "Docker 的网络层（网桥/端口）也坏了，属于引擎整体退化，通常只能整机重启。";
		}
		if (/port is already allocated/i.test(text)) {
			return "端口被别的容器占了：先 zspace_docker_list 找出占用者。";
		}
		if (/is already in use|already exists|Conflict/i.test(text)) {
			return "容器已处于该状态，或名字/端口冲突 —— 先 zspace_docker_list / zspace_docker_inspect 核实。";
		}
		return undefined;
	}
}

/**
 * Send one Docker-namespace request and unwrap its `data`.
 *
 * @param {import("../client.js").ZSpaceClient} client - live client.
 * @param {string} endpoint - API path, e.g. `/zdocker/container_list`.
 * @param {object} [options] - request options.
 * @param {"GET"|"POST"} [options.method] - HTTP method (`GET` unless documented otherwise).
 * @param {Record<string, unknown>} [options.query] - query fields (container_id, action, tail…).
 * @param {Record<string, unknown>} [options.body] - JSON body for POST endpoints.
 * @returns {Promise<any>} the unwrapped `data`.
 * @throws {ZSpaceDockerError} on a bad method, non-JSON text or a non-`200` `code`.
 */
async function request(client, endpoint, options = {}) {
	const method = options.method ?? "GET";
	const headers = { ...authHeaders(client), Accept: "application/json" };
	const payload = method === "POST" ? { ...(options.body ?? {}) } : undefined;
	if (payload !== undefined) headers["Content-Type"] = "application/json";

	const response = await client.send({
		method,
		endpoint,
		url: endpointUrl(client, endpoint, options.query ?? {}),
		headers,
		...(payload === undefined ? {} : { body: Buffer.from(JSON.stringify(payload), "utf8") }),
	});

	if (response.status === 404) {
		throw new ZSpaceDockerError("HTTP404", `404 page not found（${endpoint}）—— 这个方法/路径在 NAS 上没有路由`, { endpoint });
	}
	if (response.status >= 400) {
		throw new ZSpaceDockerError(`HTTP${response.status}`, `HTTP ${response.status} on ${endpoint}: ${response.text.slice(0, 200)}`, {
			endpoint,
		});
	}

	let body;
	try {
		body = JSON.parse(response.text);
	} catch {
		throw new ZSpaceDockerError("EBADDOCKERJSON", `${endpoint} 返回了非 JSON 内容：${response.text.slice(0, 200)}`, { endpoint });
	}
	const code = String(body?.code ?? "");
	if (code !== OK_CODE) {
		throw new ZSpaceDockerError(code || "EEMPTYCODE", `极空间 Docker 接口报错（${endpoint}）：${code || "(空 code)"}`, { endpoint });
	}
	return body.data;
}

/**
 * A view of the same client that never retries — used for the one destructive
 * POST in this module. A retried reboot would submit the command twice.
 *
 * @param {import("../client.js").ZSpaceClient} client - live client.
 * @returns {import("../client.js").ZSpaceClient} client view with `maxRetries = 0`.
 */
function withoutRetries(client) {
	const view = Object.create(client);
	view.maxRetries = 0;
	return view;
}

/**
 * Docker service state as the NAS reports it.
 *
 * @param {import("../client.js").ZSpaceClient} client - live client.
 * @returns {Promise<string>} `"on"` / `"off"` (or `""` when the NAS says nothing).
 */
export async function serviceStatus(client) {
	const data = await request(client, "/zdocker/system_status");
	return String(data?.status ?? "");
}

/**
 * Every container, normalized.
 *
 * @param {import("../client.js").ZSpaceClient} client - live client.
 * @returns {Promise<Array<{name: string, state: string, status: string, id: string}>>} containers.
 */
export async function listContainers(client) {
	const data = await request(client, "/zdocker/container_list");
	const raw = Array.isArray(data) ? data : Array.isArray(data?.containers) ? data.containers : [];
	return raw.map(container => ({
		name: String(container.Names ?? container.name ?? "").replace(/^\/+/, ""),
		state: String(container.State ?? container.state ?? ""),
		status: String(container.Status ?? container.status ?? ""),
		id: String(container.Id ?? container.id ?? ""),
	}));
}

/**
 * Match a user-typed container reference (name, full id or id prefix) against an
 * already-fetched list — name first, then exact id, then id prefix.
 *
 * @param {Array<{name: string, state: string, status: string, id: string}>} containers - live list.
 * @param {string} reference - container name or id (prefix).
 * @returns {{name: string, state: string, status: string, id: string}|undefined} the match, if any.
 */
export function matchContainer(containers, reference) {
	const wanted = String(reference ?? "").trim().toLowerCase();
	if (wanted === "") return undefined;
	return (
		containers.find(container => container.name.toLowerCase() === wanted) ??
		containers.find(container => container.id.toLowerCase() === wanted) ??
		containers.find(container => container.id.toLowerCase().startsWith(wanted))
	);
}

/**
 * Resolve a container reference against the live list, so every later call uses
 * the id the NAS itself reported.
 *
 * @param {import("../client.js").ZSpaceClient} client - live client.
 * @param {string} reference - container name or id (prefix).
 * @returns {Promise<{name: string, state: string, status: string, id: string}>} the matched container.
 * @throws {ZSpaceDockerError} when nothing matches.
 */
export async function resolveContainer(client, reference) {
	const wanted = String(reference ?? "").trim();
	if (wanted === "") throw new ZSpaceDockerError("ENOCONTAINER", "需要一个容器名或 id（先用 zspace_docker_list 看有哪些）");
	const containers = await listContainers(client);
	const match = matchContainer(containers, wanted);
	if (!match) {
		const known = containers.map(container => container.name).filter(Boolean).join(" / ") || "(没有任何容器)";
		throw new ZSpaceDockerError("ENOCONTAINER", `没有找到容器「${wanted}」。现有容器：${known}`);
	}
	return match;
}

/**
 * Raw `container_info` payload (Docker inspect shape + 极空间 extensions).
 *
 * @param {import("../client.js").ZSpaceClient} client - live client.
 * @param {string} containerId - container id or name.
 * @returns {Promise<Record<string, any>>} inspect payload.
 */
export async function inspectContainer(client, containerId) {
	return await request(client, "/zdocker/container_info", { query: { container_id: containerId } });
}

/**
 * Tail of one container's log, with the multiplexed-stream control bytes removed.
 *
 * @param {import("../client.js").ZSpaceClient} client - live client.
 * @param {string} containerId - container id or name.
 * @param {number} [tail] - trailing line count.
 * @returns {Promise<string>} cleaned log text.
 */
export async function containerLogs(client, containerId, tail = 200) {
	const data = await request(client, "/zdocker/container_logs", {
		query: { container_id: containerId, tail: Number(tail) || 200 },
	});
	const raw = typeof data === "string" ? data : String(data?.data ?? "");
	// 先按帧头剥（此时 \x00 还在，才能匹配），再清剩下的控制字节。
	return raw.replace(MUX_FRAME_HEADER, "").replace(CONTROL_BYTES, "");
}

/**
 * Container lifecycle action.
 *
 * ⚠️ This endpoint is **GET**. Sending POST answers `404 page not found` — the
 * single most expensive trap in this namespace.
 *
 * @param {import("../client.js").ZSpaceClient} client - live client.
 * @param {string} containerId - container id or name.
 * @param {"start"|"stop"|"restart"|"remove"|"pause"} action - lifecycle action.
 * @returns {Promise<any>} the endpoint's `data` (usually `null`).
 */
export async function containerOp(client, containerId, action) {
	return await request(client, "/zdocker/container_op", { query: { container_id: containerId, action } });
}

/**
 * `container_top` payload — the only honest engine probe.
 *
 * @param {import("../client.js").ZSpaceClient} client - live client.
 * @param {string} containerId - a **running** container's id.
 * @returns {Promise<Record<string, any>>} payload with `Titles` / `Processes`.
 */
export async function containerTop(client, containerId) {
	return await request(client, "/zdocker/container_top", { query: { container_id: containerId } });
}

/**
 * The engine health verdict.
 *
 * The asymmetry that makes this necessary: `container_top` short-circuits with
 * `is not running` for a stopped container **without touching containerd**, so
 * "it answered" proves nothing. Only a real `Processes` array does.
 *
 * @param {import("../client.js").ZSpaceClient} client - live client.
 * @param {string} probeContainerId - a container that is **running** right now.
 * @returns {Promise<{verdict: "healthy"|"containerd-wedged"|"container-not-running"|"error", processCount: number, detail: string}>} verdict.
 */
export async function engineHealth(client, probeContainerId) {
	try {
		const top = await containerTop(client, probeContainerId);
		const processes = Array.isArray(top?.Processes) ? top.Processes : null;
		if (processes === null) {
			const detail = String(top?.message ?? top?.msg ?? "").slice(0, 300) || "container_top 没有返回 Processes 数组";
			return { verdict: "error", processCount: 0, detail };
		}
		return { verdict: "healthy", processCount: processes.length, detail: "" };
	} catch (error) {
		const text = `${error?.code ?? ""} ${error?.message ?? ""}`;
		if (/dial unix:\/\/\/run\/containerd\/containerd\.sock/i.test(text)) {
			return { verdict: "containerd-wedged", processCount: 0, detail: String(error?.message ?? error).slice(0, 300) };
		}
		if (/is not running/i.test(text)) {
			return { verdict: "container-not-running", processCount: 0, detail: String(error?.message ?? error).slice(0, 300) };
		}
		return { verdict: "error", processCount: 0, detail: String(error?.message ?? error).slice(0, 300) };
	}
}

/**
 * Reboot the whole NAS.
 *
 * ⚠️ `POST /system/reboot` — **not** under `/zdocker`, and **not**
 * `/zdocker/system_restart` (that only restarts dockerd). This is the only
 * API-level recovery for a wedged containerd.
 *
 * @param {import("../client.js").ZSpaceClient} client - live client.
 * @returns {Promise<any>} the endpoint's `data`.
 */
export async function rebootNas(client) {
	// 破坏性操作：不重试。超时后重发等于再下一次重启命令。
	return await request(withoutRetries(client), "/system/reboot", { method: "POST", body: {} });
}
