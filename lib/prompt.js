/**
 * The system-prompt section that teaches the model this NAS's path conventions
 * and which tools to reach for. Only injected when `promptEnabled` is true.
 *
 * @module dsh-zspace/prompt
 */

export /**
 * The system-prompt section describing the NAS and its path conveniences.
 *
 * @param {Record<string, any>} config - plugin config.
 * @returns {string} guide text.
 */
function guideText(config) {
	const down = config.downloadDir || "~/Downloads/zspace";
	return [
		"### 极空间 NAS（dsh-zspace）",
		"已通过极空间桌面客户端的本地代理接入这台 NAS，**跨网络可用**（不需要同一局域网、WebDAV 或 SSH，仅要求本机桌面客户端保持登录）。",
		"- 远程路径写法：`home:`＝个人空间根、`public:`＝公共空间根、相对路径＝相对个人空间、以 `/` 开头＝NAS 绝对路径；两个根的真实位置先跑 `zspace_status` 查看。",
		"- 只读：`zspace_ls`（支持 depth 递归）、`zspace_stat`、`zspace_find`（按名称在目录树里遍历查找，受 depth/scanLimit 预算限制，结果里会报告扫了多少项）、`zspace_read`（小文本读入上下文）、`zspace_download`（下载到本机，默认 " +
			down +
			"）。",
		"- 写入：`zspace_upload`（大文件自动分片、支持中文名）、`zspace_mkdir`、`zspace_rename`、`zspace_move`、`zspace_copy`、`zspace_remove`（进回收站，必须显式 confirm=true）。",
		"- 删除/移动/重命名属于破坏性操作：先用 `zspace_ls` 或 `zspace_stat` 核实目标，再执行；批量删除前先向用户确认。",
	].join("\n");
}
