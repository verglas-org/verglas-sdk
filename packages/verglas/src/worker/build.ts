import { readFile } from "node:fs/promises";
import path from "node:path";
import {
	addAuthorizationHeader,
	getVerglasApiBaseUrl,
	UserError,
} from "@cloudflare/workers-utils";
import { fetch, Headers } from "undici";
import { createCommand } from "../core/create-command";
import { requireApiToken } from "../user";

function apiOrigin(): string {
	return getVerglasApiBaseUrl({})
		.replace(/\/client\/v4\/?$/, "")
		.replace(/\/+$/, "");
}

async function responseJson(
	response: Awaited<ReturnType<typeof fetch>>
): Promise<Record<string, unknown>> {
	return response.json().catch(() => ({})) as Promise<Record<string, unknown>>;
}

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
		const component = await readFile(path.resolve(args.COMPONENT));
		const manifest = args.manifest
			? (JSON.parse(
					await readFile(path.resolve(args.manifest), "utf8")
				) as Record<string, unknown>)
			: {
					name: args.name,
					main: path.basename(args.COMPONENT),
					artifacts: { worker: {} },
				};
		const credentials = requireApiToken();
		const headers = new Headers({
			"content-type": "application/wasm",
			"x-verglas-worker-manifest": Buffer.from(
				JSON.stringify(manifest)
			).toString("base64url"),
		});
		addAuthorizationHeader(headers, credentials);
		const base = `${apiOrigin()}/v1/deployments/${encodeURIComponent(args.tenant)}/workers/${encodeURIComponent(args.name)}`;
		const upload = await fetch(`${base}/artifacts`, {
			method: "PUT",
			headers,
			body: component,
		});
		const uploaded = await responseJson(upload);
		if (!upload.ok) {
			throw new UserError(
				`Worker upload failed (HTTP ${upload.status}): ${JSON.stringify(uploaded)}`,
				{
					telemetryMessage: "verglas wasm worker upload failed",
				}
			);
		}
		const artifact = uploaded.artifact as { digest?: unknown } | undefined;
		if (typeof artifact?.digest !== "string") {
			throw new UserError("Worker upload returned no artifact digest", {
				telemetryMessage: "verglas wasm worker upload missing digest",
			});
		}
		const buildHeaders = new Headers({ "content-type": "application/json" });
		addAuthorizationHeader(buildHeaders, credentials);
		const builtResponse = await fetch(`${base}/builds`, {
			method: "POST",
			headers: buildHeaders,
			body: JSON.stringify({ artifact_digest: artifact.digest }),
		});
		const built = await responseJson(builtResponse);
		if (!builtResponse.ok) {
			throw new UserError(
				`Worker build failed (HTTP ${builtResponse.status}): ${JSON.stringify(built)}`,
				{
					telemetryMessage: "verglas wasm worker build failed",
				}
			);
		}
		logger.log(
			`Built ${args.name} (${artifact.digest}) for tenant ${args.tenant}.`
		);
	},
});
