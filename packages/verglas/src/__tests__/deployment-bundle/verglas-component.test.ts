import { describe, it } from "vitest";
import {
	assertVerglasUploadSupported,
	componentizeWorker,
	createVerglasManifest,
	VERGLAS_COMPONENT_PART,
} from "../../deployment-bundle/verglas-component";
import type { Config } from "@cloudflare/workers-utils";

function minimalConfig(overrides: Partial<Config> = {}): Config {
	return {
		kv_namespaces: [],
		d1_databases: [],
		r2_buckets: [],
		queues: { producers: [], consumers: [] },
		services: [],
		assets: undefined,
		migrations: [],
		compatibility_flags: [],
		compatibility_date: "2025-01-01",
		durable_objects: { bindings: [] },
		vars: {},
		...overrides,
	} as Config;
}

describe("Verglas Worker component upload", () => {
	it("uses the reserved component part and preserves a Cloudflare manifest", ({
		expect,
	}) => {
		const config = minimalConfig();
		assertVerglasUploadSupported(config);
		expect(VERGLAS_COMPONENT_PART).toBe("__verglas_component");
		expect(createVerglasManifest(config, "demo", "index.js")).toMatchObject({
			name: "demo",
			main: "index.js",
			compatibility_date: "2025-01-01",
			durable_objects: { bindings: [] },
		});
	});

	it("rejects deferred Cloudflare resource categories explicitly", ({
		expect,
	}) => {
		expect(() =>
			assertVerglasUploadSupported(
				minimalConfig({ kv_namespaces: [{ binding: "CACHE", id: "id" }] })
			)
		).toThrow(/KV/);
	});

	it("componentizes the bundled Worker without an OSS checkout", async ({
		expect,
	}) => {
		const config = minimalConfig({
			durable_objects: {
				bindings: [{ name: "COUNTER", class_name: "Counter" }],
			},
		});
		const component = await componentizeWorker({
			content: `import { DurableObject } from "cloudflare:workers";
export class Counter extends DurableObject { fetch() { return new Response() } }
export default { fetch() { return new Response() } };`,
			manifest: createVerglasManifest(config, "demo", "index.js"),
		});
		expect(component).toBeInstanceOf(Uint8Array);
		expect(component.byteLength).toBeGreaterThan(0);
	});
});
