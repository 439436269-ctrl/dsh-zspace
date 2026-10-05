/**
 * Type surface for @deepseek-ai/dsh-tools / cordis consumers.
 * The implementation is plain JavaScript; these declarations exist so a
 * TypeScript host can type the plugin entry without a build step.
 */

import type { Context } from "@deepseek-ai/cordis";

/** Cordis plugin name. */
export declare const name: "zspace";
/** Services this plugin requires. */
export declare const inject: readonly ["tools", "systemPrompt"];
/** Config schema (schemastery). */
export declare const Config: unknown;

/**
 * Mount the plugin.
 *
 * @param ctx - Cordis context providing `tools` and `systemPrompt`.
 * @param config - validated plugin config.
 */
export declare function apply(ctx: Context, config: Record<string, unknown>): void;
