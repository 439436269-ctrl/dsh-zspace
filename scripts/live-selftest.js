#!/usr/bin/env node
/**
 * Live end-to-end self-test for dsh-zspace against a real 极空间 NAS.
 *
 * It exercises the whole stack the way the agent will use it — over the
 * desktop client's local proxy, from whatever network this machine is on —
 * and then removes everything it created.
 *
 *   node scripts/live-selftest.js [--keep]
 *
 * Steps: status → ls → mkdir scratch → upload (single request, Chinese name)
 * → upload (forced multi-slice) → stat → read → download + hash compare
 * → copy → rename → name-walk find → remove → verify removal.
 *
 * `--keep` leaves the scratch directory in place for manual inspection.
 * Exits non-zero on the first failed step.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { ZSpaceClient } from "../lib/client.js";
import { humanSize } from "../lib/format.js";
import { createToolSpecs, findByName } from "../lib/tools.js";

const KEEP = process.argv.includes("--keep");
const SCRATCH_NAME = "dsh-zspace-selftest";

/** @type {string[]} */
const createdRemotely = [];
/** @type {string[]} */
const createdLocally = [];

/**
 * Print one step result.
 *
 * @param {string} label - step name.
 * @param {string} detail - outcome detail.
 * @param {number} startedAt - `Date.now()` before the step.
 * @returns {void}
 */
function ok(label, detail, startedAt) {
	console.log(`✔ ${label} (${Date.now() - startedAt}ms)${detail ? ` — ${detail}` : ""}`);
}

/**
 * Run one step, aborting the whole script on failure.
 *
 * @template T
 * @param {string} label - step name.
 * @param {() => Promise<T>} body - step body.
 * @returns {Promise<T>} step result.
 */
async function step(label, body) {
	const startedAt = Date.now();
	try {
		const value = await body();
		ok(label, "", startedAt);
		return value;
	} catch (error) {
		console.error(`✖ ${label} (${Date.now() - startedAt}ms) — ${error.message}`);
		throw error;
	}
}

/**
 * Local file hash.
 *
 * @param {string} file - path.
 * @returns {string} sha256 hex digest.
 */
