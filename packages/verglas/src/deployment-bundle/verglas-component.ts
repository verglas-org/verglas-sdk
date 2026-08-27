import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { removeDir, UserError } from "@cloudflare/workers-utils";
import { workerAssetPath } from "@verglas/worker-js/assets";
import { build as bundle } from "esbuild";
import { getBasePath } from "../paths";
import type { Config, DurableObjectBindings } from "@cloudflare/workers-utils";

/** The reserved multipart part accepted by the Verglas control plane. */
export const VERGLAS_COMPONENT_PART = "__verglas_component";

export type VerglasComponentManifest = {
	name: string;
	main: string;
	compatibility_date?: string;
	compatibility_flags: string[];
	durable_objects: { bindings: DurableObjectBindings };
	vars: Record<string, unknown>;
	[key: string]: unknown;
};

type Componentize = (options: {
	sourcePath: string;
	witPath: string;
	worldName: string;
	disableFeatures: Array<
		"stdio" | "random" | "clocks" | "http" | "fetch-event"
	>;
}) => Promise<{ component: Uint8Array }>;

/**
 * Fail closed for bindings that the Verglas control plane does not provision
 * yet. The regular Wrangler upload path must not silently pretend these work.
 */
export function assertVerglasUploadSupported(config: Config): void {
	const blocked: string[] = [];
	if (config.kv_namespaces.length > 0) {
		blocked.push("KV");
	}
	if (config.d1_databases.length > 0) {
		blocked.push("D1");
	}
	if (config.r2_buckets.length > 0) {
		blocked.push("R2");
	}
	if (
		(config.queues.producers?.length ?? 0) > 0 ||
		(config.queues.consumers?.length ?? 0) > 0
	) {
		blocked.push("Queues");
	}
	if ((config.services?.length ?? 0) > 0) {
		blocked.push("service bindings");
	}
	if (config.assets !== undefined) {
		blocked.push("assets");
	}
	if (config.migrations.length > 0) {
		blocked.push("migrations");
	}
	if (blocked.length > 0) {
		throw new UserError(
			`Verglas Worker uploads do not support ${blocked.join(", ")} yet. Remove these bindings/configuration or deploy through the Cloudflare API.`,
			{ telemetryMessage: "verglas upload unsupported feature" }
		);
	}
}

/**
 * Componentize the already bundled Wrangler module. The source bundle is
 * written to a temporary directory, while the original source remains in the
 * normal Cloudflare multipart upload. ComponentizeJS and the compatibility
 * shim are shipped with this package; no checkout of the OSS Verglas repo is
 * needed at runtime.
 */
export async function componentizeWorker(options: {
	content: string;
	manifest: VerglasComponentManifest;
}): Promise<Uint8Array> {
	const workDir = await mkdtemp(path.join(os.tmpdir(), "verglas-component-"));
	try {
		await writeFile(path.join(workDir, "worker.js"), options.content, "utf8");
		const manifest = JSON.stringify(options.manifest);
		const shim = workerAssetPath("shim.js").replaceAll("\\", "\\\\");
		const source = [
			'import * as project from "./worker.js";',
			`import { createHandler, createWorker } from ${JSON.stringify(shim)};`,
			`const manifest = ${manifest};`,
			"export const worker = createWorker(project, manifest);",
			"export const handler = createHandler(project, manifest);",
			"",
		].join("\n");
		const sourcePath = path.join(workDir, "entry.js");
		await writeFile(sourcePath, source, "utf8");
		const bundled = await bundle({
			entryPoints: [sourcePath],
			bundle: true,
			format: "esm",
			platform: "neutral",
			target: "es2022",
			write: false,
			legalComments: "none",
			minify: true,
			alias: {
				"cloudflare:workers": workerAssetPath("cloudflare-workers.js"),
			},
			external: ["verglas:do-worker/*@0.1.0"],
		});
		if (bundled.outputFiles.length !== 1) {
			throw new Error(
				`Verglas component wrapper produced ${bundled.outputFiles.length} bundles; exactly one is required`
			);
		}
		const bundledPath = path.join(workDir, "entry.bundle.js");
		await writeFile(bundledPath, bundled.outputFiles[0].contents);
		// The published CLI is CommonJS while ComponentizeJS is ESM-only. Import
		// its file URL explicitly so Node does not attempt require() on the ESM
		// package export.
		const componentizeModule = (await import(
			pathToFileURL(
				path.join(
					getBasePath(),
					"node_modules",
					"@bytecodealliance",
					"componentize-js",
					"src",
					"componentize.js"
				)
			).href
		)) as { componentize: Componentize };
		const result = await componentizeModule.componentize({
			sourcePath: bundledPath,
			witPath: workerAssetPath("world.wit"),
			worldName: "service",
			disableFeatures: ["stdio", "random", "clocks", "http", "fetch-event"],
		});
		return result.component;
	} finally {
		await removeDir(workDir);
	}
}

export function createVerglasManifest(
	config: Config,
	name: string,
	entryName: string
): VerglasComponentManifest {
	return {
		name,
		main: entryName,
		...(config.compatibility_date === undefined
			? {}
			: { compatibility_date: config.compatibility_date }),
		compatibility_flags: config.compatibility_flags,
		durable_objects: { bindings: config.durable_objects.bindings },
		vars: config.vars,
	};
}
