import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeSync,
	chmodSync,
} from "node:fs";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import os from "node:os";
import path from "node:path";
import { getAuthFromEnv as getCloudflareAuthFromEnv } from "@cloudflare/workers-auth";
import {
	DefaultScopes,
	DefaultScopeKeys,
	setLoginScopeKeys,
	validateScopeKeys,
	type Scope,
} from "@cloudflare/workers-auth/wrangler";
import {
	getVerglasApiBaseUrl,
	openInBrowser,
	UserError,
} from "@cloudflare/workers-utils";
import { fetch } from "undici";
import { NoDefaultValueProvided, select } from "../dialogs";
import { logger } from "../logger";
import type { Account } from "./shared";
import type {
	LoginOrRefreshResult,
	UserAuthConfig,
} from "@cloudflare/workers-auth";
import type {
	ApiCredentials,
	ComplianceConfig,
} from "@cloudflare/workers-utils";

/** Verglas's WorkOS browser login callback is intentionally fixed and local. */
export const VERGLAS_AUTH_CALLBACK_URL = "http://localhost:3080/";
export const VERGLAS_CONFIG_DIR = path.join(os.homedir(), ".verglas");

type VerglasAuthConfig = UserAuthConfig & { account_id?: string };
let activeProfile = "default";
let cachedAccount: Account | undefined;
let cachedEmail: string | undefined;

function credentialsPath(profile = activeProfile): string {
	const suffix =
		profile === "default" ? "credentials" : `credentials-${profile}`;
	return path.join(
		process.env.VERGLAS_CONFIG_DIR ?? VERGLAS_CONFIG_DIR,
		`${suffix}.json`
	);
}

/** Public path helper used by diagnostics and tests; credentials never live in ~/.wrangler. */
export function getAuthConfigFilePath(profile?: string): string {
	return credentialsPath(profile);
}

export function getEncryptedAuthConfigFilePath(profile?: string): string {
	return credentialsPath(profile).replace(/\.json$/, ".enc");
}

function readStored(profile = activeProfile): VerglasAuthConfig | undefined {
	const file = credentialsPath(profile);
	if (!existsSync(file)) return undefined;
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (!parsed || typeof parsed !== "object") return undefined;
		const value = parsed as Record<string, unknown>;
		if (typeof value.oauth_token !== "string" || value.oauth_token.length === 0)
			return undefined;
		return {
			oauth_token: value.oauth_token,
			...(typeof value.expiration_time === "string"
				? { expiration_time: value.expiration_time }
				: {}),
			...(typeof value.account_id === "string"
				? { account_id: value.account_id }
				: {}),
			...(Array.isArray(value.scopes)
				? {
						scopes: value.scopes.filter(
							(scope): scope is string => typeof scope === "string"
						),
					}
				: {}),
		};
	} catch {
		return undefined;
	}
}

/** Write credentials in the same directory and atomically replace the target. */
function writeStored(config: VerglasAuthConfig, profile = activeProfile): void {
	const directory = path.dirname(credentialsPath(profile));
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	chmodSync(directory, 0o700);
	const target = credentialsPath(profile);
	const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
	const descriptor = openSync(temporary, "wx", 0o600);
	try {
		writeSync(descriptor, JSON.stringify(config) + "\n", undefined, "utf8");
		fsyncSync(descriptor);
		closeSync(descriptor);
		chmodSync(temporary, 0o600);
		renameSync(temporary, target);
		chmodSync(target, 0o600);
	} catch (error) {
		try {
			closeSync(descriptor);
		} catch {
			/* already closed */
		}
		try {
			unlinkSync(temporary);
		} catch {
			/* best effort cleanup */
		}
		throw error;
	}
}

export function readAuthCredentials(): UserAuthConfig | undefined {
	return readStored();
}

export function writeAuthCredentials(config: UserAuthConfig): void {
	writeStored(config);
}

/** Compatibility aliases retained for code that imported Wrangler's helpers. */
export function readAuthConfigFile(
	profile?: string
): UserAuthConfig | undefined {
	return readStored(profile);
}