function hashFile(file) {
	return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/**
 * Best-effort cleanup of everything this script created.
 *
 * @param {ZSpaceClient} client - live client.
 * @param {string} scratch - scratch directory path.
 * @returns {Promise<void>} resolves when cleanup was attempted.
 */
async function cleanup(client, scratch) {
	// Remove the scratch directory first: it supersedes everything created
	// inside it, and a stale entry list must never turn cleanup into an error.
	if (scratch) {
		try {
			await client.remove([scratch]);
			console.log(`· 清理：已删除临时目录 ${scratch}`);
		} catch (error) {
			console.error(`· 清理临时目录失败：${error.message}`);
		}
	}
	for (const entry of createdRemotely) {
		try {
			await client.remove([entry]);
		} catch {
			/* already gone with the scratch directory */
		}
	}
	for (const file of createdLocally) fs.rmSync(file, { recursive: true, force: true });
}

async function main() {
	// A 1 KB slice size + 1 KB single-request threshold forces the sliced
	// protocol for the 3 KB fixture, so the desktop-client upload path is
	// exercised for real instead of only in the unit tests.
	const client = new ZSpaceClient({ sliceSize: 1024, smallUploadMaxBytes: 1024 });
	let scratch = "";

	console.log(`代理：${client.baseUrl}`);
	// 身份信息脱敏：这个脚本的输出经常被贴进 issue / 聊天里。
	const mask = (value) => (typeof value === "string" && value.length > 4 ? `***${value.slice(-4)}` : "***");
	console.log(
		`登录态：${client.identity.vuexPath || "(显式凭据)"}  账号：${mask(client.identity.username)}  NAS：${mask(client.identity.nasId)}`,
	);

	try {
		await step("探活（桌面客户端代理）", async () => {
			if (!(await client.check())) throw new Error(`代理 ${client.baseUrl} 无响应`);
		});

		const pools = await step("存储池 /zspool/info", async () => client.pools());
		for (const pool of pools) console.log(`  ${pool.name} 剩余 ${humanSize(pool.freeSize)} / 共 ${humanSize(pool.totalSize)}`);

		const home = await step("定位个人空间", async () => client.homePath());
		const publicSpace = await step("定位公共空间", async () => client.publicPath());
		console.log(`  home=${home}  public=${publicSpace}`);

		const homeListing = await step("列个人空间", async () => client.list(home, { maxEntries: 200 }));
		console.log(`  ${homeListing.entries.length} 项${homeListing.truncated ? "（截断）" : ""}：${homeListing.entries.slice(0, 5).map(entry => entry.name).join("、")}`);

		const publicListing = await step("列公共空间", async () => client.list(publicSpace, { maxEntries: 100 }));
		console.log(`  ${publicListing.entries.length} 项：${publicListing.entries.map(entry => entry.name).join("、")}`);

		scratch = `${home}/${SCRATCH_NAME}`;
		await step("创建临时目录", async () => {
			await client.mkdir(scratch).catch(async (error) => {
				// A leftover scratch dir from an interrupted run is fine.
				if (error.code === "N001212") return;
				throw error;
			});
		});
		createdRemotely.push(scratch);

		const localDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-zspace-live-"));
		createdLocally.push(localDir);

		const smallName = "自检-中文名 空格.txt";
		const smallPath = path.join(localDir, smallName);
		const smallBody = `极空间自检 ${new Date().toISOString()}\n中文内容校验\n`;
		fs.writeFileSync(smallPath, smallBody);

		const smallUpload = await step("上传（单请求 + 中文名）", async () => client.upload(smallPath, scratch));
		createdRemotely.push(smallUpload.remotePath);
		console.log(`  → ${smallUpload.remotePath}（${smallUpload.method}）`);

		const bigBytes = crypto.randomBytes(3000);
		const bigPath = path.join(localDir, "自检-分片.bin");
		fs.writeFileSync(bigPath, bigBytes);
		const bigUpload = await step("上传（强制分片，1KB/片）", async () => client.upload(bigPath, scratch));
		createdRemotely.push(bigUpload.remotePath);
		console.log(`  → ${bigUpload.remotePath}（${bigUpload.method}，${humanSize(bigUpload.bytes)}）`);

		const info = await step("查看详情", async () => client.info(smallUpload.remotePath));
		if (info.size !== Buffer.byteLength(smallBody)) throw new Error(`大小不符：${info.size} ≠ ${Buffer.byteLength(smallBody)}`);
		console.log(`  ${info.name} ${humanSize(info.size)} 修改于 ${info.modified}`);

		// 走 tools 层（模型实际调用的那一层）验证 zspace_write：直写 -> 读回 -> 内容比对
		const specs = new Map(
			createToolSpecs({
				getClient: () => client,
				config: { downloadDir: "", readMaxBytes: 262_144, writeMaxBytes: 5 * 1024 * 1024, listMaxEntries: 2000 },
			}).map(spec => [spec.name, spec]),
		);
		const writeBody = `直写自检 ${new Date().toISOString()}\n第二行中文\n`;
		await step("zspace_write 直写文本 + zspace_read 读回校验", async () => {
			const target = `${scratch}/直写-中文.md`;
			const written = await specs.get("zspace_write").execute({ path: target, content: writeBody });
			createdRemotely.push(target);
			if (written.bytes !== Buffer.byteLength(writeBody, "utf8")) throw new Error(`字节数不符：${written.bytes}`);
			const back = await specs.get("zspace_read").execute({ path: target, maxBytes: 4096 });
			if (back.content !== writeBody) throw new Error("读回内容与写入不一致");
			if (back.binary) throw new Error("文本文件被判定为二进制");
			console.log(`  → ${target}（${written.method}，${written.bytes} 字节，读回一致）`);
		});

		const head = await step("读取文本前 10 字节", async () => client.readFile(smallUpload.remotePath, { maxBytes: 10 }));
		console.log(`  "${head.buffer.toString("utf8")}"${head.truncated ? "（截断）" : ""}`);

		const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-zspace-live-dl-"));
		createdLocally.push(downloadDir);
		await step("下载 + 哈希校验（小文件）", async () => {
			const { localPath, bytes } = await client.download(smallUpload.remotePath, downloadDir);
			if (bytes !== Buffer.byteLength(smallBody)) throw new Error(`字节数不符：${bytes}`);
			if (fs.readFileSync(localPath, "utf8") !== smallBody) throw new Error("内容不一致");
		});
		await step("下载 + 哈希校验（分片文件，3KB）", async () => {
			const { localPath, bytes } = await client.download(bigUpload.remotePath, downloadDir, { name: "roundtrip.bin" });
			if (bytes !== bigBytes.length) throw new Error(`字节数不符：${bytes} ≠ ${bigBytes.length}`);
			const digest = crypto.createHash("sha256").update(fs.readFileSync(localPath)).digest("hex");
			if (digest !== crypto.createHash("sha256").update(bigBytes).digest("hex")) throw new Error("sha256 不一致");
		});
		console.log(`  落地目录 ${downloadDir}`);

		const copyTarget = `${scratch}/复制`;
		await step("复制（服务端）", async () => {
			await client.mkdir(copyTarget);
			await client.copy([smallUpload.remotePath], copyTarget);
		});
		createdRemotely.push(copyTarget);

		await step("重命名", async () => {
			await client.rename(`${copyTarget}/${smallName}`, "改名后.txt");
		});

		// The NAS search endpoint ignores keywords on current firmware, so the
		// plugin walks the tree instead. Scan the scratch directory to prove the
		// walk sees the file we just renamed.
		await step("按名称遍历查找", async () => {
			const found = await findByName({ client, roots: [scratch], keyword: "改名后", depth: 4, limit: 50, scanLimit: 2000 });
			if (found.matches.length !== 1) throw new Error(`期望命中 1 项，实际 ${found.matches.length} 项（已扫 ${found.scanned}）`);
			console.log(`  命中 ${found.matches[0].path}（已扫 ${found.scanned} 项${found.truncated ? "，截断" : ""}）`);
		});

		const moved = `${scratch}/移动后`;
		await step("移动", async () => {
			await client.mkdir(moved);
			await client.move([`${copyTarget}/改名后.txt`], moved);
		});
		createdRemotely.push(moved);

		await step("删除整个临时目录", async () => {
			await client.remove([scratch]);
			createdRemotely.length = 0;
		});
		await step("确认临时目录已消失", async () => {
			const present = await client.isDirectory(scratch);
			if (present) throw new Error(`目录仍在：${scratch}`);
		});

		console.log("\n全部自检步骤通过 ✅");
		if (KEEP) console.log("（--keep：临时目录被保留，请自行清理）");
	} finally {
		await cleanup(client, KEEP ? "" : scratch);
	}
}

main().catch((error) => {
	console.error(`\n自检失败：${error.message}`);
	if (error.hint) console.error(`提示：${error.hint}`);
	process.exitCode = 1;
});
