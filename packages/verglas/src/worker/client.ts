import { readFile } from "node:fs/promises";
import {
	addAuthorizationHeader,
	getVerglasApiBaseUrl,
	UserError,
} from "@cloudflare/workers-utils";
import { fetch, Headers } from "undici";
import { requireApiToken } from "../user";

export type WorkerDeployment = {
	endpoint?: { url?: string };
	artifact_digest?: string;
	[key: string]: unknown;
};

function apiOrigin(): string {
	return getVerglasApiBaseUrl({})
		.replace(/\/client\/v4\/?$/, "")
		.replace(/\/+$/, "");
}

function workerBase(tenant: string, name: string): string {
	return `${apiOrigin()}/v1/deployments/${encodeURIComponent(tenant)}/workers/${encodeURIComponent(name)}`;
}

async function responseJson(
	response: Response
): Promise<Record<string, unknown>> {
	return response.json().catch(() => ({})) as Promise<Record<string, unknown>>;
}

async function controlRequest(
	url: string,
	init: { method: string; headers?: Headers; body?: Uint8Array | string },
	telemetryMessage: string
): Promise<Record<string, unknown>> {
	const headers = init.headers ?? new Headers();
	addAuthorizationHeader(headers, requireApiToken());
	const response = await fetch(url, { ...init, headers });
	const value = await responseJson(response);
	if (!response.ok) {
		throw new UserError(
			`Verglas Worker operation failed (HTTP ${response.status}): ${JSON.stringify(value)}`,
			{ telemetryMessage }
		);
	}
	return value;
}

/** Upload one portable component and return its content-addressed digest. */
export async function uploadPortableWorker(options: {
	tenant: string;
	name: string;
	componentPath: string;
	manifest: Record<string, unknown>;
}): Promise<string> {
	const component = await readFile(options.componentPath);
	const value = await controlRequest(
		`${workerBase(options.tenant, options.name)}/artifacts`,
		{
			method: "PUT",
			headers: new Headers({
				"content-type": "application/wasm",
				"x-verglas-worker-manifest": Buffer.from(
					JSON.stringify(options.manifest)
				).toString("base64url"),
			}),
			body: component,
		},
		"verglas wasm worker upload failed"
	);
	const artifact = value.artifact as { digest?: unknown } | undefined;
	if (typeof artifact?.digest !== "string") {
		throw new UserError("Worker upload returned no artifact digest", {
			telemetryMessage: "verglas wasm worker upload missing digest",
		});
	}
	return artifact.digest;
}

/** Compile one previously uploaded portable component for the native runtime. */
export async function buildPortableWorker(options: {
	tenant: string;
	name: string;
	digest: string;
}): Promise<void> {
	await controlRequest(
		`${workerBase(options.tenant, options.name)}/builds`,
		{
			method: "POST",
			headers: new Headers({ "content-type": "application/json" }),
			body: JSON.stringify({ artifact_digest: options.digest }),
		},
		"verglas wasm worker build failed"
	);
}

/** Deploy a compiled Worker and return its managed endpoint metadata. */
export async function deployPortableWorker(options: {
	tenant: string;
	name: string;
	digest: string;
	processGroup?: string;
	public?: boolean;
}): Promise<WorkerDeployment> {
	return (await controlRequest(
		`${workerBase(options.tenant, options.name)}/deployment`,
		{
			method: "PUT",
			headers: new Headers({ "content-type": "application/json" }),
			body: JSON.stringify({
				artifact_digest: options.digest,
				public: options.public ?? true,
				...(options.processGroup === undefined
					? {}
					: { process_group: options.processGroup }),
			}),
		},
		"verglas wasm worker deployment failed"
	)) as WorkerDeployment;
}
