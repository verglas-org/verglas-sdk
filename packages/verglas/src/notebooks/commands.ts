import path from "node:path";
import { createCommand } from "../core/create-command";
import { deployNotebook, runNotebook } from "./runtime";

export const notebooksDeployCommand = createCommand({
	metadata: {
		description: "Deploy every code cell in an .ipynb as a Python Worker",
		status: "experimental",
		owner: "Workers: Authoring and Testing",
		examples: [
			{
				command:
					"verglas notebooks deploy iris-streaming.ipynb --tenant my-team",
				description: "Deploy an Iris notebook into one shared runtime group",
			},
		],
	},
	args: {
		NOTEBOOK: {
			type: "string",
			demandOption: true,
			describe: "Path to an nbformat-4 .ipynb file",
		},
		tenant: {
			type: "string",
			alias: "t",
			demandOption: true,
			describe: "Tenant deployment id",
		},
		"python-builder": {
			type: "string",
			default: "verglas-worker-py-build",
			describe: "Python Worker component builder executable",
		},
	},
	positionalArgs: ["NOTEBOOK"],
	async handler(args, { logger }) {
		const result = await deployNotebook({
			notebookPath: path.resolve(args.NOTEBOOK),
			tenant: args.tenant,
			pythonBuilder: args.pythonBuilder,
		});
		logger.log(
			`Deployed notebook ${result.plan.name}: ${result.deployment.cells.length} cell Workers in ${result.deployment.processGroup}.`
		);
		for (const cell of result.deployment.cells) {
			logger.log(`  ${cell.index}: ${cell.id} -> ${cell.endpoint}`);
		}
		logger.log(
			`Deployment state: ${path.join(result.root, "deployment.json")}`
		);
	},
});

export const notebooksRunCommand = createCommand({
	metadata: {
		description: "Trigger deployed notebook cells in notebook order",
		status: "experimental",
		owner: "Workers: Authoring and Testing",
		examples: [
			{
				command: "verglas notebooks run iris-streaming.ipynb",
				description: "Run every pending Iris notebook cell",
			},
			{
				command: "verglas notebooks run iris-streaming.ipynb --cell fit-knn",
				description: "Rerun one deployed cell and invalidate its suffix",
			},
		],
	},
	args: {
		NOTEBOOK: {
			type: "string",
			demandOption: true,
			describe: "Path to the deployed nbformat-4 .ipynb file",
		},
		cell: {
			type: "string",
			alias: "c",
			describe:
				"Cell id or zero-based code-cell index; omit to run the pending suffix",
		},
		"run-id": {
			type: "string",
			describe: "Stable retry identity when triggering exactly one cell",
		},
	},
	positionalArgs: ["NOTEBOOK"],
	async handler(args, { logger }) {
		const snapshots = await runNotebook({
			notebookPath: path.resolve(args.NOTEBOOK),
			...(args.cell === undefined ? {} : { cell: args.cell }),
			...(args.runId === undefined ? {} : { runId: args.runId }),
		});
		if (snapshots.length === 0) {
			logger.log("Notebook is already complete.");
			return;
		}
		for (const snapshot of snapshots) {
			logger.log(
				JSON.stringify({
					cell: snapshot.cellId,
					index: snapshot.index,
					run_id: snapshot.runId,
					output: snapshot.output,
				})
			);
		}
	},
});
