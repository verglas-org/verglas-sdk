export type WorkerAssetName = "cloudflare-workers.js" | "shim.js" | "world.wit";

export declare function workerAssetPath(name: WorkerAssetName): string;
export declare function workerToolPath(name: "jco"): string;
