/**
 * Tool registry for the 极空间 (ZSpace) plugin.
 *
 * One tool per file under `./tools/`, in the order the model should see them.
 * Each factory receives the shared context and returns a plain tool spec, which
 * `lib/index.js` turns into a registered host tool.
 *
 * @module dsh-zspace/tools
 */

import { createResolver, defaultDownloadDir, normalizeRemote } from "./tools/paths.js";
import { clampInt, entryLine, guarded } from "./tools/shared.js";
import { findByName, walkDirectory } from "./tools/walk.js";
import { expandLocalPath } from "./tools/paths.js";
import { createStatusTool } from "./tools/status.js";
import { createLsTool } from "./tools/ls.js";
import { createStatTool } from "./tools/stat.js";
import { createFindTool } from "./tools/find.js";
import { createReadTool } from "./tools/read.js";
import { createDownloadTool } from "./tools/download.js";
import { createUploadTool } from "./tools/upload.js";
import { createMkdirTool } from "./tools/mkdir.js";
import { createRenameTool } from "./tools/rename.js";
import { createMoveTool } from "./tools/move.js";
import { createCopyTool } from "./tools/copy.js";
import { createRemoveTool } from "./tools/remove.js";

export { findByName } from "./tools/walk.js";
export { normalizeRemote } from "./tools/paths.js";

/**
 * Build every tool spec for one plugin instance.
 *
 * @param {{getClient: () => import("./client.js").ZSpaceClient, config: Record<string, any>}} deps - plugin deps.
 * @returns {Array<Record<string, any>>} tool specs in presentation order.
 */
export function createToolSpecs({ getClient, config }) {
	const resolve = (input) => createResolver({ client: getClient() })(input);
	const ctx = {
		getClient,
		config,
		resolve,
		guarded,
		clampInt,
		entryLine,
		walkDirectory,
		findByName,
		expandLocalPath,
		downloadDir: () => defaultDownloadDir(config),
	};

	return [
		createStatusTool(ctx),
		createLsTool(ctx),
		createStatTool(ctx),
		createFindTool(ctx),
		createReadTool(ctx),
		createDownloadTool(ctx),
		createUploadTool(ctx),
		createMkdirTool(ctx),
		createRenameTool(ctx),
		createMoveTool(ctx),
		createCopyTool(ctx),
		createRemoveTool(ctx),
	];
}