export function writeAuthConfigFile(
	config: UserAuthConfig,
	profile?: string
): void {
	writeStored(config, profile);
}

export const WRANGLER_KEYRING_SERVICE_NAME = "verglas";
export {
	DefaultScopes,
	DefaultScopeKeys,
	setLoginScopeKeys,
	validateScopeKeys,
	type Scope,
};

export function setProfile(profile: string): void {
	activeProfile = profile;
}

export function getActiveProfile(): string {
	return activeProfile;
}

export function setTemporaryAllowed(_allowed: boolean): void {
	// Verglas does not mint Cloudflare temporary preview accounts.
}

const credentialStore = {
	kind: "file" as const,
	read: () => readStored(),
	write: (config: UserAuthConfig) => writeStored(config),
	clear: () => {
		const file = credentialsPath();
		const existed = existsSync(file);
		if (existed) unlinkSync(file);
		return existed;
	},
	path: () => credentialsPath(),
	describe: () => `${credentialsPath()} (mode 0600)`,
};

export function getCredentialStore() {
	return credentialStore;
}

/** Verglas credentials take precedence; Cloudflare names remain read-only compatibility aliases. */
export function getAuthFromEnv(): ApiCredentials | undefined {
	const token = process.env.VERGLAS_API_TOKEN;
	if (token) return { apiToken: token };
	return getCloudflareAuthFromEnv();
}

export function getAPIToken(): ApiCredentials | undefined {
	const envCredentials = getAuthFromEnv();
	if (envCredentials) return envCredentials;
	const stored = readStored();
	if (!stored?.oauth_token) return undefined;
	if (
		stored.expiration_time &&
		Date.parse(stored.expiration_time) <= Date.now()
	)
		return undefined;
	return { apiToken: stored.oauth_token };
}

export function requireApiToken(): ApiCredentials {
	const credentials = getAPIToken();
	if (!credentials)
		throw new UserError("No Verglas API token found. Run `verglas login`.", {
			telemetryMessage: "user auth missing api token",
		});
	return credentials;
}

function controlPlaneBase(complianceConfig: ComplianceConfig = {}): string {
	return getVerglasApiBaseUrl(complianceConfig)
		.replace(/\/client\/v4\/?$/, "")
		.replace(/\/+$/, "");
}

function jwtExpiry(token: string): string | undefined {
	try {
		const part = token.split(".")[1];
		if (!part) return undefined;
		const payload = JSON.parse(
			Buffer.from(part, "base64url").toString("utf8")
		) as { exp?: unknown };
		return typeof payload.exp === "number"
			? new Date(payload.exp * 1000).toISOString()
			: undefined;
	} catch {
		return undefined;
	}
}

function readRequestBody(
	request: IncomingMessage,
	limit = 8192
): Promise<string> {
	return new Promise((resolve, reject) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk: string) => {
			body += chunk;
			if (body.length > limit)
				reject(new Error("login callback payload is too large"));
		});
		request.on("end", () => resolve(body));
		request.on("error", reject);
	});
}

function callbackPage(): string {
	// The fragment never traverses the network. Replace the URL before posting it
	// to localhost so browser history and referrer headers do not retain the token.
	return `<!doctype html><meta charset="utf-8"><title>Verglas login</title><p>Completing Verglas login…</p><script>
const hash = new URLSearchParams(location.hash.slice(1));
history.replaceState(null, "", location.pathname);
const token = hash.get("access_token");
fetch("/callback", {method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({access_token:token})})
  .then(r => r.ok ? r.text() : Promise.reject(new Error("login failed")))
  .then(message => document.body.innerHTML = "<p>" + message + " You can close this tab.</p>")
  .catch(() => document.body.innerHTML = "<p>Verglas login failed. Return to your terminal.</p>");
</script>`;
}

