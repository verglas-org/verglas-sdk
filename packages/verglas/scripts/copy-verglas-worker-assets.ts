import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";

const packageDirectory = path.resolve(__dirname, "..");
const source = path.join(packageDirectory, "templates", "verglas-worker");
const destination = path.join(
	packageDirectory,
	"verglas-dist",
	"verglas-worker"
);

async function main(): Promise<void> {
	// eslint-disable-next-line workers-sdk/no-direct-recursive-rm -- build output is disposable
	await rm(destination, { recursive: true, force: true });
	await mkdir(path.dirname(destination), { recursive: true });
	await cp(source, destination, { recursive: true });
}

main().catch((error: unknown) => {
	console.error(error);
	process.exitCode = 1;
});
