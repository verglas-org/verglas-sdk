import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

/** Returns an absolute path to a runtime asset shipped by this package. */
export function workerAssetPath(name) {
	const assets = {
		"cloudflare-workers.js": resolve(packageDir, "src/cloudflare-workers.js"),
		"shim.js": resolve(packageDir, "src/shim.js"),
		"world.wit": resolve(packageDir, "wit/world.wit"),
	};
	const asset = assets[name];
	if (asset === undefined)
		throw new Error(`unknown @verglas-org/worker-js asset: ${name}`);
	return asset;
}

/** Returns an absolute path to a build tool installed with this package. */
export function workerToolPath(name) {
	if (name !== "jco")
		throw new Error(`unknown @verglas-org/worker-js tool: ${name}`);
	return resolve(dirname(require.resolve("@bytecodealliance/jco")), "jco.js");
}
