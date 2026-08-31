import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { UserError } from "@cloudflare/workers-utils";
import { execa } from "execa";
import { fetch } from "undici";
import {
	buildPortableWorker,
	deployPortableWorker,
	uploadPortableWorker,
} from "../worker/client";

export type NotebookCell = { id: string; index: number; source: string };
export type NotebookPlan = {
	name: string;
	cells: NotebookCell[];
	wrangler: Record<string, unknown>;
};
type CellDeployment = {
	id: string;
	index: number;
	worker: string;
	endpoint: string;
	digest: string;
};
type NotebookDeployment = {
	notebook: string;
	tenant: string;
	processGroup: string;
	cells: CellDeployment[];
};
type CellSnapshot = {
	cellId: string;
	index: number;
	runId: string;
	state: Record<string, unknown>;
	output?: unknown;
};
type NotebookRunState = { snapshots: CellSnapshot[] };

function record(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new UserError(`${label} must be an object`, {
			telemetryMessage: "notebook document invalid object",
		});
	}
	return value as Record<string, unknown>;
}

function sourceText(value: unknown, label: string): string {
	if (typeof value === "string") {
		return value;
	}
	if (Array.isArray(value) && value.every((line) => typeof line === "string")) {
		return value.join("");
	}
	throw new UserError(`${label}.source must be a string or string array`, {
		telemetryMessage: "notebook cell source invalid",
	});
}

/** Parse an nbformat-4 document into an ordered Worker-per-cell plan. */
export function parseNotebook(
	document: unknown,
	fallbackName: string
): NotebookPlan {
	const notebook = record(document, "notebook");
	if (notebook.nbformat !== 4 || !Array.isArray(notebook.cells)) {
		throw new UserError(
			"Verglas notebooks require nbformat 4 and a cells array",
			{
				telemetryMessage: "notebook format unsupported",
			}
		);
	}
	const cells: NotebookCell[] = [];
	for (const [documentIndex, raw] of notebook.cells.entries()) {
		const cell = record(raw, `notebook.cells[${documentIndex}]`);
		if (cell.cell_type !== "code") {
			continue;
		}
		const id =
			typeof cell.id === "string" && cell.id !== ""
				? cell.id
				: `code-${documentIndex}`;
		if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
			throw new UserError(`Notebook cell id ${JSON.stringify(id)} is invalid`, {
				telemetryMessage: "notebook cell id invalid",
			});
		}
		if (cells.some((existing) => existing.id === id)) {
			throw new UserError(`Duplicate notebook cell id ${JSON.stringify(id)}`, {
				telemetryMessage: "notebook cell id duplicate",
			});
		}
		cells.push({
			id,
			index: cells.length,
			source: sourceText(cell.source, `notebook.cells[${documentIndex}]`),
		});
	}
	const metadata = record(notebook.metadata ?? {}, "notebook.metadata");
	const verglas = record(metadata.verglas ?? {}, "notebook.metadata.verglas");
	const wrangler = record(
		verglas.wrangler ?? {},
		"notebook.metadata.verglas.wrangler"
	);
	const name =
		typeof metadata.verglas_name === "string" && metadata.verglas_name !== ""
			? metadata.verglas_name
			: fallbackName;
	if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
		throw new UserError(`Notebook name ${JSON.stringify(name)} is invalid`, {
			telemetryMessage: "notebook name invalid",
		});
	}
	return { name, cells, wrangler };
}

const DO_MAGIC =
	/^\s*%do\s+([a-z_][a-z0-9_]*)\s+(\S+)\s+(GET|POST|PUT|PATCH|DELETE)\s+(\S+)(?:\s+using\s+([a-z_][a-z0-9_]*))?\s+as\s+([a-z_][a-z0-9_]*)\s*$/i;
const STREAM_MAGIC = /^\s*%stream\s+([A-Za-z_][A-Za-z0-9_]*)\s+(.+?)\s*$/;

/** Lower the public Verglas notebook magics to top-level-await Python. */
export function compileNotebookMagics(source: string): string {
	return source
		.split(/(?<=\n)/)
		.map((line, index) => {
			const newline = line.endsWith("\n") ? "\n" : "";
			const body = newline === "" ? line : line.slice(0, -1);
			const doMatch = body.match(DO_MAGIC);
			if (doMatch) {
				return `${doMatch[6]} = await __verglas_do(${JSON.stringify(doMatch[1])}, ${JSON.stringify(doMatch[2])}, ${JSON.stringify(doMatch[3]?.toUpperCase())}, ${JSON.stringify(doMatch[4])}, ${doMatch[5] ?? "None"})${newline}`;
			}
			const streamMatch = body.match(STREAM_MAGIC);
			if (streamMatch) {
				return `await __verglas_stream(${JSON.stringify(streamMatch[1])}, ${streamMatch[2]})${newline}`;
			}
			if (body.trimStart().startsWith("%")) {
				throw new UserError(
					`Unsupported Verglas magic on line ${index + 1}: ${body.trim()}`,
					{ telemetryMessage: "notebook magic unsupported" }
				);
			}
			return line;
		})
		.join("");
}