async function receiveBrowserToken(
	loginUrl: string,
	browser: boolean
): Promise<string> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const server = createServer(
			async (request: IncomingMessage, response: ServerResponse) => {
				if (
					request.method === "GET" &&
					(request.url === "/" || request.url === "/index.html")
				) {
					response.writeHead(200, {
						"content-type": "text/html; charset=utf-8",
						"cache-control": "no-store",
					});
					response.end(callbackPage());
					return;
				}
				if (request.method === "POST" && request.url === "/callback") {
					try {
						const body = JSON.parse(await readRequestBody(request)) as {
							access_token?: unknown;
						};
						if (
							typeof body.access_token !== "string" ||
							body.access_token.length < 8
						)
							throw new Error("no access token was returned");
						response.writeHead(200, {
							"content-type": "text/plain; charset=utf-8",
							"cache-control": "no-store",
						});
						response.end("Verglas login complete.");
						finish(undefined, body.access_token);
					} catch (error) {
						response.writeHead(400, {
							"content-type": "text/plain; charset=utf-8",
							"cache-control": "no-store",
						});
						response.end("Verglas login failed.");
						finish(error instanceof Error ? error : new Error(String(error)));
					}
					return;
				}
				response.writeHead(404);
				response.end();
			}
		);
		const finish = (error?: Error, token?: string) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			server.close(() => (error ? reject(error) : resolve(token!)));
		};
		server.once("error", (error) =>
			finish(error instanceof Error ? error : new Error(String(error)))
		);
		server.listen(3080, "localhost", async () => {
			if (!browser)
				logger.log(
					`Open this URL in your browser to log in to Verglas:\n${loginUrl}`
				);
			try {
				if (browser) await openInBrowser(loginUrl, logger);
			} catch (error) {
				finish(error instanceof Error ? error : new Error(String(error)));
			}
		});
		timer = setTimeout(
			() =>
				finish(
					new UserError("Timed out waiting for Verglas login.", {
						telemetryMessage: "verglas auth timeout",
					})
				),
			120000
		);
	});
}

export async function login(
	_complianceConfig: ComplianceConfig,
	props?: { browser?: boolean; profile?: string; [key: string]: unknown }
): Promise<boolean> {
	if (props?.callbackHost !== undefined && props.callbackHost !== "localhost") {
		throw new UserError("Verglas WorkOS login only supports localhost:3080.", {
			telemetryMessage: "verglas auth callback host unsupported",
		});
	}
	if (props?.callbackPort !== undefined && props.callbackPort !== 3080) {
		throw new UserError("Verglas WorkOS login only supports localhost:3080.", {
			telemetryMessage: "verglas auth callback port unsupported",
		});
	}
	if (props?.device === true) {
		throw new UserError(
			"Verglas WorkOS login requires a browser and localhost:3080; device login is not supported.",
			{ telemetryMessage: "verglas device login unsupported" }
		);
	}
	if (getAuthFromEnv()) {
		logger.error(
			"You are already authenticated with an API token; unset it to use `verglas login`."
		);
		return false;
	}
	const profile = props?.profile ?? "default";
	const loginUrl = `${controlPlaneBase(_complianceConfig)}/v1/auth/login?return_to=${encodeURIComponent(VERGLAS_AUTH_CALLBACK_URL)}`;
	logger.log("Attempting to log in to Verglas through WorkOS…");
	const token = await receiveBrowserToken(loginUrl, props?.browser ?? true);
	writeStored(
		{ oauth_token: token, expiration_time: jwtExpiry(token) },
		profile
	);
	logger.log("Successfully logged in to Verglas.");
	return true;
}

export async function logout(profile = "default"): Promise<void> {
	const file = credentialsPath(profile);
	if (existsSync(file)) unlinkSync(file);
	if (profile === activeProfile) cachedAccount = undefined;
	logger.log("Successfully logged out of Verglas.");
}

export async function getOAuthTokenFromLocalState(): Promise<
	string | undefined
> {
	const credentials = getAPIToken();
	return credentials && "apiToken" in credentials
		? credentials.apiToken
		: undefined;
}

export function getScopes(): Scope[] | undefined {
	return readStored()?.scopes as Scope[] | undefined;
}

export function listScopes(message = "Available Verglas scopes:"): void {
	logger.log(message);
	logger.table(
		DefaultScopeKeys.map((scope) => ({
			Scope: scope,
			Description: DefaultScopes[scope],
		}))
	);
}

