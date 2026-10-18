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
		"这台 NAS 有两条通道，插件自动选路：**同一网络时直连 WebDAV**（更快、不依赖桌面客户端），**跨网络时走桌面客户端云中转**。当前在用哪条、以及另一条为什么没选，跑 `zspace_status` 看（它的 transport / webdavProbe 字段）。跨网络只要求桌面客户端保持登录。",
		"- 远程路径写法：`home:`＝个人空间根、`public:`＝公共空间根、相对路径＝相对个人空间、以 `/` 开头＝NAS 绝对路径；两个根的真实位置先跑 `zspace_status` 查看。",
		"- 只读：`zspace_ls`（支持 depth 递归）、`zspace_stat`、`zspace_find`（按名称在目录树里遍历查找，受 depth/scanLimit 预算限制，结果里会报告扫了多少项）、`zspace_read`（小文本读入上下文）、`zspace_download`（下载到本机，默认 " +
			down +
			"）。",
		"- 写入：`zspace_upload`（本地文件，大文件自动分片，支持中文名）、`zspace_write`（**文本直接写进 NAS**，省掉本地临时文件；默认覆盖，`overwrite: false` 时拒绝覆盖）、`zspace_mkdir`、`zspace_rename`、`zspace_move`、`zspace_copy`、`zspace_remove`（必须显式 confirm=true）。",
		"- 删除/移动/重命名属于破坏性操作：先用 `zspace_ls` 或 `zspace_stat` 核实目标，再执行；批量删除前先向用户确认。",
		"- 删除语义随通道而变：云中转通道进 NAS 回收站；**WebDAV 直连通道由 NAS 侧决定**（通常不进回收站）。要确保可找回，就先用 `zspace_status` 确认当前通道，或临时把 `transportMode` 设为 `relay`。",
		"### 极空间 Docker 与整机（dsh-zspace）",
		"- 只读：`zspace_docker_list`（name/state/status/id）、`zspace_docker_inspect`（镜像/env/挂载/端口/网络/重启策略，重建容器前先留底）、`zspace_docker_logs`（尾部日志）。",
		"- **先判引擎再动手**：跑 `zspace_docker_health`。`container_top` 在容器没运行时会直接返回 `is not running`、**根本不碰 containerd**，所以它报「正常」不能证明引擎健康；只有返回真实 Processes 才算 `healthy`。",
		"- `verdict=containerd-wedged`（报 `dial unix:///run/containerd/containerd.sock: timeout`）时，start/stop/restart/remove **全部静默失效**；`system_restart` 只重启 dockerd 救不了 —— **只能整机重启 `zspace_system_reboot`（必须 confirm=true，约 7~8 分钟）**。",
		"- `zspace_docker_op` 的五个动作（start/stop/restart/remove/pause）在极空间那边是 **GET** 端点，传 POST 一律 404 —— 插件已按 GET 发，你只需给 `action`；`remove` 必须先拿到用户同意并传 confirm=true（挂载数据保留，容器本身删除）。",
	].join("\n");
}
