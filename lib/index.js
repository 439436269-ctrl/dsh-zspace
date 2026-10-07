/**
 * dsh-zspace — 极空间 (ZSpace) NAS tools for DeepSeek Harness.
 *
 * Cross-network by construction: every call rides the desktop client's local
 * proxy, which relays to the NAS over 极空间's cloud/P2P channel. No LAN
 * address, no DDNS, no WebDAV, no SSH, no Python.
 *
 * This entry point only wires things together: it validates config, owns the
 * client lifecycle, contributes the guide section, and registers the tools
 * described in `./tools/`. Configuration lives in `./config.js`, the guide text
 * in `./prompt.js`, the protocol in `./client/`.
 *
 * @module dsh-zspace
 */

import { defineTool } from "@deepseek-ai/dsh-tools";

import { ZSpaceClient } from "./client.js";
import { Config, resolveConfig, validateConfig } from "./config.js";
import { guideText } from "./prompt.js";
import { createToolSpecs } from "./tools.js";

export const name = "zspace";

export const inject = ["tools", "systemPrompt"];

export { Config };

export function apply(ctx, config) {
	const settings = resolveConfig(config);
	validateConfig(settings);

	/** @type {ZSpaceClient|undefined} */
	let client;
	ctx.effect(() => {
		client = new ZSpaceClient({
			baseUrl: settings.baseUrl,
			configDir: settings.configDir || undefined,
			apiVersion: settings.apiVersion,
			homePath: settings.homePath,
			publicPath: settings.publicPath,
			timeoutMs: settings.timeoutMs,
			maxRetries: settings.maxRetries,
			listMaxEntries: settings.listMaxEntries,
			smallUploadMaxBytes: settings.smallUploadMaxBytes,
			sliceSize: settings.sliceSize,
			transportMode: settings.transportMode,
			webdavUrl: settings.webdavUrl,
			webdavUser: settings.webdavUser,
			webdavPassword: settings.webdavPassword,
			webdavHomePath: settings.webdavHomePath,
			webdavPublicPath: settings.webdavPublicPath,
			webdavProbeTimeoutMs: settings.webdavProbeTimeoutMs,
		});
		return () => {
			client = undefined;
		};
	});

	/**
	 * The live client, or a loud failure — reached only while the fiber is active.
	 *
	 * @returns {ZSpaceClient} live client.
	 */
	const getClient = () => {
		if (!client) throw new Error("zspace: client is not available");
		return client;
	};

	if (settings.promptEnabled) {
		ctx.systemPrompt.section({
			name: "zspace:guide",
			order: settings.promptOrder,
			text: () => guideText(settings),
		});
	}

	for (const spec of createToolSpecs({ getClient, config: settings })) {
		ctx.tools.register(
			defineTool({
				name: spec.name,
				description: spec.description,
				parameters: spec.parameters,
				output: {
					schema: spec.outputSchema,
					render: spec.render,
					...(spec.presentationMeta ? { presentationMeta: spec.presentationMeta } : {}),
				},
				...(spec.call ? { presentCall: spec.call } : {}),
				execute: spec.execute,
			}),
		);
	}
}