/** Render one notebook cell as an independently deployable Python Worker. */
export function renderNotebookCell(cell: NotebookCell): string {
	const source = compileNotebookMagics(cell.source);
	return `# Generated from notebook cell ${cell.id}.\nimport ast\nimport inspect\nimport json\nfrom workers import Request, Response, WorkerEntrypoint\n\nCELL_ID = ${JSON.stringify(cell.id)}\nCELL_INDEX = ${cell.index}\nCELL_SOURCE = ${JSON.stringify(source)}\n\ndef __verglas_json(value, path):\n    if value is None or isinstance(value, (bool, int, str)):\n        return value\n    if isinstance(value, float):\n        if value != value or value in (float("inf"), float("-inf")):\n            raise TypeError(f"{path} is not a finite JSON number")\n        return value\n    if isinstance(value, (list, tuple)):\n        return [__verglas_json(item, f"{path}[]") for item in value]\n    if isinstance(value, dict) and all(isinstance(key, str) for key in value):\n        return {key: __verglas_json(item, f"{path}.{key}") for key, item in value.items()}\n    raise TypeError(f"{path} cannot cross a cell boundary; write bulk data to a Stream")\n\nclass Default(WorkerEntrypoint):\n    async def fetch(self, request):\n        payload = await request.json()\n        state = payload.get("state", {})\n        run_id = payload.get("run_id")\n        if not isinstance(state, dict) or not isinstance(run_id, str) or not run_id:\n            return Response.json({"error": "state object and non-empty run_id are required"}, status=400)\n        namespace = dict(state)\n        namespace["env"] = self.env\n        async def __verglas_do(binding, object_name, method, route, body=None):\n            target = getattr(self.env, binding)\n            encoded = b"" if body is None else json.dumps(body, separators=(",", ":")).encode("utf-8")\n            headers = {} if body is None else {"content-type": "application/json"}\n            request = Request("https://verglas.internal" + route, method=method, body=encoded, headers=headers)\n            if hasattr(target, "id_from_name"):\n                response = await target.get(target.id_from_name(object_name)).fetch(request)\n            else:\n                response = await target.fetch(request)\n            if response.status < 200 or response.status >= 300:\n                raise RuntimeError(f"{binding}/{object_name} returned HTTP {response.status}")\n            return await response.json()\n        async def __verglas_stream(binding, records):\n            event_ids = [f"notebook:{CELL_ID}:{run_id}:{record_index}" for record_index in range(len(records))]\n            await getattr(self.env, binding).send(records, event_ids=event_ids)\n        namespace["__verglas_do"] = __verglas_do\n        namespace["__verglas_stream"] = __verglas_stream\n        tree = ast.parse(CELL_SOURCE, filename=f"<cell:{CELL_ID}>", mode="exec")\n        if tree.body and isinstance(tree.body[-1], ast.Expr):\n            tree.body[-1] = ast.Assign(targets=[ast.Name(id="result", ctx=ast.Store())], value=tree.body[-1].value)\n            ast.fix_missing_locations(tree)\n        pending = eval(compile(tree, f"<cell:{CELL_ID}>", "exec", flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT), namespace, namespace)\n        if inspect.isawaitable(pending):\n            await pending\n        next_state = {}\n        for name, value in namespace.items():\n            if not name.startswith("__") and name != "env":\n                next_state[name] = __verglas_json(value, name)\n        return Response.json({"cell_id": CELL_ID, "cell_index": CELL_INDEX, "run_id": run_id, "state": next_state, "output": next_state.get("result")})\n`;
}

function workerName(notebook: string, cell: NotebookCell): string {
	return `${notebook}-cell-${cell.index}-${cell.id}`
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.slice(0, 96)
		.replace(/-+$/g, "");
}

function deploymentRoot(notebookPath: string, name: string): string {
	return path.join(path.dirname(notebookPath), ".verglas", "notebooks", name);
}

