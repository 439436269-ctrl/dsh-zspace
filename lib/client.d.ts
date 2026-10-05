/** Type surface for the dependency-free ZSpace client. */

/** NAS business code or synthetic transport marker. */
export type ZSpaceErrorCode = string;

/** One ZSpace API or transport failure. */
export declare class ZSpaceError extends Error {
	readonly code: ZSpaceErrorCode;
	readonly endpoint: string;
	/** Actionable next step for known codes. */
	readonly hint: string | undefined;
	constructor(code: string, message: string, options?: { endpoint?: string; cause?: unknown });
}

/** Normalized NAS entry. */
export interface ZSpaceEntry {
	name: string;
	path: string;
	dir: boolean;
	size: number;
	modified: string;
	created: string;
	ext: string;
}

/** Client construction options. */
export interface ZSpaceClientOptions {
	baseUrl?: string;
	configDir?: string;
	apiVersion?: string;
	credentials?: { token: string; nasId: string; deviceId: string; device?: string; appVersion?: string; username?: string };
	homePath?: string;
	publicPath?: string;
	timeoutMs?: number;
	maxRetries?: number;
	retryDelayMs?: number;
	pageSize?: number;
	listMaxEntries?: number;
	smallUploadMaxBytes?: number;
	sliceSize?: number;
}

/** Cross-network ZSpace NAS client (desktop client local proxy). */
export declare class ZSpaceClient {
	readonly baseUrl: string;
	readonly identity: { username: string; nasId: string; deviceId: string; vuexPath: string };
	constructor(options?: ZSpaceClientOptions);
	check(): Promise<boolean>;
	pools(): Promise<Array<{ name: string; status: string; totalSize: number; freeSize: number }>>;
	isDirectory(remotePath: string): Promise<boolean>;
	homePath(): Promise<string>;
	publicPath(): Promise<string>;
	list(remotePath: string, options?: { showHidden?: boolean; maxEntries?: number }): Promise<{ entries: ZSpaceEntry[]; truncated: boolean }>;
	info(remotePath: string): Promise<ZSpaceEntry>;
	mkdir(remotePath: string): Promise<ZSpaceEntry>;
	rename(remotePath: string, newName: string): Promise<ZSpaceEntry>;
	move(remotePaths: string[], to: string): Promise<void>;
	copy(remotePaths: string[], to: string): Promise<void>;
	remove(remotePaths: string[]): Promise<void>;
	download(remotePath: string, localDir: string, options?: { name?: string }): Promise<{ localPath: string; bytes: number }>;
	readFile(remotePath: string, options?: { maxBytes?: number }): Promise<{ buffer: Buffer; truncated: boolean; bytes: number }>;
	upload(localPath: string, remoteDir: string, options?: { name?: string; onProgress?: (sent: number, total: number) => void }): Promise<{ remotePath: string; bytes: number; method: "create" | "sliced" }>;
}
