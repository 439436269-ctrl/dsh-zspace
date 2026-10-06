/**
 * NAS business codes and the single error type every layer raises.
 *
 * @module dsh-zspace/client
 */

/**
 * Business codes the desktop client treats as fatal during sliced uploads —
 * retrying them only burns time (permission / conflicting dir / safe-box).
 */
export const UPLOAD_FATAL_CODES = new Set(["N001302", "N001331", "N001603", "N001397"]);

/**
 * One ZSpace API or transport failure.
 *
 * `code` is the NAS business code (`N001411`, …) when the response parsed,
 * or a synthetic marker (`HTTP413`, `EPROXY`, …) otherwise.
 */
export class ZSpaceError extends Error {
/**
 * @param {string} code - NAS business code or synthetic marker.
 * @param {string} message - human-readable message.
 * @param {{endpoint?: string, cause?: unknown}} [options] - context.
 */
constructor(code, message, options = {}) {
	super(message, options.cause === undefined ? undefined : { cause: options.cause });
	this.name = "ZSpaceError";
	this.code = String(code);
	this.endpoint = options.endpoint ?? "";
}

/**
 * Actionable next step for known codes, or `undefined`.
 *
 * @returns {string|undefined} hint text.
 */
get hint() {
	const message = this.message;
	if (this.code === "N001411" || /无权限/.test(message)) {
		return "没有权限：确认该账号对目标路径可访问（「/」与裸盘根目录总是拒绝的，先 ls 已知的空间根，例如 home: 或 public:）。";
	}
	if (this.code === "N001315" || /不存在/.test(message)) {
		return "路径不存在：先列出上级目录确认拼写，注意大小写与中文全角字符。";
	}
	if (this.code === "N001212") {
		return "参数有误：路径必须以 / 开头（或用 home: / public: / 相对路径）。";
	}
	if (this.code === "HTTP413") {
		return "本地代理拒绝超大请求体：大文件会自动改走分片上传，若仍失败请降低分片大小。";
	}
	if (this.code === "EPROXY") {
		return "连不上极空间桌面客户端本地代理：确认客户端已安装、已登录并在运行（端口 13579）。";
	}
	return undefined;
}
}
