import { readFile } from "node:fs/promises";
import path from "node:path";
import { createCommand } from "../core/create-command";
import { buildPortableWorker, uploadPortableWorker } from "./client";

export const workerBuildCommand = createCommand({
	metadata: {
		description: "Upload and compile a portable Wasm Worker",
		status: "stable",
		owner: "Workers: Authoring and Testing",
	},
	args: {
		COMPONENT: {
			type: "string",
			demandOption: true,
			describe: "Portable WebAssembly component to build",
		},
		name: {
			type: "string",
			alias: "n",
			demandOption: true,
			describe: "Worker name",
		},
		tenant: {
			type: "string",
			alias: "t",
			demandOption: true,
			describe: "Tenant deployment id",
		},
		manifest: {
			type: "string",
			describe: "Optional Worker manifest JSON",
		},
	},
	positionalArgs: ["COMPONENT"],
	async handler(args, { logger }) {
		const componentPath = path.resolve(args.COMPONENT);
		const manifest = args.manifest
			? (JSON.parse(
					await readFile(path.resolve(args.manifest), "utf8")
				) as Record<string, unknown>)
			: {
					name: args.name,
					main: path.basename(args.COMPONENT),
					artifacts: { worker: {} },
				};
		const digest = await uploadPortableWorker({
			tenant: args.tenant,
			name: args.name,
			componentPath,
			manifest,
		});
		await buildPortableWorker({ tenant: args.tenant, name: args.name, digest });
		logger.log(`Built ${args.name} (${digest}) for tenant ${args.tenant}.`);
	},
});