export function printScopes(scopes: Scope[]): void {
	logger.table(
		scopes.map((scope) => ({ Scope: scope, Description: DefaultScopes[scope] }))
	);
}

export function getActiveAccountId(config: {
	account_id?: string;
}): string | undefined {
	return (
		config.account_id ||
		process.env.VERGLAS_ACCOUNT_ID ||
		process.env.CLOUDFLARE_ACCOUNT_ID ||
		readStored()?.account_id ||
		cachedAccount?.id
	);
}

export async function fetchAllAccounts(
	_complianceConfig: ComplianceConfig,
	options?: { throwOnEmpty?: boolean }
): Promise<Account[]> {
	const credentials = requireApiToken();
	const token =
		"apiToken" in credentials ? credentials.apiToken : credentials.authKey;
	const response = await fetch(`${controlPlaneBase(_complianceConfig)}/v1/me`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	if (!response.ok)
		throw new UserError(
			`Verglas account discovery failed (${response.status}).`,
			{ telemetryMessage: "verglas account discovery failed" }
		);
	const body = (await response.json()) as {
		identity?: { email?: unknown };
		organizations?: Array<{
			id?: unknown;
			name?: unknown;
			deployments?: Array<{ id?: unknown; name?: unknown }>;
		}>;
	};
	if (typeof body.identity?.email === "string")
		cachedEmail = body.identity.email;
	const accounts = (body.organizations ?? []).flatMap((organization) => {
		if (typeof organization.name !== "string") return [];
		const organizationName = organization.name;
		return (organization.deployments ?? []).flatMap((deployment) =>
			typeof deployment.id === "string" && typeof deployment.name === "string"
				? [
						{
							id: deployment.id,
							name:
								deployment.name === "default"
									? organizationName
									: `${organizationName} / ${deployment.name}`,
						},
					]
				: []
		);
	});
	if (accounts.length === 0 && options?.throwOnEmpty !== false)
		throw new UserError(
			"No Verglas deployments are available for this account.",
			{ telemetryMessage: "verglas account discovery empty" }
		);
	return accounts;
}

export async function getOrSelectAccountId(
	config: ComplianceConfig & { account_id?: string }
): Promise<string> {
	const configured = getActiveAccountId(config);
	if (configured) return configured;
	const accounts = await fetchAllAccounts(config);
	if (accounts.length === 1) {
		cachedAccount = accounts[0];
		return accounts[0].id;
	}
	try {
		const selected = await select("Select a Verglas organization", {
			choices: accounts.map((account) => ({
				title: `${account.name} (${account.id})`,
				value: account.id,
			})),
		});
		cachedAccount = accounts.find((account) => account.id === selected);
		return selected;
	} catch (error) {
		if (error instanceof NoDefaultValueProvided)
			throw new UserError(
				"Set VERGLAS_ACCOUNT_ID or account_id in your config when running non-interactively.",
				{ telemetryMessage: "verglas account missing" }
			);
		throw error;
	}
}

export async function requireAuth(
	config: ComplianceConfig & { account_id?: string }
): Promise<string> {
	if (!getAPIToken())
		throw new UserError(
			"Not authenticated with Verglas. Run `verglas login`.",
			{ telemetryMessage: "verglas auth required" }
		);
	return getOrSelectAccountId(config);
}

export async function loginOrRefreshIfRequired(
	config: ComplianceConfig,
	props?: { browser?: boolean }
): Promise<LoginOrRefreshResult> {
	if (getAPIToken()) return { loggedIn: true };
	if (!process.stdin.isTTY)
		return { loggedIn: false, reason: "no-credentials-non-interactive" };
	try {
		return (await login(config, props))
			? { loggedIn: true }
			: { loggedIn: false, reason: "no-credentials-login-failed" };
	} catch {
		return { loggedIn: false, reason: "no-credentials-login-failed" };
	}
}

export function getAccountFromCache(): Account | undefined {
	return cachedAccount;
}

export function getVerglasUserEmail(): string | undefined {
	return cachedEmail;
}

export type { UserAuthConfig };
