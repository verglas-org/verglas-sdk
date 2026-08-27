import { http, HttpResponse } from "msw";
import { afterEach, describe, it, vi } from "vitest";
import { fetchResult } from "../cfetch";
import { msw } from "./helpers/msw";

describe("Verglas API endpoint", () => {
	afterEach(() => {
		msw.resetHandlers();
		vi.unstubAllEnvs();
	});

	it("uses the Verglas endpoint for ordinary API requests by default", async ({
		expect,
	}) => {
		vi.stubEnv("CLOUDFLARE_API_TOKEN", "test-token");
		vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "test-account");
		let requestUrl: string | undefined;
		msw.use(
			http.get("https://api.verglas.dev/client/v4/test", ({ request }) => {
				requestUrl = request.url;
				return HttpResponse.json({
					success: true,
					result: { ok: true },
					errors: [],
				});
			})
		);

		await expect(fetchResult({}, "/test")).resolves.toEqual({ ok: true });
		expect(requestUrl).toBe("https://api.verglas.dev/client/v4/test");
	});
});
