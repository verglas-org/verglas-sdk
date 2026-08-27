import { mkdtempSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fetch } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	getAPIToken,
	getAuthConfigFilePath,
	getAuthFromEnv,
	login,
	logout,
	VERGLAS_AUTH_CALLBACK_URL,
	writeAuthCredentials,
} from "../user";

const tempDirs: string[] = [];

afterEach(() => {
	vi.unstubAllEnvs();
});

function useTempCredentials(): string {
	const directory = mkdtempSync(path.join(os.tmpdir(), "verglas-auth-"));
	tempDirs.push(directory);
	vi.stubEnv("VERGLAS_CONFIG_DIR", directory);
	vi.stubEnv("VERGLAS_API_BASE_URL", "https://api.test/client/v4");
	delete process.env.VERGLAS_API_TOKEN;
	delete process.env.CLOUDFLARE_API_TOKEN;
	return directory;
}

describe("Verglas auth", () => {
	it("uses Verglas token and account aliases before Cloudflare compatibility aliases", () => {
		useTempCredentials();
		vi.stubEnv("VERGLAS_API_TOKEN", "verglas-token");
		vi.stubEnv("VERGLAS_ACCOUNT_ID", "org-verglas");
		vi.stubEnv("CLOUDFLARE_API_TOKEN", "cloudflare-token");
		expect(getAuthFromEnv()).toEqual({ apiToken: "verglas-token" });
		expect(getAPIToken()).toEqual({ apiToken: "verglas-token" });
	});

	it("receives the WorkOS fragment handoff on localhost:3080 and writes mode 0600 credentials", async () => {
		const directory = useTempCredentials();
		const pendingLogin = login({}, { browser: false });

		let callbackReady = false;
		for (let attempt = 0; attempt < 20 && !callbackReady; attempt++) {
			try {
				const response = await fetch(VERGLAS_AUTH_CALLBACK_URL);
				callbackReady = response.ok;
			} catch {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
		}
		expect(callbackReady).toBe(true);
		const callback = await fetch("http://localhost:3080/callback", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ access_token: "workos-access-token" }),
		});
		expect(callback.status).toBe(200);
		expect(await pendingLogin).toBe(true);
		expect(getAPIToken()).toEqual({ apiToken: "workos-access-token" });
		const file = getAuthConfigFilePath();
		expect(file).toBe(path.join(directory, "credentials.json"));
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(
			readdirSync(directory).filter((entry) => entry.endsWith(".tmp"))
		).toEqual([]);

		await logout();
	});

	it("writes compatibility credentials atomically under ~/.verglas", () => {
		const directory = useTempCredentials();
		writeAuthCredentials({ oauth_token: "stored-token" });
		expect(getAPIToken()).toEqual({ apiToken: "stored-token" });
		expect(getAuthConfigFilePath()).toBe(
			path.join(directory, "credentials.json")
		);
	});
});
