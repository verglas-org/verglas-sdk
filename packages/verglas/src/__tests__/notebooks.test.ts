import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runInTempDir } from "@cloudflare/workers-utils/test-helpers";
import { http, HttpResponse } from "msw";
import { describe, it } from "vitest";
import {
	compileNotebookMagics,
	parseNotebook,
	renderNotebookCell,
	runNotebook,
} from "../notebooks/runtime";
import { mockConsoleMethods } from "./helpers/mock-console";
import { msw } from "./helpers/msw";
import { runWrangler } from "./helpers/run-wrangler";

describe("notebooks", () => {
	const std = mockConsoleMethods();
	runInTempDir();

	it("registers deploy and run commands", async ({ expect }) => {
		await runWrangler("notebooks --help");
		expect(std.out).toContain("notebooks deploy");
		expect(std.out).toContain("notebooks run");
		await runWrangler("notebooks deploy --help");
		expect(std.out).toContain("--tenant");
		await runWrangler("notebooks run --help");
		expect(std.out).toContain("--cell");
	});

	it("keeps code cells separate and lowers idempotent data-plane magics", ({
		expect,
	}) => {
		const plan = parseNotebook(
			{
				nbformat: 4,
				metadata: { verglas_name: "iris", verglas: { wrangler: {} } },
				cells: [
					{ cell_type: "markdown", id: "intro", source: ["Iris"] },
					{ cell_type: "code", id: "load", source: ["%stream RAW rows\n"] },
					{ cell_type: "code", id: "fit", source: ["result = len(rows)\n"] },
				],
			},
			"fallback"
		);
		expect(plan.cells.map((cell) => cell.id)).toEqual(["load", "fit"]);
		const worker = renderNotebookCell(plan.cells[0]);
		expect(worker).toContain("send(records, event_ids=event_ids)");
		expect(worker).toContain('f"notebook:{CELL_ID}:{run_id}:{record_index}"');
		expect(worker).not.toContain(plan.cells[1].source);
		expect(worker).not.toContain("sink_status");
		expect(() =>
			compileNotebookMagics("%sink_status OUTPUT iris as status\n")
		).toThrow("Unsupported Verglas magic");
	});

	it("triggers cells in prefix order and reruns a cell idempotently", async ({
		expect,
	}) => {
		const notebookPath = path.resolve("iris.ipynb");
		await writeFile(
			notebookPath,
			JSON.stringify({
				nbformat: 4,
				metadata: { verglas_name: "iris" },
				cells: [
					{ cell_type: "code", id: "load", source: ["rows = [1]\n"] },
					{ cell_type: "code", id: "fit", source: ["len(rows)\n"] },
				],
			})
		);
		const root = path.resolve(".verglas/notebooks/iris");
		await mkdir(root, { recursive: true });
		await writeFile(
			path.join(root, "deployment.json"),
			JSON.stringify({
				notebook: notebookPath,
				tenant: "test",
				processGroup: "notebook-iris",
				cells: [
					{
						id: "load",
						index: 0,
						worker: "load",
						endpoint: "https://load.example",
						digest: "a".repeat(64),
					},
					{
						id: "fit",
						index: 1,
						worker: "fit",
						endpoint: "https://fit.example",
						digest: "b".repeat(64),
					},
				],
			})
		);
		const requests: Array<{ cell: string; body: Record<string, unknown> }> = [];
		for (const cell of ["load", "fit"]) {
			msw.use(
				http.post(`https://${cell}.example/`, async ({ request }) => {
					const body = (await request.json()) as Record<string, unknown>;
					requests.push({ cell, body });
					return HttpResponse.json({
						state: { ...(body.state as object), [cell]: true },
						output: cell,
					});
				})
			);
		}

		const first = await runNotebook({ notebookPath });
		expect(first.map((snapshot) => snapshot.cellId)).toEqual(["load", "fit"]);
		expect(requests[1].body.state).toEqual({ load: true });

		const rerun = await runNotebook({
			notebookPath,
			cell: "load",
			runId: "retry-1",
		});
		expect(rerun[0].runId).toBe("retry-1");
		await runNotebook({ notebookPath, cell: "load", runId: "retry-1" });
		expect(requests).toHaveLength(3);
		const persisted = JSON.parse(
			await readFile(path.join(root, "run-state.json"), "utf8")
		) as { snapshots: unknown[] };
		expect(persisted.snapshots).toHaveLength(1);
	});
});