/** Materialize, componentize, upload, and deploy every cell in one process group. */
export async function deployNotebook(options: {
	notebookPath: string;
	tenant: string;
	pythonBuilder: string;
}): Promise<{
	plan: NotebookPlan;
	deployment: NotebookDeployment;
	root: string;
}> {
	const notebookPath = path.resolve(options.notebookPath);
	const plan = parseNotebook(
		JSON.parse(await readFile(notebookPath, "utf8")) as unknown,
		path.basename(notebookPath, path.extname(notebookPath))
	);
	const root = deploymentRoot(notebookPath, plan.name);
	const processGroup = `notebook-${plan.name}`;
	const deployments: CellDeployment[] = [];
	for (const cell of plan.cells) {
		const projectDir = path.join(
			root,
			`${String(cell.index).padStart(3, "0")}-${cell.id}`
		);
		const outputDir = path.join(projectDir, "build");
		await mkdir(projectDir, { recursive: true });
		await writeFile(path.join(projectDir, "cell.py"), renderNotebookCell(cell));
		await writeFile(
			path.join(projectDir, "wrangler.jsonc"),
			`${JSON.stringify({ ...plan.wrangler, name: workerName(plan.name, cell), main: "cell.py" }, null, 2)}\n`
		);
		await execa(options.pythonBuilder, [projectDir, "--out", outputDir], {
			stdio: "inherit",
		});
		const manifest = JSON.parse(
			await readFile(path.join(outputDir, "manifest.out.json"), "utf8")
		) as Record<string, unknown>;
		const artifacts = record(manifest.artifacts, "build manifest artifacts");
		const worker = record(artifacts.worker, "build manifest worker artifact");
		const digest = worker.digest;
		if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) {
			throw new UserError("Python builder returned no valid Worker digest", {
				telemetryMessage: "notebook worker digest missing",
			});
		}
		const name = workerName(plan.name, cell);
		const uploadedDigest = await uploadPortableWorker({
			tenant: options.tenant,
			name,
			componentPath: path.join(outputDir, `${digest}.wasm`),
			manifest,
		});
		await buildPortableWorker({
			tenant: options.tenant,
			name,
			digest: uploadedDigest,
		});
		const deployed = await deployPortableWorker({
			tenant: options.tenant,
			name,
			digest: uploadedDigest,
			processGroup,
		});
		const endpoint = deployed.endpoint?.url;
		if (typeof endpoint !== "string") {
			throw new UserError(`Cell ${cell.id} deployment returned no endpoint`, {
				telemetryMessage: "notebook cell endpoint missing",
			});
		}
		deployments.push({
			id: cell.id,
			index: cell.index,
			worker: name,
			endpoint,
			digest: uploadedDigest,
		});
	}
	const deployment = {
		notebook: notebookPath,
		tenant: options.tenant,
		processGroup,
		cells: deployments,
	};
	await writeFile(
		path.join(root, "deployment.json"),
		`${JSON.stringify(deployment, null, 2)}\n`
	);
	return { plan, deployment, root };
}

async function readRunState(root: string): Promise<NotebookRunState> {
	try {
		return JSON.parse(
			await readFile(path.join(root, "run-state.json"), "utf8")
		) as NotebookRunState;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { snapshots: [] };
		}
		throw error;
	}
}

/** Trigger one cell or the remaining ordered notebook cells and persist prefix state. */
export async function runNotebook(options: {
	notebookPath: string;
	cell?: string;
	runId?: string;
}): Promise<CellSnapshot[]> {
	const notebookPath = path.resolve(options.notebookPath);
	const plan = parseNotebook(
		JSON.parse(await readFile(notebookPath, "utf8")) as unknown,
		path.basename(notebookPath, path.extname(notebookPath))
	);
	const root = deploymentRoot(notebookPath, plan.name);
	const deployment = JSON.parse(
		await readFile(path.join(root, "deployment.json"), "utf8")
	) as NotebookDeployment;
	const state = await readRunState(root);
	const selected =
		options.cell === undefined
			? plan.cells.slice(state.snapshots.length)
			: plan.cells.filter(
					(cell) =>
						cell.id === options.cell || String(cell.index) === options.cell
				);
	if (selected.length === 0 && options.cell !== undefined) {
		throw new UserError(
			`Unknown notebook cell ${JSON.stringify(options.cell)}`,
			{
				telemetryMessage: "notebook cell unknown",
			}
		);
	}
	if (selected.length > 1 && options.runId !== undefined) {
		throw new UserError("--run-id requires selecting exactly one cell", {
			telemetryMessage: "notebook run id ambiguous",
		});
	}
	const completed: CellSnapshot[] = [];
	for (const cell of selected) {
		if (cell.index > 0 && state.snapshots[cell.index - 1] === undefined) {
			throw new UserError(
				`Cell ${cell.id} cannot run before cell ${cell.index - 1}`,
				{
					telemetryMessage: "notebook cell prefix incomplete",
				}
			);
		}
		const runId = options.runId ?? randomUUID();
		const existing = state.snapshots[cell.index];
		if (existing?.runId === runId) {
			completed.push(existing);
			continue;
		}
		const target = deployment.cells.find((item) => item.id === cell.id);
		if (!target) {
			throw new UserError(`Cell ${cell.id} is absent from deployment state`, {
				telemetryMessage: "notebook deployment cell missing",
			});
		}
		const input =
			cell.index === 0 ? {} : state.snapshots[cell.index - 1]?.state;
		const response = await fetch(target.endpoint, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ state: input, run_id: runId }),
		});
		const value = (await response.json()) as Record<string, unknown>;
		if (!response.ok) {
			throw new UserError(
				`Cell ${cell.id} returned HTTP ${response.status}: ${JSON.stringify(value)}`,
				{
					telemetryMessage: "notebook cell trigger failed",
				}
			);
		}
		const nextState = record(value.state, "notebook cell response state");
		const snapshot: CellSnapshot = {
			cellId: cell.id,
			index: cell.index,
			runId,
			state: nextState,
			...(value.output === undefined ? {} : { output: value.output }),
		};
		state.snapshots.splice(cell.index, state.snapshots.length, snapshot);
		await writeFile(
			path.join(root, "run-state.json"),
			`${JSON.stringify(state, null, 2)}\n`
		);
		completed.push(snapshot);
	}
	return completed;
}
